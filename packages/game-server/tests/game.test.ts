import { describe, expect, it } from 'vitest';
import { playGame } from '@stacks/testing';
import { defineGame, MAX_CATCH_UP_TICKS, type GamePlayer, type GameRoom } from '../src/index';

interface State {
  room: GameRoom<unknown>;
  ticks: number;
  dts: number[];
  log: string[];
  inputs: Record<string, unknown[]>;
  secrets: Record<string, string>;
}

/** A game that records everything that happens to it. */
const recorder = (overrides: Partial<Parameters<typeof defineGame<State>>[0]> = {}) =>
  defineGame<State>({
    tickHz: 20,
    init: (room) => ({ room, ticks: 0, dts: [], log: [], inputs: {}, secrets: {} }),
    onJoin: (s, p) => {
      s.log.push(`join ${p.name}`);
      s.secrets[p.id] = `secret-of-${p.name}`;
    },
    onLeave: (s, p) => void s.log.push(`leave ${p.name}`),
    onInput: (s, p, input) => void (s.inputs[p.id] ??= []).push(input),
    onEvent: (s, p, event) => {
      s.log.push(`event ${p.name} ${JSON.stringify(event)}`);
      if (event === 'bump') s.room.broadcast({ shake: p.name });
      if (event === 'whisper') s.room.send(p.id, { psst: true });
      if (event === 'finish') s.room.end({ winner: p.id });
      if (event === 'throw') throw new Error('bad handler');
    },
    tick: (s, dt) => {
      s.ticks++;
      s.dts.push(dt);
    },
    snapshot: (s, forPlayer) => ({ ticks: s.ticks, mine: s.secrets[forPlayer.id], inputs: s.inputs[forPlayer.id]?.length ?? 0, log: s.log }),
    ...overrides,
  });

type Snap = { ticks: number; mine: string; inputs: number; log: string[] };

describe('defineGame', () => {
  it('checks the rates and the required callbacks', () => {
    expect(() => defineGame({ tickHz: 0, init: () => ({}), snapshot: () => null })).toThrow(/tickHz must be from 1 to 60/);
    expect(() => defineGame({ tickHz: 61, init: () => ({}), snapshot: () => null })).toThrow(/tickHz/);
    expect(() => defineGame({ maxPlayers: 17, init: () => ({}), snapshot: () => null })).toThrow(/maxPlayers/);
    expect(() => defineGame({ maxSeatsPerUser: 0, init: () => ({}), snapshot: () => null })).toThrow(/maxSeatsPerUser must be from 1 to 4/);
    expect(() => defineGame({ init: () => ({}) } as never)).toThrow(/needs init\(room\) and snapshot/);
  });
});

describe('the tick loop', () => {
  it('runs fixed-timestep ticks under fake time and sends a snapshot per tick', () => {
    const g = playGame(recorder());
    const ann = g.join('ann@test.dev');
    g.advance(1000);
    expect(ann.state).toMatchObject({ ticks: 20 });
    expect(ann.states).toHaveLength(20);
    expect(ann.tick).toBe(20);
    g.advance(500);
    expect((ann.state as Snap).ticks).toBe(30);
  });

  it('always steps by exactly 1 / tickHz, however the timer drifts', () => {
    const g = playGame(recorder({ tickHz: 30 }));
    const ann = g.join('ann@test.dev');
    // A timer that fires late and unevenly.
    for (const ms of [40, 20, 70, 33, 5, 61, 34]) g.stall(ms);
    const state = ann.state as Snap;
    // 263 ms at 30 Hz is 7 whole ticks; the 30 ms left over waits for the next call.
    expect(state.ticks).toBe(7);
    g.stall(4);
    expect((ann.state as Snap).ticks).toBe(8);
  });

  it('caps catch-up after a stall: at most 5 ticks, the rest of the lost time is skipped', () => {
    const g = playGame(recorder());
    const ann = g.join('ann@test.dev');
    g.stall(10_000);
    expect((ann.state as Snap).ticks).toBe(MAX_CATCH_UP_TICKS);
    // One snapshot for the batch, not five.
    expect(ann.states).toHaveLength(1);
    // No backlog is left: the next 50 ms is one tick, not another burst.
    g.stall(50);
    expect((ann.state as Snap).ticks).toBe(MAX_CATCH_UP_TICKS + 1);
  });

  it('keeps going when a tick throws, and ends the room with "error" if it never stops throwing', () => {
    let fail = 3;
    const g = playGame(
      recorder({
        tick: (s) => {
          if (fail-- > 0) throw new Error('boom');
          s.ticks++;
        },
      }),
    );
    const ann = g.join('ann@test.dev');
    g.advance(500);
    expect((ann.state as Snap).ticks).toBe(7);
    expect(g.ended).toBeUndefined();

    const broken = playGame(recorder({ tick: () => { throw new Error('always'); } }));
    const bob = broken.join('bob@test.dev');
    broken.advance(5000);
    expect(broken.ended).toMatchObject({ reason: 'error' });
    expect(bob.over).toMatchObject({ reason: 'error' });
  });
});

