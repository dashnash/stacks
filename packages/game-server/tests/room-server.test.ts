import { describe, expect, it } from 'vitest';
import { MemoryStore, roomChannels, roomKeys } from '@stacks/api';
import { defineGame } from '../src/index';
import { game, ROOM, settle, setup } from './helpers';

const ANN = 'u_ann';
const BOB = 'u_bob';

describe('RoomServer', () => {
  it('opens the room: listens for offers first, then writes "open" (nothing secret) and tells the lobby', async () => {
    const t = await setup();
    expect(await t.server.start()).toBe(true);
    expect(t.signaling.listeners(roomChannels.toServer(ROOM))).toBe(1);
    expect(await t.store.get(roomKeys.server(ROOM).PK, 'SERVER')).toEqual({ PK: `ROOM#${ROOM}`, SK: 'SERVER', status: 'open', openedAt: '2026-06-01T12:00:00.000Z' });
    expect(t.signaling.on(`room/${ROOM}`)).toEqual([{ status: 'open' }]);
  });

  it('runs nothing for a room that was ended while the server was starting, or that does not exist', async () => {
    for (const status of ['ended', 'missing']) {
      const t = await setup({ status });
      expect(await t.server.start()).toBe(false);
      expect(t.signaling.published).toEqual([]);
      expect(await t.store.get(roomKeys.server(ROOM).PK, 'SERVER')).toBeUndefined();
    }
  });

  it('answers an offer with a good ticket on that player\'s own channel and binds the peer to the ticket\'s user', async () => {
    const t = await setup();
    await t.server.start();
    await t.offer(ANN, 'Ann', 's1');
    expect(t.answers(ANN)).toEqual([{ t: 'answer', sid: 's1', sdp: 'answer-to:offer-s1' }]);
    expect(t.peers).toHaveLength(1);
    // Nobody is in the game until the data channels open.
    expect(t.server.host!.players).toEqual([]);
    t.peers[0]!.open();
    expect(t.server.host!.players).toEqual([{ id: ANN, userId: ANN, device: 'default', name: 'Ann' }]);
    expect(t.peers[0]!.events[0]).toMatchObject({ welcome: { you: { id: ANN, userId: ANN, device: 'default', name: 'Ann' }, rejoined: false } });

    t.peers[0]!.hooks.onState(JSON.stringify({ i: { x: 1 } }));
    t.advance(50);
    expect(JSON.parse(t.peers[0]!.state.at(-1)!).s.seen).toEqual(['join Ann', 'input Ann {"x":1}']);
  });

  it('accepts offers in the web SDK\'s envelope', async () => {
    const t = await setup();
    await t.server.start();
    await t.offer(ANN, 'Ann', 's1', { wrap: true });
    expect(t.answers(ANN)).toHaveLength(1);
  });

  it('ignores a forged ticket, a ticket for another room, and junk, without a word', async () => {
    const t = await setup();
    await t.server.start();
    await t.offer(ANN, 'Ann', 's1', { key: 'someone-elses-key' });
    await t.offer(ANN, 'Ann', 's2', { roomId: 'another-room' });
    await t.offer(ANN, 'Ann', 's3', { ticket: 'sgt1.e30.AAAA' });
    const good = await t.ticket(ANN, 'Ann');
    const [prefix, claims, mac] = good.split('.');
    const swapped = btoa(atob(claims!.replace(/-/g, '+').replace(/_/g, '/')).replace(ANN, BOB)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await t.offer(BOB, 'Bob', 's4', { ticket: `${prefix}.${swapped}.${mac}` });
    for (const junk of [null, 'offer', { t: 'offer' }, { t: 'offer', sid: 's5', ticket: good }, { t: 'offer', sid: 5, ticket: good, sdp: 'x' }, { t: 'nope', sid: 's6' }]) {
      t.signaling.fromClient(roomChannels.toServer(ROOM), junk);
    }
    await settle();
    expect(t.peers).toEqual([]);
    expect(t.signaling.published.filter((p) => p.channel !== `room/${ROOM}`)).toEqual([]);
    expect(t.logs.filter((l) => /bad ticket/.test(l))).toHaveLength(4);
  });

  it('refuses an expired ticket and says so, so the client fetches a fresh one', async () => {
    const t = await setup();
    await t.server.start();
    const old = await t.ticket(ANN, 'Ann');
    t.clock.wall += 61_000;
    await t.offer(ANN, 'Ann', 's1', { ticket: old });
    expect(t.peers).toEqual([]);
    expect(t.answers(ANN)).toEqual([{ t: 'refused', sid: 's1', reason: 'ticket' }]);
  });

  it('passes trickled candidates to the right peer, cleaned up, and drops the rest', async () => {
    const t = await setup();
    await t.server.start();
    await t.offer(ANN, 'Ann', 's1');
    const to = roomChannels.toServer(ROOM);
    t.signaling.fromClient(to, { t: 'ice', sid: 's1', c: { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, extra: 'dropped' } });
    t.signaling.fromClient(to, { t: 'ice', sid: 'unknown', c: { candidate: 'candidate:2' } });
    t.signaling.fromClient(to, { t: 'ice', sid: 's1', c: { candidate: 5 } });
    t.signaling.fromClient(to, { t: 'ice', sid: 's1' });
    await settle();
    expect(t.peers[0]!.candidates).toEqual([{ candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 }]);
    for (let i = 0; i < 60; i++) t.signaling.fromClient(to, { t: 'ice', sid: 's1', c: { candidate: `candidate:${i}` } });
    await settle();
    expect(t.peers[0]!.candidates.length).toBe(40);
  });

  it("restores a player's slot when they reconnect within 20 s, and frees it (and their player record) after", async () => {
    const t = await setup();
    await t.server.start();
    await t.store.put({ ...roomKeys.player(ROOM, ANN), id: ANN });
    await t.offer(ANN, 'Ann', 's1');
    t.peers[0]!.open();
    t.peers[0]!.drop();
    t.advance(15_000);
    expect(t.server.host!.players).toHaveLength(1);
    await t.offer(ANN, 'Ann', 's2');
    t.peers[1]!.open();
    expect(t.peers[1]!.events[0]).toMatchObject({ welcome: { rejoined: true } });
    t.advance(50);
    expect(JSON.parse(t.peers[1]!.state.at(-1)!).s.seen).toEqual(['join Ann']);

    t.peers[1]!.drop();
    t.advance(21_000);
    await settle();
    expect(t.server.host!.players).toEqual([]);
    expect(await t.store.get(roomKeys.player(ROOM, ANN).PK, `PLAYER#${ANN}`)).toBeUndefined();
  });

  it('keeps one connection attempt per player and closes a peer that never opens', async () => {
    const t = await setup();
    await t.server.start();
    await t.offer(ANN, 'Ann', 's1');
    await t.offer(ANN, 'Ann', 's2');
    expect(t.peers.map((p) => p.closed)).toEqual([true, false]);
    // A live connection is not torn down by a new offer; it is swapped when the new one opens.
    t.peers[1]!.open();
    await t.offer(ANN, 'Ann', 's3');
    expect(t.peers[1]!.closed).toBe(false);
    t.peers[2]!.open();
    expect(t.peers[1]!.closed).toBe(true);
    expect(t.server.host!.players).toHaveLength(1);
  });

  it('refuses a player when the room is full, and limits how fast one user can send offers', async () => {
    const t = await setup({ maxPlayers: 1 });
    await t.server.start();
    await t.offer(ANN, 'Ann', 's1');
    t.peers[0]!.open();
    await t.offer(BOB, 'Bob', 'b1');
    expect(t.answers(BOB)).toEqual([{ t: 'refused', sid: 'b1', reason: 'full' }]);

    for (let i = 2; i <= 9; i++) await t.offer(ANN, 'Ann', `s${i}`);
    expect(t.answers(ANN).filter((a) => a.t === 'refused').map((a) => a.t === 'refused' && a.reason)).toEqual(['busy', 'busy', 'busy']);
    t.clock.wall += 11_000;
    await t.offer(ANN, 'Ann', 's10');
    expect(t.answers(ANN).at(-1)).toMatchObject({ t: 'answer', sid: 's10' });
  });

  it('tells the client when an offer cannot be answered', async () => {
    const t = await setup();
    await t.server.start();
    const original = t.server['opts'].peers;
    t.server['opts'].peers = (hooks) => {
      const peer = original(hooks) as (typeof t.peers)[number];
      peer.failAnswer = true;
      return peer;
    };
    await t.offer(ANN, 'Ann', 's1');
    expect(t.answers(ANN)).toEqual([{ t: 'refused', sid: 's1', reason: 'error' }]);
    expect(t.peers[0]!.closed).toBe(true);
  });

  it('on idle: sends "game over", writes results and "ended", tells the lobby, closes everything and finishes', async () => {
    const t = await setup();
    await t.server.start();
    await t.offer(ANN, 'Ann', 's1');
    t.peers[0]!.open();
    t.advance(10 * 60_000 + 100);
    const end = await t.server.done;
    expect(end).toEqual({ reason: 'idle', results: { seen: 1 } });
    expect(t.peers[0]!.events.at(-1)).toEqual({ over: { reason: 'idle', results: { seen: 1 } } });
    expect(await t.store.get(roomKeys.server(ROOM).PK, 'SERVER')).toMatchObject({ status: 'ended', reason: 'idle', results: { seen: 1 }, openedAt: '2026-06-01T12:00:00.000Z', endedAt: expect.any(String) });
    expect(t.signaling.on(`room/${ROOM}`)).toEqual([{ status: 'open' }, { status: 'ended' }]);
    expect(t.peers[0]!.closed).toBe(true);
    expect(t.signaling.listeners(roomChannels.toServer(ROOM))).toBe(0);
    // Offers after the end go nowhere.
    await t.offer(BOB, 'Bob', 'b1');
    expect(t.peers).toHaveLength(1);
  });

  it('ends at the time limit, and when the game ends itself', async () => {
    const t = await setup();
    await t.server.start();
    await t.offer(ANN, 'Ann', 's1');
    t.peers[0]!.open();
    for (let minute = 0; minute < 120; minute++) {
      t.peers[0]!.hooks.onState(JSON.stringify({ i: minute }));
      t.advance(60_000);
    }
    expect(await t.server.done).toMatchObject({ reason: 'time' });

    const u = await setup();
    await u.server.start();
    await u.offer(BOB, 'Bob', 'b1');
    u.peers[0]!.open();
    u.peers[0]!.hooks.onEvent(JSON.stringify({ event: 'finish' }));
    expect(await u.server.done).toEqual({ reason: 'finished', results: { winner: BOB } });
    expect(await u.store.get(roomKeys.server(ROOM).PK, 'SERVER')).toMatchObject({ status: 'ended', reason: 'finished', results: { winner: BOB } });
  });

  it('when told to stop (the API ended the room): says "game over" and writes up', async () => {
    const t = await setup();
    await t.server.start();
    await t.offer(ANN, 'Ann', 's1');
    t.peers[0]!.open();
    t.server.stop();
    expect(await t.server.done).toMatchObject({ reason: 'stopped' });
    expect(t.peers[0]!.events.at(-1)).toMatchObject({ over: { reason: 'stopped' } });
  });

  it('refuses a late peer whose offer was answered just before the end', async () => {
    const t = await setup();
    await t.server.start();
    await t.offer(ANN, 'Ann', 's1');
    t.server.host!.end('finished');
    t.peers[0]!.open();
    expect(t.peers[0]!.events).toEqual([{ over: { reason: 'ended' } }]);
  });

  it('keeps a store shared with the API consistent: only the SERVER record is written', async () => {
    const store = new MemoryStore();
    const t = await setup({ store });
    await t.server.start();
    t.server.stop();
    await t.server.done;
    expect([...store.items.values()].map((i) => i.SK).sort()).toEqual(['META', 'SERVER']);
    expect(await store.get(roomKeys.meta(ROOM).PK, 'META')).toMatchObject({ status: 'starting' });
  });
});

describe('RoomServer: one person, several devices', () => {
  it('gives each device of one user its own seat, answering both on that user\'s channel by sid', async () => {
    const t = await setup();
    await t.server.start();
    await t.offer(ANN, 'Ann', 'screen-1', { device: 'screen' });
    await t.offer(ANN, 'Ann', 'gun-1', { device: 'gun' });
    // Both offers got answers (one did not cancel the other), on Ann's one channel.
    expect(t.answers(ANN)).toEqual([
      { t: 'answer', sid: 'screen-1', sdp: 'answer-to:offer-screen-1' },
      { t: 'answer', sid: 'gun-1', sdp: 'answer-to:offer-gun-1' },
    ]);
    expect(t.peers.map((p) => p.closed)).toEqual([false, false]);
    t.peers[0]!.open();
    t.peers[1]!.open();
    expect(t.server.host!.players).toEqual([
      { id: `${ANN}~screen`, userId: ANN, device: 'screen', name: 'Ann' },
      { id: `${ANN}~gun`, userId: ANN, device: 'gun', name: 'Ann' },
    ]);
    expect(t.peers[1]!.events[0]).toMatchObject({ welcome: { you: { id: `${ANN}~gun`, device: 'gun' } } });
    t.peers[1]!.hooks.onState(JSON.stringify({ i: 'bang' }));
    t.advance(50);
    expect(JSON.parse(t.peers[0]!.state.at(-1)!).s.seen).toEqual(['join Ann', 'join Ann', 'input Ann "bang"']);
  });

  it('takes a seat over per device: a second gun connection replaces the first, the screen stays', async () => {
    const t = await setup();
    await t.server.start();
    await t.offer(ANN, 'Ann', 'screen-1', { device: 'screen' });
    t.peers[0]!.open();
    await t.offer(ANN, 'Ann', 'gun-1', { device: 'gun' });
    t.peers[1]!.open();
    await t.offer(ANN, 'Ann', 'gun-2', { device: 'gun' });
    t.peers[2]!.open();
    expect(t.peers.map((p) => p.closed)).toEqual([false, true, false]);
    expect(t.server.host!.players.map((p) => p.id)).toEqual([`${ANN}~screen`, `${ANN}~gun`]);
    expect(t.peers[2]!.events[0]).toMatchObject({ welcome: { rejoined: true } });
  });

  it('restores the right seat on a reconnect within 20 s, and frees only that seat\'s record after', async () => {
    const t = await setup();
    await t.server.start();
    for (const device of ['screen', 'gun']) await t.store.put({ ...roomKeys.player(ROOM, `${ANN}~${device}`), id: `${ANN}~${device}` });
    await t.offer(ANN, 'Ann', 'screen-1', { device: 'screen' });
    await t.offer(ANN, 'Ann', 'gun-1', { device: 'gun' });
    t.peers[0]!.open();
    t.peers[1]!.open();
    t.peers[1]!.drop();
    t.advance(10_000);
    await t.offer(ANN, 'Ann', 'gun-2', { device: 'gun' });
    t.peers[2]!.open();
    expect(t.peers[2]!.events[0]).toMatchObject({ welcome: { you: { id: `${ANN}~gun` }, rejoined: true } });

    t.peers[2]!.drop();
    t.advance(21_000);
    await settle();
    expect(t.server.host!.players.map((p) => p.id)).toEqual([`${ANN}~screen`]);
    expect(await t.store.get(`ROOM#${ROOM}`, `PLAYER#${ANN}~gun`)).toBeUndefined();
    expect(await t.store.get(`ROOM#${ROOM}`, `PLAYER#${ANN}~screen`)).toBeDefined();
  });

  it('counts seats against maxPlayers and honours the game\'s maxSeatsPerUser', async () => {
    const full = await setup({ maxPlayers: 2 });
    await full.server.start();
    await full.offer(ANN, 'Ann', 'a1', { device: 'screen' });
    await full.offer(ANN, 'Ann', 'a2', { device: 'gun' });
    full.peers[0]!.open();
    full.peers[1]!.open();
    await full.offer(BOB, 'Bob', 'b1');
    expect(full.answers(BOB)).toEqual([{ t: 'refused', sid: 'b1', reason: 'full' }]);

    const capped = await setup({ game: defineGame({ ...game, maxSeatsPerUser: 2 }) });
    await capped.server.start();
    for (const device of ['screen', 'gun']) {
      await capped.offer(ANN, 'Ann', device, { device });
      capped.peers.at(-1)!.open();
    }
    await capped.offer(ANN, 'Ann', 'gun-2', { device: 'gun-2' });
    expect(capped.answers(ANN).at(-1)).toEqual({ t: 'refused', sid: 'gun-2', reason: 'seats' });
    // A seat Ann already holds is still hers to reconnect, and Bob is unaffected.
    await capped.offer(ANN, 'Ann', 'gun-again', { device: 'gun' });
    expect(capped.answers(ANN).at(-1)).toMatchObject({ t: 'answer', sid: 'gun-again' });
    await capped.offer(BOB, 'Bob', 'b1');
    expect(capped.answers(BOB)).toMatchObject([{ t: 'answer' }]);
  });
});
