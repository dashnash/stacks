import { describe, expect, it, vi } from 'vitest';
import { captureLogs, createTestHarness } from '@stacks/testing';
import type { AppManifest } from '@stacks/manifest';
import {
  createStacksApp,
  gamesOff,
  MemoryStore,
  newRoomCode,
  playerChannelId,
  MAX_SEATS_PER_USER,
  readGameTicket,
  ROOM_CODE_ALPHABET,
  roomKeys,
  seatId,
  signGameTicket,
  signHmacToken,
  STUN_ONLY,
  verifyGameTicket,
  verifyRealtimeToken,
  type AppDeps,
  type AppRoutes,
} from '../src/index';
import { awsGames, usableIceServers } from '../src/games-aws';
import { manifest as base, routes as baseRoutes } from './fixtures';

const manifest: AppManifest = { ...base, modules: ['realtime', 'gameServer'] };
const harness = (m: AppManifest = manifest) => createTestHarness({ manifest: m, routes: baseRoutes });
type Harness = ReturnType<typeof harness>;

const ann = 'ann@test.dev';
const bob = 'bob@test.dev';

/** Create a room as Ann and play the server coming up. */
async function openRoom(t: Harness, as = ann) {
  const res = await t.call('POST', '/rooms', { as, role: 'EDITOR', body: {} });
  expect(res.status).toBe(201);
  await t.games.open(res.body.room.id);
  return res.body.room as { id: string; code: string };
}

describe('rooms', () => {
  it('creates a room with a 4-character code from the safe alphabet and starts one server', async () => {
    const t = harness();
    const res = await t.call('POST', '/rooms', { as: ann, role: 'EDITOR', body: { name: 'Friday dots' } });
    expect(res.status).toBe(201);
    const room = res.body.room;
    expect(room).toMatchObject({ name: 'Friday dots', status: 'starting', players: 0, maxPlayers: 8, createdBy: { id: 'u_ann_test_dev', name: 'ann' } });
    expect(room.code).toHaveLength(4);
    for (const ch of room.code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    expect(t.games.started).toEqual([room.id]);
    // Logged like any other change.
    expect(t.platform.audit.at(-1)).toMatchObject({ action: 'room.create' });
  });

  it('never puts look-alike characters in a code', () => {
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[ILO01]/);
    for (let i = 0; i < 500; i++) expect(newRoomCode()).toMatch(/^[A-HJKMNP-Z2-9]{4}$/);
  });

  it('names a room after its creator by default', async () => {
    const t = harness();
    const res = await t.call('POST', '/rooms', { as: { email: ann, name: 'Ann' }, body: {} });
    expect(res.body.room.name).toBe("Ann's game");
  });

  it('lists open and starting rooms with player counts, finds them by code and by id', async () => {
    const t = harness();
    const a = await openRoom(t);
    const b = (await t.call('POST', '/rooms', { as: bob, body: {} })).body.room;
    await t.call('POST', `/rooms/${a.id}/join`, { as: bob });
    const list = (await t.call('GET', '/rooms', { as: bob })).body.rooms;
    expect(list.map((r: { id: string; status: string; players: number }) => [r.id, r.status, r.players])).toEqual([
      [a.id, 'open', 1],
      [b.id, 'starting', 0],
    ]);
    expect((await t.call('GET', `/rooms/by-code/${a.code.toLowerCase()}`, { as: bob })).body.room.id).toBe(a.id);
    expect((await t.call('GET', `/rooms/${b.id}`, { as: bob })).body.room.status).toBe('starting');
    expect((await t.call('GET', '/rooms/by-code/ZZZZ', { as: bob })).status).toBe(404);
    expect((await t.call('GET', '/rooms/nope', { as: bob })).status).toBe(404);
  });

  it('refuses the 5th room at once with 429, and allows it again when one ends', async () => {
    const t = harness();
    const rooms = [];
    for (let i = 0; i < 4; i++) rooms.push(await openRoom(t));
    const fifth = await t.call('POST', '/rooms', { as: bob, body: {} });
    expect(fifth.status).toBe(429);
    expect(fifth.body).toMatchObject({ error: 'Too many games running, try again soon', code: 'TOO_MANY_GAMES' });
    expect(t.games.started).toHaveLength(4);
    await t.call('POST', `/rooms/${rooms[0]!.id}/end`, { as: ann, role: 'EDITOR' });
    expect((await t.call('POST', '/rooms', { as: bob, body: {} })).status).toBe(201);
  });

  it('honours the manifest limits', async () => {
    const t = harness({ ...manifest, gameServer: { maxRooms: 1, maxPlayers: 2 } });
    const room = await openRoom(t);
    expect((await t.call('POST', '/rooms', { as: bob, body: {} })).status).toBe(429);
    expect((await t.call('POST', `/rooms/${room.id}/join`, { as: ann })).status).toBe(200);
    expect((await t.call('POST', `/rooms/${room.id}/join`, { as: bob })).status).toBe(200);
    const third = await t.call('POST', `/rooms/${room.id}/join`, { as: 'cy@test.dev' });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('ROOM_FULL');
    // Someone already in may ask again (a reconnect), and a seat frees when someone leaves.
    expect((await t.call('POST', `/rooms/${room.id}/join`, { as: bob })).status).toBe(200);
    await t.call('POST', `/rooms/${room.id}/leave`, { as: bob });
    expect((await t.call('POST', `/rooms/${room.id}/join`, { as: 'cy@test.dev' })).status).toBe(200);
  });

  it('answers 503 and leaves nothing behind when the server will not start', async () => {
    const t = harness();
    t.games.failNextStart = true;
    const logs = captureLogs();
    const res = await t.call('POST', '/rooms', { as: ann, body: {} });
    logs.stop();
    expect(res.status).toBe(503);
    expect(logs.lines).toContainEqual(expect.objectContaining({ level: 'error', message: 'Game server not started' }));
    expect((await t.call('GET', '/rooms', { as: ann })).body.rooms).toEqual([]);
    expect([...t.store.items.values()].filter((i) => i.PK.startsWith('ROOMCODE#'))).toEqual([]);
  });

  it('refuses people without a role here, and requests without the CSRF header', async () => {
    const t = harness();
    const room = await openRoom(t);
    for (const [method, path] of [
      ['POST', '/rooms'],
      ['GET', '/rooms'],
      ['GET', `/rooms/${room.id}`],
      ['GET', `/rooms/by-code/${room.code}`],
      ['POST', `/rooms/${room.id}/join`],
      ['POST', `/rooms/${room.id}/leave`],
      ['POST', `/rooms/${room.id}/end`],
    ] as const) {
      // Signed out.
      expect((await t.call(method, path, { body: {} })).status, `${method} ${path} signed out`).toBe(401);
      // Waiting for approval, or blocked: no role the manifest knows, so no way in.
      expect((await t.call(method, path, { as: 'pat@test.dev', role: 'PENDING', body: {} })).status, `${method} ${path} pending`).toBe(401);
    }
    expect((await t.call('POST', '/rooms', { as: ann, body: {}, noCsrf: true })).status).toBe(403);
    expect(t.games.started).toHaveLength(1);
  });
});

