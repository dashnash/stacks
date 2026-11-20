import { describe, expect, it } from 'vitest';
import { RTCPeerConnection } from 'werift';
import { roomChannels, type ToPlayerSignal } from '@stacks/api';
import { MemoryStore, roomKeys, signGameTicket } from '@stacks/api';
import { RoomServer } from '../src/index';
import { vpcAddress, weriftPeers } from '../src/node/werift-peers';
import { FakeSignaling, game, KEY, ROOM } from './helpers';

const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('vpcAddress', () => {
  it('picks the VPC address, never loopback or the link-local agent interface', () => {
    const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal }) as never;
    expect(vpcAddress({ lo: [v4('127.0.0.1', true)], eth0: [v4('169.254.172.2')], eth1: [{ address: 'fe80::1', family: 'IPv6', internal: false } as never, v4('10.0.1.23')] })).toBe('10.0.1.23');
    expect(vpcAddress({ lo: [v4('127.0.0.1', true)] })).toBeUndefined();
  });
});

describe('a real WebRTC peer against the room server', () => {
  it('connects on a port from the fixed range, with an unreliable state channel and a reliable events channel', async () => {
    const store = new MemoryStore();
    await store.put({ ...roomKeys.meta(ROOM), id: ROOM, status: 'starting', maxPlayers: 8 });
    const signaling = new FakeSignaling();
    const server = new RoomServer({
      roomId: ROOM,
      game,
      store,
      signaling,
      // No STUN in tests: host candidates on this machine are enough.
      peers: weriftPeers({ portRange: [40000, 40019], stunUrls: [] }),
      key: async () => KEY,
      maxPlayers: 8,
      idleMs: 600_000,
      maxMs: 7_200_000,
      lingerMs: 50,
    });
    expect(await server.start()).toBe(true);

    // The browser's side, as @stacks/web does it.
    const client = new RTCPeerConnection({ iceServers: [], iceUseDefaultStunServer: false });
    const state = client.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
    const events = client.createDataChannel('events');
    const snapshots: { n: number; s: { seen: string[] } }[] = [];
    const reliable: Record<string, unknown>[] = [];
    state.onMessage.subscribe((m) => snapshots.push(JSON.parse(String(m))));
    events.onMessage.subscribe((m) => reliable.push(JSON.parse(String(m))));
    const toServer = roomChannels.toServer(ROOM);
    client.onIceCandidate.subscribe((c) => c && signaling.fromClient(toServer, { t: 'ice', sid: 's1', c: c.toJSON() }));
    await client.setLocalDescription(await client.createOffer());
    const ticket = await signGameTicket(KEY, { roomId: ROOM, userId: 'u_ann', name: 'Ann', exp: Math.floor(Date.now() / 1000) + 60 });
    signaling.fromClient(toServer, { t: 'offer', sid: 's1', ticket, sdp: client.localDescription!.sdp });

    const answers = () => signaling.on(roomChannels.toPlayer(ROOM, 'u_ann')) as ToPlayerSignal[];
    await until(() => answers().length > 0);
    const answer = answers()[0]!;
    expect(answer.t).toBe('answer');
    const sdp = (answer as { sdp: string }).sdp;
    // Every candidate is in the answer, on a port the security group opens, and it fits one event.
    const ports = [...sdp.matchAll(/a=candidate:\S+ \d+ udp \d+ \S+ (\d+) typ host/g)].map((m) => Number(m[1]));
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(port >= 40000 && port <= 40019).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(answer)).length).toBeLessThan(3500);
    await client.setRemoteDescription({ type: 'answer', sdp });

    await until(() => reliable.some((m) => 'welcome' in m));
    expect(reliable[0]).toMatchObject({ welcome: { you: { id: 'u_ann', name: 'Ann' }, tickHz: 20, rejoined: false } });
    state.send(JSON.stringify({ i: { x: 0.5 } }));
    await until(() => snapshots.some((s) => s.s.seen.includes('input Ann {"x":0.5}')));
    expect(snapshots.at(-1)!.n).toBeGreaterThan(0);

    // RTT: a ping comes straight back on the reliable channel.
    events.send(JSON.stringify({ ping: 42 }));
    await until(() => reliable.some((m) => m.pong === 42));

    // The game ends itself: "game over" arrives before the server hangs up.
    events.send(JSON.stringify({ event: 'finish' }));
    expect(await server.done).toEqual({ reason: 'finished', results: { winner: 'u_ann' } });
    await until(() => reliable.some((m) => 'over' in m));
    expect(reliable.at(-1)).toEqual({ over: { reason: 'finished', results: { winner: 'u_ann' } } });
    await client.close();
  }, 30_000);

  it('connects two devices of one user as two seats, each picking its own answer off the shared channel', async () => {
    const store = new MemoryStore();
    await store.put({ ...roomKeys.meta(ROOM), id: ROOM, status: 'starting', maxPlayers: 8 });
    const signaling = new FakeSignaling();
    const server = new RoomServer({
      roomId: ROOM,
      game,
      store,
      signaling,
      peers: weriftPeers({ portRange: [40020, 40039], stunUrls: [] }),
      key: async () => KEY,
      maxPlayers: 8,
      idleMs: 600_000,
      maxMs: 7_200_000,
      lingerMs: 50,
    });
    expect(await server.start()).toBe(true);
    const toServer = roomChannels.toServer(ROOM);
    const answers = () => signaling.on(roomChannels.toPlayer(ROOM, 'u_ann')) as ToPlayerSignal[];

    /** One browser: offers with its own sid and device, and takes only the answer for its sid. */
    const device = async (sid: string, name: string) => {
      const client = new RTCPeerConnection({ iceServers: [], iceUseDefaultStunServer: false });
      const state = client.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
      const events = client.createDataChannel('events');
      const snapshots: { s: { seen: string[] } }[] = [];
      const reliable: Record<string, unknown>[] = [];
      state.onMessage.subscribe((m) => snapshots.push(JSON.parse(String(m))));
      events.onMessage.subscribe((m) => reliable.push(JSON.parse(String(m))));
      await client.setLocalDescription(await client.createOffer());
      const ticket = await signGameTicket(KEY, { roomId: ROOM, userId: 'u_ann', device: name, name: 'Ann', exp: Math.floor(Date.now() / 1000) + 60 });
      signaling.fromClient(toServer, { t: 'offer', sid, ticket, sdp: client.localDescription!.sdp });
      return { client, state, snapshots, reliable, sid };
    };
    const screen = await device('screen-sid', 'screen');
    const gun = await device('gun-sid', 'gun');
    await until(() => answers().filter((a) => a.t === 'answer').length === 2);
    for (const d of [screen, gun]) {
      const mine = answers().find((a) => a.t === 'answer' && a.sid === d.sid) as { sdp: string };
      await d.client.setRemoteDescription({ type: 'answer', sdp: mine.sdp });
    }
    await until(() => [screen, gun].every((d) => d.reliable.some((m) => 'welcome' in m)));
    expect(screen.reliable[0]).toMatchObject({ welcome: { you: { id: 'u_ann~screen', device: 'screen' } } });
    expect(gun.reliable[0]).toMatchObject({ welcome: { you: { id: 'u_ann~gun', device: 'gun' } } });

    // Both stay live: input from the gun reaches the game, and the screen sees it in its snapshots.
    gun.state.send(JSON.stringify({ i: 'bang' }));
    await until(() => screen.snapshots.some((s) => s.s.seen.includes('input Ann "bang"')));
    expect(server.host!.connected).toBe(2);
    server.stop();
    await server.done;
    await Promise.all([screen.client.close(), gun.client.close()]);
  }, 30_000);
});