describe('players', () => {
  it('calls onJoin and onLeave in order and keeps everyone told who is here', () => {
    const g = playGame(recorder());
    const ann = g.join('ann@test.dev');
    const bob = g.join('bob@test.dev');
    expect(ann.welcome).toMatchObject({ you: { id: 'u_ann_test_dev', name: 'ann' }, tickHz: 20, rejoined: false });
    expect(bob.welcome!.players.map((p) => p.name)).toEqual(['ann', 'bob']);
    expect(ann.roster.map((p) => p.name)).toEqual(['ann', 'bob']);
    ann.leave();
    const cy = g.join('cy@test.dev');
    g.advance(50);
    expect((cy.state as Snap).log).toEqual(['join ann', 'join bob', 'leave ann', 'join cy']);
    expect(bob.roster.map((p) => p.name)).toEqual(['bob', 'cy']);
    expect(ann.closed).toBe(true);
    expect(g.gone.map((p) => p.name)).toEqual(['ann']);
  });

  it('sends each player their own snapshot', () => {
    const g = playGame(recorder());
    const ann = g.join('ann@test.dev');
    const bob = g.join('bob@test.dev');
    g.advance(50);
    expect((ann.state as Snap).mine).toBe('secret-of-ann');
    expect((bob.state as Snap).mine).toBe('secret-of-bob');
    expect(JSON.stringify(ann.state)).not.toContain('secret-of-bob');
  });

  it('refuses a player over the limit, and the game can lower the manifest ceiling but not raise it', () => {
    const g = playGame(recorder({ maxPlayers: 2 }), { maxPlayers: 8 });
    g.join('a@test.dev');
    g.join('b@test.dev');
    expect(() => g.join('c@test.dev')).toThrow(/refused: full/);
    const capped = playGame(recorder({ maxPlayers: 16 }), { maxPlayers: 2 });
    expect(capped.host.maxPlayers).toBe(2);
  });

  it("restores a dropped player's slot when they rejoin within 20 s, with no onJoin or onLeave", () => {
    const g = playGame(recorder());
    const ann = g.join('ann@test.dev');
    const bob = g.join('bob@test.dev');
    ann.input({ x: 1 });
    ann.drop();
    g.advance(19_000);
    // Still in the room while away; nothing is sent to a dead connection.
    expect(bob.roster.map((p) => p.name)).toEqual(['ann', 'bob']);
    const before = ann.states.length;
    bob.input('keep-alive');
    ann.rejoin();
    expect(ann.welcome).toMatchObject({ rejoined: true });
    g.advance(50);
    expect(ann.states.length).toBe(before + 1);
    expect((ann.state as Snap).log).toEqual(['join ann', 'join bob']);
    // Their state came through: the input from before the drop is still counted.
    expect((ann.state as Snap).inputs).toBe(1);
    expect(g.gone).toEqual([]);
  });

  it('frees the slot when a dropped player stays away for 20 s', () => {
    const g = playGame(recorder(), { maxPlayers: 2 });
    const ann = g.join('ann@test.dev');
    const bob = g.join('bob@test.dev');
    ann.drop();
    g.advance(19_900);
    expect(() => g.join('cy@test.dev')).toThrow(/full/);
    g.advance(200);
    expect(bob.roster.map((p) => p.name)).toEqual(['bob']);
    expect((bob.state as Snap).log).toEqual(['join ann', 'join bob', 'leave ann']);
    expect(g.gone.map((p) => p.name)).toEqual(['ann']);
    // Coming back later is a fresh join.
    ann.rejoin();
    expect(ann.welcome).toMatchObject({ rejoined: false });
  });

  it('gives the slot to the newest connection when the same person connects twice', () => {
    const g = playGame(recorder());
    const tab1 = g.join('ann@test.dev');
    const tab2 = g.join('ann@test.dev');
    expect(tab1.closed).toBe(true);
    expect(tab2.welcome).toMatchObject({ rejoined: true });
    tab1.input('ghost');
    tab2.input('real');
    g.advance(50);
    expect((tab2.state as Snap).inputs).toBe(1);
    expect(g.host.players).toHaveLength(1);
  });
  it('gives one person a seat per device: onJoin for each, distinct ids, own snapshots, takeover per seat', () => {
    const g = playGame(recorder());
    const screen = g.join('ann@test.dev', { device: 'screen' });
    const gun = g.join('ann@test.dev', { device: 'gun' });
    expect([screen.id, gun.id]).toEqual(['u_ann_test_dev~screen', 'u_ann_test_dev~gun']);
    expect(gun.welcome).toMatchObject({ you: { id: 'u_ann_test_dev~gun', userId: 'u_ann_test_dev', device: 'gun', name: 'ann' }, rejoined: false });
    expect(screen.roster.map((p) => [p.device, p.userId])).toEqual([
      ['screen', 'u_ann_test_dev'],
      ['gun', 'u_ann_test_dev'],
    ]);
    gun.input('bang');
    g.advance(50);
    expect((screen.state as Snap).log).toEqual(['join ann', 'join ann']);
    expect([(screen.state as Snap).inputs, (gun.state as Snap).inputs]).toEqual([0, 1]);

    // A second gun takes the gun's seat; the screen is not touched.
    const gun2 = g.join('ann@test.dev', { device: 'gun' });
    expect([screen.closed, gun.closed, gun2.welcome?.rejoined]).toEqual([false, true, true]);
    expect(g.host.players.map((p) => p.id)).toEqual(['u_ann_test_dev~screen', 'u_ann_test_dev~gun']);
    // Leaving frees that seat only.
    gun2.leave();
    expect(g.gone.map((p) => p.id)).toEqual(['u_ann_test_dev~gun']);
    expect(g.host.players.map((p) => p.id)).toEqual(['u_ann_test_dev~screen']);
  });

  it('counts seats against maxPlayers and caps seats per person with maxSeatsPerUser', () => {
    const g = playGame(recorder({ maxPlayers: 2 }));
    g.join('ann@test.dev', { device: 'screen' });
    g.join('ann@test.dev', { device: 'gun' });
    expect(() => g.join('bob@test.dev')).toThrow(/refused: full/);

    const capped = playGame(recorder({ maxSeatsPerUser: 2 }));
    capped.join('ann@test.dev', { device: 'screen' });
    const gun = capped.join('ann@test.dev', { device: 'gun' });
    expect(() => capped.join('ann@test.dev', { device: 'gun-2' })).toThrow(/refused: seats/);
    gun.drop();
    gun.rejoin();
    expect(gun.welcome).toMatchObject({ rejoined: true });
    expect(() => capped.join('bob@test.dev', { device: 'screen' })).not.toThrow();
  });
});