describe('pre-warming', () => {
  const warm = (t: Harness, as = ann) => t.call('POST', '/rooms/warm', { as, role: 'EDITOR' });

  it('starts one hidden server per person, which their next POST /rooms takes over', async () => {
    const t = harness();
    const first = await warm(t);
    expect(first.status).toBe(201);
    const id = first.body.room.id;
    expect(first.body.room).toMatchObject({ status: 'starting', warm: true, warmUntil: expect.any(String) });
    expect(Date.parse(first.body.room.warmUntil) - Date.parse(first.body.room.createdAt)).toBe(5 * 60_000);
    // Asking again doesn't start a second.
    const again = await warm(t);
    expect([again.status, again.body.room.id]).toEqual([200, id]);
    expect(t.games.started).toEqual([id]);
    await t.games.open(id);
    // Hidden: not listed, not found by its code, not joinable, not audited.
    expect((await t.call('GET', '/rooms', { as: bob })).body.rooms).toEqual([]);
    expect((await t.call('GET', `/rooms/by-code/${first.body.room.code}`, { as: bob })).status).toBe(404);
    expect((await t.call('POST', `/rooms/${id}/join`, { as: bob })).body.code).toBe('ROOM_STARTING');
    expect(t.platform.audit.filter((a) => a.action === 'room.create')).toEqual([]);

    // Play: the same room, already open, now named, listed, joinable and audited.
    const res = await t.call('POST', '/rooms', { as: ann, role: 'EDITOR', body: { name: 'Friday dots' } });
    expect(res.status).toBe(201);
    expect(res.body.room).toMatchObject({ id, name: 'Friday dots', status: 'open' });
    expect(res.body.room).not.toHaveProperty('warm');
    expect(t.games.started).toEqual([id]);
    expect(t.platform.audit.at(-1)).toMatchObject({ action: 'room.create' });
    expect((await t.call('GET', '/rooms', { as: bob })).body.rooms.map((r: { id: string }) => r.id)).toEqual([id]);
    expect((await t.call('GET', `/rooms/by-code/${res.body.room.code}`, { as: bob })).body.room.id).toBe(id);
    expect((await t.call('POST', `/rooms/${id}/join`, { as: ann })).status).toBe(200);
    // Taken once: the next Play starts its own.
    const next = await t.call('POST', '/rooms', { as: ann, role: 'EDITOR', body: {} });
    expect(next.body.room.id).not.toBe(id);
    expect(t.games.started).toHaveLength(2);
  });

  it("doesn't hand you someone else's warm room", async () => {
    const t = harness();
    const bobs = (await warm(t, bob)).body.room.id;
    const mine = await t.call('POST', '/rooms', { as: ann, role: 'EDITOR', body: {} });
    expect(mine.body.room.id).not.toBe(bobs);
    expect(t.games.started).toEqual([bobs, mine.body.room.id]);
  });

  it('ends a warm room nobody takes after warmMinutes, as unused', async () => {
    const t = harness({ ...manifest, gameServer: { warmMinutes: 2 } });
    const id = (await warm(t)).body.room.id;
    t.advance(2 * 60_000);
    await t.call('GET', '/rooms', { as: bob });
    expect(t.games.stopped).toEqual([id]);
    expect((await t.call('GET', `/rooms/${id}`, { as: ann })).body.room).toMatchObject({ status: 'ended', endedReason: 'unused' });
    expect((await t.call('GET', `/rooms/${id}`, { as: ann })).body.room).not.toHaveProperty('warm');
    // Play then starts a fresh one.
    const res = await t.call('POST', '/rooms', { as: ann, role: 'EDITOR', body: {} });
    expect(res.body.room.id).not.toBe(id);
  });

  it("doesn't take a warm room about to expire: it retires it and starts a fresh one", async () => {
    const t = harness();
    const id = (await warm(t)).body.room.id;
    t.advance(5 * 60_000 - 20_000);
    const res = await t.call('POST', '/rooms', { as: ann, role: 'EDITOR', body: {} });
    expect(res.body.room.id).not.toBe(id);
    expect(t.games.stopped).toEqual([id]);
    expect((await t.call('GET', `/rooms/${id}`, { as: ann })).body.room.endedReason).toBe('unused');
  });

  it('gives way to real games at maxRooms, and is refused there itself', async () => {
    const t = harness({ ...manifest, gameServer: { maxRooms: 2 } });
    const bobs = (await warm(t, bob)).body.room.id;
    await openRoom(t);
    // Full: Cy's game pushes out Bob's warm room.
    const cys = await t.call('POST', '/rooms', { as: 'cy@test.dev', body: {} });
    expect(cys.status).toBe(201);
    expect(t.games.stopped).toEqual([bobs]);
    // Full of real games: warming is refused, and nothing is pushed out.
    expect((await warm(t, bob)).status).toBe(429);
    expect(t.games.stopped).toEqual([bobs]);
  });

  it('lets only one of two POST /rooms at once take the warm room', async () => {
    const t = harness();
    const id = (await warm(t)).body.room.id;
    const [a, b] = await Promise.all([0, 1].map(() => t.call('POST', '/rooms', { as: ann, role: 'EDITOR', body: {} })));
    expect([a!.body.room.id, b!.body.room.id].filter((x) => x === id)).toHaveLength(1);
    expect(t.games.started).toHaveLength(2);
  });
});

