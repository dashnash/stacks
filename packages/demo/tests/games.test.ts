import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppManifest } from '@stacks/manifest';
import type { AppDeps, AppRoutes } from '@stacks/api';
import { defineGame, type GameRoom } from '@stacks/game-server';
import { GameRoomClient, hubSignaling, RealtimeHub, type GameRoomSnapshot, type PeerLike } from '@stacks/web';
import { createDemo, type Demo } from '../src/index';

const manifest: AppManifest = {
  slug: 'dotsdemo',
  name: 'Dots',
  tagline: 't',
  description: 'd',
  visibility: 'private',
  roles: [
    { id: 'OWNER', label: 'Owner', canManageAccess: true },
    { id: 'PLAYER', label: 'Player' },
  ],
  topRole: 'OWNER',
  defaultRole: 'PLAYER',
  modules: ['realtime', 'gameServer'],
  gameServer: { maxPlayers: 2 },
  owners: ['o@x.dev'],
};

interface Dots {
  room: GameRoom<unknown>;
  dots: Record<string, { name: string; x: number }>;
}
/** A tiny server-run game: everyone has a dot at the x they last sent. */
const game = defineGame<Dots>({
  tickHz: 20,
  init: (room) => ({ room, dots: {} }),
  onJoin: (s, p) => void (s.dots[p.id] = { name: p.name, x: 0 }),
  onLeave: (s, p) => void delete s.dots[p.id],
  onInput: (s, p, input) => {
    const x = (input as { x?: unknown } | null)?.x;
    if (typeof x === 'number' && x >= 0 && x <= 1) s.dots[p.id]!.x = x;
  },
  onEvent: (s, p, event) => {
    if (event === 'bump') s.room.broadcast({ shake: p.name });
    if (event === 'finish') s.room.end({ winner: p.name });
  },
  snapshot: (s, me) => ({ me: me.id, dots: Object.entries(s.dots).map(([id, d]) => ({ id, ...d })) }),
});

const routes = (_api: AppRoutes<AppDeps>) => undefined;
const personas = [
  { email: 'olive@demo', name: 'Olive', role: 'OWNER' },
  { email: 'pat@demo', name: 'Pat', role: 'PLAYER' },
  { email: 'quin@demo', name: 'Quin', role: 'PLAYER' },
];

const demos: Demo[] = [];
const clients: GameRoomClient[] = [];

/** A demo tab signed in as one persona. */
async function tab(email: string, withGame = true) {
  const demo = createDemo({ manifest, routes, personas, storageKey: 'stacks-demo:dotsdemo:test', gameStartDelayMs: 30, ...(withGame ? { game } : {}) });
  demos.push(demo);
  await demo.signInAs(email);
  return demo;
}

/** What `useGameRoom` does, without React. */
function play(demo: Demo, roomId: string) {
  const seen = { states: [] as { me: string; dots: { id: string; name: string; x: number }[] }[], events: [] as unknown[], snapshot: null as GameRoomSnapshot | null, statuses: [] as string[] };
  const client = new GameRoomClient({
    roomId,
    api: demo.client,
    signaling: hubSignaling(new RealtimeHub(demo.client), demo.current()!.email),
    createPeer: (config) => demo.client.openPeer(config) as PeerLike,
    onState: (s) => seen.states.push(s as (typeof seen.states)[number]),
    onEvent: (e) => seen.events.push(e),
    onChange: (s) => {
      seen.snapshot = s;
      if (seen.statuses.at(-1) !== s.status) seen.statuses.push(s.status);
    },
  });
  clients.push(client);
  client.start();
  return { client, seen, dots: () => Object.fromEntries((seen.states.at(-1)?.dots ?? []).map((d) => [d.name, d.x])) };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
  for (const d of demos.splice(0)) d.close();
});