describe('input and events', () => {
  it('limits input to 60 a second per player and drops the rest', () => {
    const g = playGame(recorder());
    const ann = g.join('ann@test.dev');
    const bob = g.join('bob@test.dev');
    for (let i = 0; i < 200; i++) ann.input(i);
    bob.input('one');
    g.advance(50);
    expect((ann.state as Snap).inputs).toBe(60);
    // One player flooding does not cost another their budget.
    expect((bob.state as Snap).inputs).toBe(1);
    // The budget refills with time: half a second is 30 more.
    g.advance(450);
    for (let i = 0; i < 200; i++) ann.input(i);
    g.advance(50);
    expect((ann.state as Snap).inputs).toBe(60 + 30);
  });

  it('honours the game\'s own rates', () => {
    const g = playGame(recorder({ inputsPerSecond: 5, eventsPerSecond: 2 }));
    const ann = g.join('ann@test.dev');
    for (let i = 0; i < 20; i++) ann.input(i);
    for (let i = 0; i < 20; i++) ann.event('x');
    g.advance(50);
    const state = ann.state as Snap;
    expect(state.inputs).toBe(5);
    expect(state.log.filter((l) => l.startsWith('event'))).toHaveLength(2);
  });

  it('ignores malformed, oversized and misdirected messages', () => {
    const g = playGame(recorder());
    const ann = g.join('ann@test.dev');
    ann.raw('state', 'not json');
    ann.raw('state', '"a string"');
    ann.raw('state', JSON.stringify({ nope: 1 }));
    ann.raw('state', JSON.stringify({ i: 'x'.repeat(5000) }));
    ann.raw('events', '{');
    ann.raw('events', JSON.stringify({ unknown: true }));
    g.advance(50);
    expect((ann.state as Snap).inputs).toBe(0);
    expect((ann.state as Snap).log).toEqual(['join ann']);
  });

  it('delivers events reliably: a bump reaches everyone, a whisper one player', () => {
    const g = playGame(recorder());
    const ann = g.join('ann@test.dev');
    const bob = g.join('bob@test.dev');
    ann.event('bump');
    bob.event('whisper');
    expect(ann.events).toEqual([{ shake: 'ann' }]);
    expect(bob.events).toEqual([{ shake: 'ann' }, { psst: true }]);
  });

  it('answers pings with the same stamp', () => {
    const g = playGame(recorder());
    const ann = g.join('ann@test.dev');
    ann.ping(12345);
    expect(ann.pongs).toEqual([12345]);
  });

  it('survives a handler that throws', () => {
    const g = playGame(recorder());
    const ann = g.join('ann@test.dev');
    ann.event('throw');
    ann.event('bump');
    expect(ann.events).toEqual([{ shake: 'ann' }]);
    expect(g.logs.join()).toMatch(/onEvent threw/);
  });
});