describe('joining', () => {
  it('returns a ticket that verifies for this room and user, and expires after 60 s', async () => {
    const t = harness();
    const room = await openRoom(t);
    const res = await t.call('POST', `/rooms/${room.id}/join`, { as: { email: bob, name: 'Bob' } });
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual({ room: `room/${room.id}`, toServer: `room/${room.id}/to-server`, toMe: `room/${room.id}/to/u-bob-test-dev` });
    expect(res.body.player).toEqual({ id: 'u_bob_test_dev', userId: 'u_bob_test_dev', device: 'default', name: 'Bob' });
    expect(res.body.room).toMatchObject({ id: room.id, status: 'open', players: 1 });

    const issued = Date.parse(res.body.expiresAt) - 60_000;
    const ticket = await verifyGameTicket(t.games.gameKey, res.body.ticket, room.id, issued + 59_000);
    expect(ticket).toMatchObject({ roomId: room.id, userId: 'u_bob_test_dev', device: 'default', name: 'Bob' });
    expect(await verifyGameTicket(t.games.gameKey, res.body.ticket, room.id, issued + 60_000)).toBeNull();
    // Not for another room, not with another key, not after tampering.
    expect(await verifyGameTicket(t.games.gameKey, res.body.ticket, 'other-room', issued)).toBeNull();
    expect(await verifyGameTicket('another-key', res.body.ticket, room.id, issued)).toBeNull();
    const [prefix, claims, mac] = (res.body.ticket as string).split('.');
    const forged = btoa(atob(claims!.replace(/-/g, '+').replace(/_/g, '/')).replace('u_bob_test_dev', 'u_ann_test_dev'));
    expect(await verifyGameTicket(t.games.gameKey, `${prefix}.${forged}.${mac}`, room.id, issued)).toBeNull();
    // A realtime token is not a ticket.
    const realtimeToken = (await t.call('POST', '/realtime/token', { as: bob, body: { subscribe: [`room/${room.id}`] } })).body.token;
    expect(await verifyGameTicket(t.realtime.key, realtimeToken, room.id, issued)).toBeNull();
  });

  it('refuses a room that is still starting, ended, or unknown', async () => {
    const t = harness();
    const starting = (await t.call('POST', '/rooms', { as: ann, role: 'EDITOR', body: {} })).body.room;
    const early = await t.call('POST', `/rooms/${starting.id}/join`, { as: bob });
    expect([early.status, early.body.code]).toEqual([409, 'ROOM_STARTING']);
    await t.games.open(starting.id);
    await t.call('POST', `/rooms/${starting.id}/end`, { as: ann, role: 'EDITOR' });
    const late = await t.call('POST', `/rooms/${starting.id}/join`, { as: bob });
    expect([late.status, late.body.code]).toEqual([409, 'ROOM_ENDED']);
    expect((await t.call('POST', '/rooms/nope/join', { as: bob })).status).toBe(404);
  });

  it('gives STUN only without the TURN key and says so on /health; TURN servers with it', async () => {
    const t = harness();
    const room = await openRoom(t);
    expect((await t.call('POST', `/rooms/${room.id}/join`, { as: bob })).body.iceServers).toEqual([{ urls: ['stun:stun.cloudflare.com:3478'] }]);
    expect((await t.call('GET', '/health')).body).toEqual({ ok: true, app: 'notes', build: 'dev', missingPlatformKeys: ['CLOUDFLARE_TURN_KEY_ID', 'CLOUDFLARE_TURN_API_TOKEN'] });

    t.games.turn = [{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }];
    expect((await t.call('POST', `/rooms/${room.id}/join`, { as: bob })).body.iceServers).toEqual([...STUN_ONLY, ...t.games.turn]);
    expect((await t.call('GET', '/health')).body).toEqual({ ok: true, app: 'notes', build: 'dev' });
  });

  it('still lets people in (STUN only) when TURN credentials cannot be fetched', async () => {
    const t = harness();
    const room = await openRoom(t);
    t.games.iceServers = () => Promise.reject(new Error('cloudflare down'));
    const logs = captureLogs();
    const res = await t.call('POST', `/rooms/${room.id}/join`, { as: bob });
    logs.stop();
    expect(res.status).toBe(200);
    expect(res.body.iceServers).toEqual(STUN_ONLY);
    expect(logs.lines).toContainEqual(expect.objectContaining({ level: 'warn', message: 'TURN credentials unavailable; joining with STUN only' }));
  });
});