describe('demo game rooms', () => {
  it("two personas in one room see each other's state, events and departures", async () => {
    const olive = await tab('olive@demo');
    const pat = await tab('pat@demo');

    // Olive's tab creates the room and becomes its server.
    const { room } = await olive.client.post<{ room: { id: string; code: string; status: string } }>('/rooms', {});
    expect(room.status).toBe('starting');
    // Pat's tab finds it by the code Olive reads out.
    const found = await pat.client.get<{ room: { id: string } }>(`/rooms/by-code/${room.code}`);
    expect(found.room.id).toBe(room.id);

    const atOlive = play(olive, room.id);
    const atPat = play(pat, room.id);
    await vi.waitFor(() => expect([atOlive.seen.snapshot?.status, atPat.seen.snapshot?.status]).toEqual(['live', 'live']), { timeout: 5000 });
    // The lobby showed "starting" first (the server takes a moment, as the real one takes a minute).
    expect(atPat.seen.statuses.at(-1)).toBe('live');
    expect(atPat.seen.snapshot!.you).toMatchObject({ name: 'Pat' });
    await vi.waitFor(() => expect(atOlive.seen.snapshot!.players.map((p) => p.name).sort()).toEqual(['Olive', 'Pat']));

    // Each sends input; the server's state reaches both.
    atOlive.client.sendInput({ x: 0.25 });
    atPat.client.sendInput({ x: 0.75 });
    await vi.waitFor(() => {
      expect(atOlive.dots()).toEqual({ Olive: 0.25, Pat: 0.75 });
      expect(atPat.dots()).toEqual({ Olive: 0.25, Pat: 0.75 });
    });
    // Snapshots are per player.
    expect(atPat.seen.states.at(-1)!.me).toBe(atPat.seen.snapshot!.you!.id);
    // The server is the authority: input it does not like changes nothing.
    atPat.client.sendInput({ x: 7 });
    await new Promise((r) => setTimeout(r, 120));
    expect(atOlive.dots().Pat).toBe(0.75);

    // A reliable event from one reaches everyone.
    expect(atPat.client.sendEvent('bump')).toBe(true);
    await vi.waitFor(() => expect([atOlive.seen.events, atPat.seen.events]).toEqual([[{ shake: 'Pat' }], [{ shake: 'Pat' }]]));

    // RTT is measured.
    await vi.waitFor(() => expect(atPat.seen.snapshot!.rttMs).not.toBeNull());

    // The room list shows both players, in either tab.
    const list = await pat.client.get<{ rooms: { id: string; status: string; players: number }[] }>('/rooms');
    expect(list.rooms).toEqual([expect.objectContaining({ id: room.id, status: 'open', players: 2 })]);

    // The room is full at 2 (the manifest's limit here).
    const quin = await tab('quin@demo');
    const atQuin = play(quin, room.id);
    await vi.waitFor(() => expect(atQuin.seen.snapshot).toMatchObject({ status: 'offline', error: 'full' }));

    // Pat leaves: Olive's roster and state follow.
    await atPat.client.leave();
    await vi.waitFor(() => expect(atOlive.seen.snapshot!.players.map((p) => p.name)).toEqual(['Olive']));
    await vi.waitFor(() => expect(atOlive.dots()).toEqual({ Olive: 0.25 }));
  }, 20_000);

  it('ends for everyone when the game ends, with results on the room', async () => {
    const olive = await tab('olive@demo');
    const pat = await tab('pat@demo');
    const { room } = await olive.client.post<{ room: { id: string } }>('/rooms', {});
    const atOlive = play(olive, room.id);
    const atPat = play(pat, room.id);
    await vi.waitFor(() => expect([atOlive.seen.snapshot?.status, atPat.seen.snapshot?.status]).toEqual(['live', 'live']), { timeout: 5000 });
    atPat.client.sendEvent('finish');
    await vi.waitFor(() => {
      expect(atOlive.seen.snapshot).toMatchObject({ status: 'ended', over: { reason: 'finished', results: { winner: 'Pat' } } });
      expect(atPat.seen.snapshot).toMatchObject({ status: 'ended' });
    });
    await vi.waitFor(async () => {
      const after = await pat.client.get<{ room: { status: string; results: unknown } }>(`/rooms/${room.id}`);
      expect(after.room).toMatchObject({ status: 'ended', endedReason: 'finished', results: { winner: 'Pat' } });
    });
    expect((await pat.client.get<{ rooms: unknown[] }>('/rooms')).rooms).toEqual([]);
  }, 20_000);

  it('lets the creator end a room from another tab than the one hosting it', async () => {
    const host = await tab('olive@demo');
    const { room } = await host.client.post<{ room: { id: string } }>('/rooms', {});
    const atHost = play(host, room.id);
    await vi.waitFor(() => expect(atHost.seen.snapshot?.status).toBe('live'), { timeout: 5000 });
    // Olive again, in a second tab.
    const other = await tab('olive@demo');
    await other.client.post(`/rooms/${room.id}/end`);
    await vi.waitFor(() => expect(atHost.seen.snapshot).toMatchObject({ status: 'ended' }));
  }, 20_000);

  it('closes a room whose server tab is gone', async () => {
    const olive = await tab('olive@demo');
    const pat = await tab('pat@demo');
    const { room } = await olive.client.post<{ room: { id: string } }>('/rooms', {});
    const atPat = play(pat, room.id);
    await vi.waitFor(() => expect(atPat.seen.snapshot?.status).toBe('live'), { timeout: 5000 });

    // Olive's tab closes: its server stops, and its heartbeats with it.
    olive.close();
    localStorage.removeItem(`stacks-demo-game:dotsdemo:${room.id}`);
    expect((await pat.client.get<{ rooms: unknown[] }>('/rooms')).rooms).toEqual([]);
    await vi.waitFor(() => expect(atPat.seen.snapshot).toMatchObject({ status: 'ended' }), { timeout: 8000 });
  }, 20_000);

  it('says how to turn rooms on when the demo was not given the game', async () => {
    const demo = await tab('olive@demo', false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(demo.client.post('/rooms', {})).rejects.toMatchObject({ status: 503 });
    expect(String(err.mock.calls[0]?.[2])).toMatch(/pass `game`/);
    err.mockRestore();
  });
});