describe('ending', () => {
  it('ends after 10 minutes with no input, with "game over" to everyone', () => {
    const g = playGame(recorder({ results: (s) => ({ ticks: s.ticks }) }));
    const ann = g.join('ann@test.dev');
    g.advance(9 * 60_000);
    ann.input('still here');
    g.advance(9 * 60_000);
    expect(g.ended).toBeUndefined();
    g.advance(61_000);
    expect(g.ended).toMatchObject({ reason: 'idle', results: { ticks: expect.any(Number) } });
    expect(ann.over).toEqual(g.ended);
    // Nothing runs after the end.
    const ticks = (ann.state as Snap).ticks;
    g.advance(5000);
    expect((ann.state as Snap).ticks).toBe(ticks);
    expect(() => g.join('late@test.dev')).toThrow(/refused: ended/);
  });

  it('ends an empty room that nobody joins', () => {
    const g = playGame(recorder(), { idleMinutes: 1 });
    g.advance(61_000);
    expect(g.ended).toMatchObject({ reason: 'idle' });
  });

  it('ends at the total time limit however busy it is', () => {
    const g = playGame(recorder(), { maxHours: 0.25 });
    const ann = g.join('ann@test.dev');
    for (let minute = 0; minute < 15; minute++) {
      ann.input(minute);
      g.advance(60_000);
    }
    expect(g.ended).toMatchObject({ reason: 'time' });
    expect(ann.over).toMatchObject({ reason: 'time' });
  });

  it('lets the game end itself with results', () => {
    const g = playGame(recorder({ results: () => 'not used' }));
    const ann = g.join('ann@test.dev');
    const bob = g.join('bob@test.dev');
    bob.event('finish');
    expect(g.ended).toEqual({ reason: 'finished', results: { winner: 'u_bob_test_dev' } });
    expect(ann.over).toEqual(g.ended);
  });

  it('warns once about snapshots too big for one packet and never sends absurd ones', () => {
    const big = playGame(recorder({ snapshot: () => 'x'.repeat(2000) }));
    const ann = big.join('ann@test.dev');
    big.advance(200);
    expect(ann.states).toHaveLength(4);
    expect(big.logs.filter((l) => /split across packets/.test(l))).toHaveLength(1);

    const huge = playGame(recorder({ snapshot: () => 'x'.repeat(20_000) }));
    const bob = huge.join('bob@test.dev');
    huge.advance(200);
    expect(bob.states).toHaveLength(0);
  });
});

// A compile-time check that app code can type its room and players.
const _typed: (room: GameRoom<{ shake: string }>, p: GamePlayer) => void = (room, p) => room.send(p.id, { shake: p.name });
void _typed;