describe('seats per device', () => {
  const join = (t: Harness, roomId: string, as: string, device?: string) =>
    t.call('POST', `/rooms/${roomId}/join`, { as, body: device === undefined ? {} : { device } });
  const seats = async (t: Harness, roomId: string) => (await t.games.seats(roomId)).map((p) => [`PLAYER#${p.id}`, p.userId, p.device]);

  it('gives one person a seat per device, each with its own ticket, and one answers channel', async () => {
    const t = harness();
    const room = await openRoom(t);
    const screen = await join(t, room.id, bob, 'screen');
    const gun = await join(t, room.id, bob, 'gun');
    expect([screen.status, gun.status]).toEqual([200, 200]);
    expect(screen.body.player).toEqual({ id: 'u_bob_test_dev~screen', userId: 'u_bob_test_dev', device: 'screen', name: 'bob' });
    expect(gun.body.player).toMatchObject({ id: 'u_bob_test_dev~gun', device: 'gun' });
    expect(gun.body.room.players).toBe(2);
    // Answers for both come on the user's channel (the server's `sid` tells the connections apart).
    expect(gun.body.channels.toMe).toBe(screen.body.channels.toMe);
    const issued = Date.parse(gun.body.expiresAt) - 60_000;
    expect(await verifyGameTicket(t.games.gameKey, gun.body.ticket, room.id, issued)).toMatchObject({ userId: 'u_bob_test_dev', device: 'gun' });
    expect(await seats(t, room.id)).toEqual([
      ['PLAYER#u_bob_test_dev~gun', 'u_bob_test_dev', 'gun'],
      ['PLAYER#u_bob_test_dev~screen', 'u_bob_test_dev', 'screen'],
    ]);
    expect((await t.call('GET', `/rooms/${room.id}`, { as: ann })).body.room.players).toBe(2);
  });

  it('keeps the seat for a second join from the same device (a reconnect, or a takeover)', async () => {
    const t = harness();
    const room = await openRoom(t);
    await join(t, room.id, bob, 'gun');
    const again = await join(t, room.id, bob, 'gun');
    expect(again.status).toBe(200);
    expect(again.body.room.players).toBe(1);
    // No device and `default` are the same seat, keyed by the user id as before.
    await join(t, room.id, bob);
    expect((await join(t, room.id, bob, 'default')).body.player.id).toBe('u_bob_test_dev');
    expect((await seats(t, room.id)).map(([sk]) => sk)).toEqual(['PLAYER#u_bob_test_dev', 'PLAYER#u_bob_test_dev~gun']);
  });

  it('counts seats against maxPlayers, and leaving frees only that seat', async () => {
    const t = harness({ ...manifest, gameServer: { maxPlayers: 2 } });
    const room = await openRoom(t);
    await join(t, room.id, bob, 'screen');
    await join(t, room.id, bob, 'gun');
    const cy = await join(t, room.id, 'cy@test.dev');
    expect([cy.status, cy.body.code]).toEqual([409, 'ROOM_FULL']);
    const third = await join(t, room.id, bob, 'gun-2');
    expect([third.status, third.body.code]).toEqual([409, 'ROOM_FULL']);

    expect((await t.call('POST', `/rooms/${room.id}/leave`, { as: bob, body: { device: 'gun' } })).status).toBe(200);
    expect((await seats(t, room.id)).map(([sk]) => sk)).toEqual(['PLAYER#u_bob_test_dev~screen']);
    expect((await join(t, room.id, 'cy@test.dev')).status).toBe(200);
  });

  it('caps one person at MAX_SEATS_PER_USER seats, so nobody fills a room with labels', async () => {
    const t = harness();
    const room = await openRoom(t);
    for (const device of ['a', 'b', 'c', 'd']) expect((await join(t, room.id, bob, device)).status).toBe(200);
    const fifth = await join(t, room.id, bob, 'e');
    expect([fifth.status, fifth.body.code]).toEqual([409, 'TOO_MANY_SEATS']);
    expect(MAX_SEATS_PER_USER).toBe(4);
    // Seats already held still rejoin, and others are unaffected.
    expect((await join(t, room.id, bob, 'a')).status).toBe(200);
    expect((await join(t, room.id, ann, 'a')).status).toBe(200);
  });

  it('refuses a device that is not a label', async () => {
    const t = harness();
    const room = await openRoom(t);
    for (const device of ['', 'Gun', 'gun 2', 'gun~2', 'a'.repeat(17), 7, true, ['gun']]) {
      const res = await t.call('POST', `/rooms/${room.id}/join`, { as: bob, body: { device } });
      expect([device, res.status, res.body.code]).toEqual([device, 400, 'BAD_REQUEST']);
    }
    expect((await t.call('POST', `/rooms/${room.id}/leave`, { as: bob, body: { device: 'NOPE' } })).status).toBe(400);
    expect(await seats(t, room.id)).toEqual([]);
  });

  it('makes seat ids and reads old tickets (no device) as the default seat', async () => {
    expect(seatId('u_1')).toBe('u_1');
    expect(seatId('u_1', 'default')).toBe('u_1');
    expect(seatId('u_1', 'gun')).toBe('u_1~gun');
    const old = await signHmacToken('sgt1', 'k', { roomId: 'r', userId: 'u_1', name: 'A', exp: 100 });
    expect(await readGameTicket('k', old)).toEqual({ roomId: 'r', userId: 'u_1', device: 'default', name: 'A', exp: 100 });
    const bad = await signHmacToken('sgt1', 'k', { roomId: 'r', userId: 'u_1', device: 'No Way', name: 'A', exp: 100 });
    expect(await readGameTicket('k', bad)).toBeNull();
  });
});

describe('ending', () => {
  it('lets the creator or an approver end a room, and nobody else', async () => {
    const t = harness();
    const room = await openRoom(t);
    await t.call('POST', `/rooms/${room.id}/join`, { as: bob });
    const refused = await t.call('POST', `/rooms/${room.id}/end`, { as: bob, role: 'EDITOR' });
    expect(refused.status).toBe(403);
    expect(t.games.stopped).toEqual([]);

    const ended = await t.call('POST', `/rooms/${room.id}/end`, { as: ann, role: 'EDITOR' });
    expect(ended.status).toBe(200);
    expect(ended.body.room).toMatchObject({ status: 'ended', endedReason: 'ended', players: 0 });
    expect(t.games.stopped).toEqual([room.id]);
    expect(t.realtime.on(`room/${room.id}`)).toEqual([{ status: 'ended' }]);
    expect(t.platform.audit.at(-1)).toMatchObject({ action: 'room.end' });
    // Gone from the list, its code free, still readable by id (with a TTL).
    expect((await t.call('GET', '/rooms', { as: bob })).body.rooms).toEqual([]);
    expect((await t.call('GET', `/rooms/by-code/${room.code}`, { as: bob })).status).toBe(404);
    expect((await t.call('GET', `/rooms/${room.id}`, { as: bob })).body.room.status).toBe('ended');
    expect((await t.store.get(roomKeys.meta(room.id).PK, 'META'))!.expiresAt).toBeGreaterThan(Date.parse('2026-01-07T00:00:00Z') / 1000);
    expect((await t.call('POST', `/rooms/${room.id}/end`, { as: ann, role: 'EDITOR' })).status).toBe(409);

    const other = await openRoom(t, bob);
    expect((await t.call('POST', `/rooms/${other.id}/end`, { as: 'olive@test.dev', role: 'OWNER' })).status).toBe(200);
  });

  it('stops the server of a room ended while it is still starting', async () => {
    const t = harness();
    const room = (await t.call('POST', '/rooms', { as: ann, role: 'EDITOR', body: {} })).body.room;
    expect((await t.call('POST', `/rooms/${room.id}/end`, { as: ann, role: 'EDITOR' })).status).toBe(200);
    expect(t.games.stopped).toEqual([room.id]);
  });

  it('shows what the server wrote when a game ends by itself', async () => {
    const t = harness();
    const room = await openRoom(t);
    await t.games.end(room.id, 'idle', { winner: 'u_bob_test_dev' });
    expect((await t.call('GET', `/rooms/${room.id}`, { as: bob })).body.room).toMatchObject({ status: 'ended', endedReason: 'idle', results: { winner: 'u_bob_test_dev' } });
    expect((await t.call('GET', '/rooms', { as: bob })).body.rooms).toEqual([]);
  });

  it('sweeps rooms whose server is gone', async () => {
    const t = harness();
    const dead = await openRoom(t);
    const alive = await openRoom(t, bob);
    t.games.crash(dead.id);
    const list = (await t.call('GET', '/rooms', { as: bob })).body.rooms;
    expect(list.map((r: { id: string }) => r.id)).toEqual([alive.id]);
    expect((await t.call('GET', `/rooms/${dead.id}`, { as: bob })).body.room).toMatchObject({ status: 'ended', endedReason: 'stopped' });
    expect(t.realtime.on(`room/${dead.id}`)).toEqual([{ status: 'ended' }]);
    // A swept room no longer counts against the cap.
    for (let i = 0; i < 3; i++) await openRoom(t);
    expect((await t.call('POST', '/rooms', { as: ann, body: {} })).status).toBe(429);
  });

  it('stops a server that outlives the time limit', async () => {
    const t = harness({ ...manifest, gameServer: { maxHours: 0.25 } });
    const room = await openRoom(t);
    t.advance(15 * 60_000 + 4 * 60_000);
    expect((await t.call('GET', '/rooms', { as: bob })).body.rooms).toHaveLength(1);
    t.advance(2 * 60_000);
    expect((await t.call('GET', '/rooms', { as: bob })).body.rooms).toEqual([]);
    expect(t.games.stopped).toEqual([room.id]);
    expect((await t.call('GET', `/rooms/${room.id}`, { as: bob })).body.room.endedReason).toBe('time');
  });
});

describe('room channels', () => {
  const token = (t: Harness, as: string, body: unknown) => t.call('POST', '/realtime/token', { as, body });

  it('lets a member listen to the room and their own answers, and publish to the server', async () => {
    const t = harness();
    const res = await token(t, bob, { subscribe: ['room/r1', 'room/r1/to/u-bob-test-dev'], publish: ['room/r1/to-server'] });
    expect(res.status).toBe(200);
    const claims = await verifyRealtimeToken(t.realtime.key, res.body.token, t.deps.now().getTime());
    expect(claims).toMatchObject({ s: ['room/r1', 'room/r1/to/u-bob-test-dev'], p: ['room/r1/to-server'] });
  });

  it("refuses someone else's answers channel", async () => {
    const t = harness();
    const res = await token(t, bob, { subscribe: ['room/r1/to/u-ann-test-dev'] });
    expect([res.status, res.body.code]).toEqual([403, 'REALTIME_REFUSED']);
  });

  it('refuses publishing on the room channel or on answers, and listening to offers', async () => {
    const t = harness();
    for (const body of [{ publish: ['room/r1'] }, { publish: ['room/r1/to/u-bob-test-dev'] }]) {
      const res = await token(t, bob, body);
      expect([res.status, res.body.code]).toEqual([403, 'REALTIME_SUBSCRIBE_ONLY']);
    }
    const res = await token(t, bob, { subscribe: ['room/r1/to-server'] });
    expect([res.status, res.body.code]).toEqual([403, 'REALTIME_REFUSED']);
  });

  it('turns user ids into channel segments one-to-one', () => {
    expect(playerChannelId('u_0a1b2c3d4e5f6a7b8c9d0e1f')).toBe('u-0a1b2c3d4e5f6a7b8c9d0e1f');
    expect(playerChannelId('u_ann_test_dev')).toBe('u-ann-test-dev');
  });

  it('keeps apps off the room/* channels', () => {
    const routes = (api: AppRoutes<AppDeps>) => api.realtime.channel('room/*/chat', { subscribe: true });
    expect(() => createTestHarness({ manifest, routes })).toThrow(/gameServer module owns "room\/\*"/);
  });
});

describe('without the module', () => {
  it('has no room routes and deps.games says how to turn it on', async () => {
    const t = harness({ ...base, modules: ['realtime'] });
    expect((await t.call('POST', '/rooms', { as: ann, body: {} })).status).toBe(404);
    await expect(t.deps.games.start('r1')).rejects.toThrow(/add "gameServer" \(and "realtime"\) to "modules"/);
    expect((await t.call('GET', '/health')).body).toEqual({ ok: true, app: 'notes', build: 'dev' });
  });

  it('refuses gameServer without realtime', () => {
    const deps = { ...harness().deps, games: gamesOff('notes') };
    expect(() => createStacksApp({ manifest: { ...base, modules: ['gameServer'] }, deps, routes: baseRoutes })).toThrow(/needs "realtime"/);
  });
});

describe('awsGames', () => {
  function setup(params: Record<string, string> = {}) {
    const store = new MemoryStore();
    const sent: { name: string; input: any }[] = [];
    const tasks = new Map<string, { lastStatus: string; desiredStatus: string }>();
    const ecs = {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: any }) => {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'RunTaskCommand') {
          const taskArn = `arn:aws:ecs:us-east-1:1:task/stacks-test-games/t${tasks.size + 1}`;
          tasks.set(taskArn, { lastStatus: 'PROVISIONING', desiredStatus: 'RUNNING' });
          return { tasks: [{ taskArn }] };
        }
        if (cmd.constructor.name === 'DescribeTasksCommand') {
          return { tasks: (cmd.input.tasks as string[]).filter((a) => tasks.has(a)).map((taskArn) => ({ taskArn, ...tasks.get(taskArn)! })) };
        }
        if (cmd.constructor.name === 'StopTaskCommand') {
          if (!tasks.has(cmd.input.task)) throw Object.assign(new Error('The referenced task was not found.'), { name: 'InvalidParameterException' });
          tasks.set(cmd.input.task, { lastStatus: 'STOPPED', desiredStatus: 'STOPPED' });
        }
        return {};
      }),
    };
    const ssm = {
      send: vi.fn(async (cmd: { input: { Name: string } }) => {
        const value = params[cmd.input.Name];
        if (value === undefined) throw Object.assign(new Error('nope'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: value } };
      }),
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ iceServers: [] }), { status: 201 }));
    const presigned: { bucket: string; key: string; expiresIn: number }[] = [];
    const games = awsGames({
      app: 'hello',
      store,
      clusterArn: 'arn:aws:ecs:us-east-1:1:cluster/stacks-test-games',
      taskDefinition: 'stacks-test-app-hello-game',
      containerName: 'game',
      subnetIds: ['subnet-a', 'subnet-b'],
      securityGroupId: 'sg-1',
      key: async () => 'k',
      bundle: { bucket: 'cdk-stktest-assets', key: 'abc123.mjs' },
      presign: async (bucket: string, key: string, expiresIn: number) => {
        presigned.push({ bucket, key, expiresIn });
        return `https://${bucket}.s3.amazonaws.com/${key}?X-Amz-Expires=${expiresIn}&X-Amz-Signature=sig`;
      },
      turnPrefix: '/stacks/test/secrets/platform/',
      ecs: ecs as never,
      ssm: ssm as never,
      fetch: fetchMock as never,
    });
    return { games, store, sent, tasks, fetchMock, ssm, presigned };
  }

  it('runs one tagged Fargate task per room on a public IP, with the room id and a 15-minute link to its game', async () => {
    const { games, sent, store, presigned } = setup();
    await games.start('room-1');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: 'RunTaskCommand',
      input: {
        cluster: 'arn:aws:ecs:us-east-1:1:cluster/stacks-test-games',
        taskDefinition: 'stacks-test-app-hello-game',
        launchType: 'FARGATE',
        count: 1,
        startedBy: 'room-1',
        networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-a', 'subnet-b'], securityGroups: ['sg-1'], assignPublicIp: 'ENABLED' } },
        overrides: {
          containerOverrides: [
            {
              name: 'game',
              environment: [
                { name: 'STACKS_ROOM_ID', value: 'room-1' },
                { name: 'STACKS_GAME_BUNDLE_URL', value: 'https://cdk-stktest-assets.s3.amazonaws.com/abc123.mjs?X-Amz-Expires=900&X-Amz-Signature=sig' },
              ],
            },
          ],
        },
        propagateTags: 'TASK_DEFINITION',
        tags: [{ key: 'stacks:app', value: 'hello' }, { key: 'stacks:room', value: 'room-1' }],
      },
    });
    expect(presigned).toEqual([{ bucket: 'cdk-stktest-assets', key: 'abc123.mjs', expiresIn: 900 }]);
    expect(await store.get(roomKeys.task('room-1').PK, 'TASK')).toMatchObject({ taskArn: expect.stringContaining('task/stacks-test-games/t1') });
  });

  it('fails when ECS starts nothing', async () => {
    const broken = awsGames({
      app: 'hello', store: new MemoryStore(), clusterArn: 'c', taskDefinition: 't', containerName: 'game', subnetIds: ['s'], securityGroupId: 'sg', key: async () => 'k',
      bundle: { bucket: 'b', key: 'k.mjs' }, presign: async () => 'https://b/k.mjs',
      ecs: { send: async () => ({ tasks: [], failures: [{ reason: 'RESOURCE:CPU' }] }) } as never,
    });
    await expect(broken.start('r')).rejects.toThrow(/did not start a task.*RESOURCE:CPU/);
  });

  it('signs the link with the real presigner: GET on that object, expiring in 15 minutes', async () => {
    const env = { ...process.env };
    Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'session', AWS_REGION: 'us-east-1' });
    try {
      const sent: any[] = [];
      const games = awsGames({
        app: 'hello', store: new MemoryStore(), clusterArn: 'c', taskDefinition: 't', containerName: 'game', subnetIds: ['s'], securityGroupId: 'sg', key: async () => 'k',
        bundle: { bucket: 'cdk-stktest-assets-1-us-east-1', key: 'abc123.mjs' },
        ecs: { send: async (cmd: { input: unknown }) => (sent.push(cmd.input), { tasks: [{ taskArn: 'arn:task' }] }) } as never,
      });
      await games.start('room-1');
      const url = new URL(sent[0].overrides.containerOverrides[0].environment.find((e: { name: string }) => e.name === 'STACKS_GAME_BUNDLE_URL').value);
      expect(url.hostname).toBe('cdk-stktest-assets-1-us-east-1.s3.us-east-1.amazonaws.com');
      expect(url.pathname).toBe('/abc123.mjs');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request$/);
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
      // Container overrides are capped at 8 KB: a signed link with a session token fits easily.
      expect(JSON.stringify(sent[0].overrides).length).toBeLessThan(4096);
    } finally {
      process.env = env;
    }
  });

  it('knows which rooms still have a server, and stops them once', async () => {
    const { games, tasks, sent } = setup();
    await games.start('a');
    await games.start('b');
    expect(await games.running(['a', 'b', 'never-started'])).toEqual(new Set(['a', 'b']));
    await games.stop('a');
    expect(await games.running(['a', 'b'])).toEqual(new Set(['b']));
    // ECS has forgotten the task: not an error, and it reads as gone.
    tasks.clear();
    await games.stop('b');
    await games.stop('never-started');
    expect(await games.running(['a', 'b'])).toEqual(new Set());
    expect(sent.filter((s) => s.name === 'StopTaskCommand')).toHaveLength(2);
  });

  it('gives STUN only and names the missing halves when the TURN key is not stored', async () => {
    const { games, fetchMock } = setup({ '/stacks/test/secrets/platform/CLOUDFLARE_TURN_KEY_ID': 'kid' });
    expect(await games.iceServers(3600)).toEqual(STUN_ONLY);
    expect(await games.missingKeys!()).toEqual(['CLOUDFLARE_TURN_API_TOKEN']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints short-lived TURN credentials from Cloudflare and drops the port-53 URLs', async () => {
    const { games, fetchMock, ssm } = setup({
      '/stacks/test/secrets/platform/CLOUDFLARE_TURN_KEY_ID': 'kid',
      '/stacks/test/secrets/platform/CLOUDFLARE_TURN_API_TOKEN': 'tok',
    });
    fetchMock.mockImplementation(
      async () =>
        new Response(
        JSON.stringify({
          iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
            { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
          ],
        }),
        { status: 201 },
      ),
    );
    expect(await games.iceServers(7800)).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/kid/credentials/generate-ice-servers');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ ttl: 7800 }) });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(await games.missingKeys!()).toEqual([]);
    // The key is read once, not per join.
    await games.iceServers(60);
    expect(ssm.send).toHaveBeenCalledTimes(2);
  });

  it('rejects when Cloudflare refuses (the join route then falls back to STUN)', async () => {
    const { games, fetchMock } = setup({
      '/stacks/test/secrets/platform/CLOUDFLARE_TURN_KEY_ID': 'kid',
      '/stacks/test/secrets/platform/CLOUDFLARE_TURN_API_TOKEN': 'tok',
    });
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(games.iceServers(60)).rejects.toThrow(/403/);
  });

  it('ignores anything that is not an ICE URL', () => {
    expect(usableIceServers([{ urls: 'stun:a:3478' }, { urls: ['https://evil'] }, null, { urls: ['turn:b:53'] }])).toEqual([{ urls: ['stun:a:3478'] }]);
    expect(usableIceServers('nope')).toEqual([]);
  });

  it('signs tickets with the key it was given', async () => {
    const { games } = setup();
    const ticket = await signGameTicket(await games.key(), { roomId: 'r', userId: 'u_1', name: 'A', exp: 100 });
    expect(await verifyGameTicket('k', ticket, 'r', 99_000)).toMatchObject({ userId: 'u_1' });
  });
});
