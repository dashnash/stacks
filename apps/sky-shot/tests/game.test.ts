import { describe, expect, it } from 'vitest';
import { playGame, type TestPlayer } from '@stacks/testing';
import { fromEuler } from '../game/aim';
import { MAX_RESULTS_BYTES, MAX_SHOTS, type Results, type ServerEvent, type Snapshot, type WireSample } from '../game/protocol';
import { quotaFor, skyShot, SHOTS_PER_RELEASE } from '../game/server';

const ANN = 'ann@test.dev';
type Player = TestPlayer<Snapshot>;

function setup(seed = 7) {
  const g = playGame(skyShot({ seed }), { maxPlayers: 3 });
  const screen = g.join(ANN, { device: 'screen' }) as Player;
  /** The screen reports it draws what the server just sent (no lag), so tests reason about one clock. */
  const noLag = () => {
    // Spread out: the screen may send 30 events a second.
    for (let i = 0; i < 25; i++) {
      screen.event({ ack: { shown: g.now, rtt: 0 } });
      g.advance(40);
    }
  };
  const events = (p: Player) => p.events as ServerEvent[];
  const of = <K extends string>(p: Player, key: K) => events(p).filter((e) => key in e).map((e) => (e as Record<K, unknown>)[key]);
  return { g, screen, noLag, events, of };
}

/** A mouse seat, its clock the server's (t in seconds = server ms / 1000). */
function mouse(g: ReturnType<typeof playGame>, who = ANN) {
  const m = g.join(who, { device: 'mouse' }) as Player;
  let seq = 0;
  return {
    seat: m,
    point: (x: number, y: number) => m.input({ seq: ++seq, t: g.now / 1000, rtt: 0, p: [x, y] }),
    shoot: (atMs = g.now) => m.event({ shot: { t: atMs / 1000 } }),
  };
}

/** A phone gun: sends its last 8 samples every 16 ms, like the controller page. */
function phone(g: ReturnType<typeof playGame>, who = ANN, device = 'gun') {
  const p = g.join(who, { device }) as Player;
  let seq = 0;
  const recent: WireSample[] = [];
  let pose = { yaw: 0, pitch: 0 };
  let accel: [number, number, number] = [0, 0, 0];
  const sample = () => {
    const q = fromEuler(0, pose.pitch, pose.yaw);
    recent.push({ t: g.now / 1000, q, r: [0, 0, 0.3], a: accel });
    if (recent.length > 8) recent.shift();
    p.input({ seq: ++seq, t: g.now / 1000, rtt: 0, samples: [...recent] });
  };
  return {
    seat: p,
    aim: (yaw: number, pitch = 0) => (pose = { yaw, pitch }),
    jolt: (a: [number, number, number]) => (accel = a),
    /** Stream for `ms`. */
    run(ms: number) {
      const end = g.now + ms;
      while (g.now < end) {
        sample();
        g.advance(16);
      }
    },
  };
}

const target = (screen: Player) => screen.state!.tg.find((t) => t.s === 0)!;

describe('Whee: seats', () => {
  it('a screen and a gun of one person are two seats; the screen alone gets latency and motion', () => {
    const { g, screen } = setup();
    const gun = phone(g);
    gun.run(100);
    expect(g.host.players.map((p) => p.device)).toEqual(['screen', 'gun']);
    expect(screen.state!.g).toHaveLength(1);
    expect(screen.state!.lat).toBeDefined();
    expect(screen.state!.mo).toBeDefined();
    expect(gun.seat.state!.lat).toBeUndefined();
    // Both got the tuning on joining.
    expect(gun.seat.events.some((e) => 'tuning' in (e as object))).toBe(true);
  });

  it('takes two guns with their own colours and ignores a third', () => {
    const { g, screen } = setup();
    phone(g, ANN, 'gun').run(50);
    phone(g, 'bob@test.dev', 'gun').run(50);
    expect(screen.state!.g.map((x) => x.c)).toEqual([0, 1]);
    expect(() => g.join('cy@test.dev', { device: 'gun' })).toThrow(/full/);
  });

  it('keeps a dropped gun (and its calibration) when it rejoins within 20 s', () => {
    const { g, screen } = setup();
    const gun = phone(g);
    gun.aim(0.3);
    gun.run(100);
    gun.seat.event({ calibrate: { t: g.now / 1000 } });
    gun.run(100);
    expect(screen.state!.g[0]!.x).toBeCloseTo(0.5, 2);
    gun.seat.drop();
    g.advance(5000);
    expect(screen.state!.g).toHaveLength(1);
    gun.seat.rejoin();
    expect(gun.seat.welcome?.rejoined).toBe(true);
    gun.run(100);
    expect(screen.state!.g[0]!.x).toBeCloseTo(0.5, 2);
  });
});

describe('Whee: hits, lag compensation and triggers', () => {
  /** Range with a target sweeping at 0.5 screen heights a second. */
  function sweeping() {
    const t = setup();
    t.screen.event({ mode: 'range' });
    t.screen.event({ range: { kind: 'sweep', speed: 2 } });
    t.screen.event({ start: true });
    t.noLag();
    const m = mouse(t.g);
    m.point(0, 0);
    t.g.advance(500);
    return { ...t, m };
  }

  it('hits a fast target where the screen showed it, 150 ms before the shot arrived', () => {
    const { g, screen, m, of } = sweeping();
    const seen = target(screen);
    const fired = g.now;
    m.point(seen.x, seen.y);
    g.advance(150);
    // By now the target has moved 0.075 screen heights, more than its hitbox.
    expect(Math.abs(target(screen).x - seen.x) * (16 / 9)).toBeGreaterThan(0.06);
    m.shoot(fired);
    const hits = of(screen, 'hit') as { target: number; rw: number }[];
    expect(hits.map((h) => h.target)).toEqual([seen.id]);
    expect(Math.abs(hits[0]!.rw - 150)).toBeLessThanOrEqual(2);
  });

  it('misses it with no rewind allowed, or when the shot is later than maxRewindMs', () => {
    for (const [maxRewindMs, lateMs] of [
      [0, 150],
      [250, 400],
    ]) {
      const { g, screen, m, of } = sweeping();
      screen.event({ tune: { maxRewindMs } });
      const seen = target(screen);
      const fired = g.now;
      m.point(seen.x, seen.y);
      g.advance(lateMs!);
      m.shoot(fired);
      expect(of(screen, 'hit')).toEqual([]);
      expect(of(screen, 'miss')).toEqual([expect.objectContaining({ rw: maxRewindMs })]);
    }
  });

  it("tests against the screen's own lag: the target as drawn, not as the server has it", () => {
    const { g, screen, m, of } = sweeping();
    // The screen says it draws 120 ms behind the server.
    for (let i = 0; i < 25; i++) {
      screen.event({ ack: { shown: g.now - 120, rtt: 0 } });
      g.advance(40);
    }
    const seen = target(screen);
    m.point(seen.x, seen.y);
    g.advance(120);
    // Fired now, at what the screen drew now: the target as it was 120 ms ago.
    m.shoot(g.now);
    expect(of(screen, 'hit')).toHaveLength(1);
  });

  it('fires on a flick and aims with the crosshair from before the jolt', () => {
    const { g, screen, noLag, of } = setup();
    screen.event({ tune: { trigger: 'flick', flickThreshold: 1.5, flickLookbackMs: 80, prediction: 0 } });
    screen.event({ mode: 'range' });
    screen.event({ start: true });
    noLag();
    const gun = phone(g);
    gun.run(300);
    gun.seat.event({ calibrate: { t: g.now / 1000 } });
    gun.aim(-0.1); // aimed right of centre
    gun.run(300);
    // The jolt throws the aim up and left as the spike arrives.
    gun.aim(0.2, 0.2);
    gun.jolt([0, 2.5, 0]);
    gun.run(16);
    gun.jolt([0, 0, 0]);
    gun.run(100);
    const shots = [...of(screen, 'hit'), ...of(screen, 'miss')] as { x: number; y: number }[];
    expect(shots).toHaveLength(1);
    expect(shots[0]!.x).toBeGreaterThan(0.6);
    expect(shots[0]!.y).toBeCloseTo(0.5, 1);
    // Cooldown: the spike's tail doesn't fire twice; a tap does nothing in flick mode.
    gun.seat.event({ shot: { t: g.now / 1000 } });
    g.advance(50);
    expect([...of(screen, 'hit'), ...of(screen, 'miss')]).toHaveLength(1);
  });

  it('ignores taps in flick mode but not mouse clicks, and debounces taps', () => {
    const { g, screen, noLag, of } = setup();
    screen.event({ mode: 'range' });
    screen.event({ start: true });
    noLag();
    const gun = phone(g);
    gun.run(100);
    gun.seat.event({ shot: { t: g.now / 1000 } });
    gun.seat.event({ shot: { t: g.now / 1000 + 0.01 } });
    g.advance(20);
    expect(of(screen, 'miss').length + of(screen, 'hit').length).toBe(1);
  });
});

describe('Whee: Rounds', () => {
  /** Shoot the first flying target dead centre (a mouse that knows where it is). */
  function hitOne(t: ReturnType<typeof setup>, m: ReturnType<typeof mouse>) {
    const tg = target(t.screen);
    m.point(tg.x, tg.y);
    m.shoot();
    t.g.advance(100);
  }

  it('releases 10 targets with 3 shots each, advances on the quota, and ends on a missed one', () => {
    const t = setup(3);
    t.noLag();
    const m = mouse(t.g);
    m.point(0, 0);
    t.screen.event({ start: true });
    t.g.advance(50);
    expect(t.of(t.screen, 'roundStart')).toEqual([{ round: 1, quota: quotaFor(1) }]);
    expect(t.screen.state).toMatchObject({ ph: 'playing', rd: 1, sl: SHOTS_PER_RELEASE, q: 6 });

    // Round 1: hit every target as it comes.
    for (let guard = 0; guard < 400 && t.screen.state!.ph === 'playing'; guard++) {
      if (t.screen.state!.tg.some((x) => x.s === 0)) hitOne(t, m);
      else t.g.advance(100);
    }
    const end1 = t.of(t.screen, 'roundEnd')[0] as { passed: boolean; hits: number; bonus: number };
    expect(end1).toMatchObject({ round: 1, hits: 10, passed: true });
    expect(end1.bonus).toBe(300);
    t.g.advance(3000);
    expect(t.screen.state).toMatchObject({ ph: 'playing', rd: 2, q: 7 });
    expect(t.screen.state!.sc).toBeGreaterThanOrEqual(10 * 100 + 300);

    // Round 2: never hit anything. Three misses use the release up and the targets fly off.
    for (let guard = 0; guard < 600 && t.screen.state!.ph === 'playing'; guard++) {
      if (t.screen.state!.sl > 0 && t.screen.state!.tg.some((x) => x.s === 0)) {
        m.point(0.01, 0.99);
        m.shoot();
      }
      t.g.advance(100);
    }
    expect(t.of(t.screen, 'roundEnd')[1]).toMatchObject({ round: 2, hits: 0, passed: false, bonus: 0 });
    t.g.advance(3000);
    expect(t.screen.state!.ph).toBe('over');
    expect(t.of(t.screen, 'gameOver')[0]).toMatchObject({ mode: 'rounds', rounds: 2, hits: 10, shooterName: 'ann' });
    // A shot with none left says so.
  }, 20_000);

  it('freezes while paused (the tuning panel is open) and refuses shots with none left', () => {
    const t = setup(5);
    t.noLag();
    const m = mouse(t.g);
    m.point(0.01, 0.99);
    t.screen.event({ start: true });
    t.g.advance(300);
    const before = target(t.screen);
    t.screen.event({ pause: true });
    t.g.advance(2000);
    expect(target(t.screen)).toEqual(before);
    t.screen.event({ pause: false });
    for (let i = 0; i < 4; i++) {
      m.shoot();
      t.g.advance(100);
    }
    expect(t.of(t.screen, 'miss')).toHaveLength(3);
    expect(t.of(t.screen, 'empty')).toHaveLength(1);
  });
});

describe('Whee: results', () => {
  it('records games, shots with their motion window and config, capped by count and by size', () => {
    const t = setup();
    t.screen.event({ mode: 'range' });
    t.screen.event({ start: true });
    t.noLag();
    const gun = phone(t.g);
    gun.run(400);
    for (let i = 0; i < MAX_SHOTS + 100; i++) {
      gun.seat.event({ shot: { t: t.g.now / 1000 } });
      gun.run(96);
    }
    t.screen.event({ tune: { mode: 'relative' } });
    t.screen.event({ finish: true });
    const results = t.g.ended!.results as Results;
    const bytes = new TextEncoder().encode(JSON.stringify(results)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_RESULTS_BYTES);
    expect(results.shots.length).toBeLessThanOrEqual(MAX_SHOTS);
    expect(results.shots.length + results.droppedShots).toBe(MAX_SHOTS + 100);
    const shot = results.shots.at(-1)!;
    expect(shot).toMatchObject({ trigger: 'tap', mode: 'range', shooterId: 'u_ann_test_dev' });
    // −300 … +100 ms at 25 Hz, 4 significant digits.
    expect(shot.window.length).toBeGreaterThanOrEqual(9);
    expect(shot.window[0]![0]).toBeLessThanOrEqual(-280);
    expect(shot.window.at(-1)![0]).toBeGreaterThanOrEqual(80);
    for (const n of shot.window.flat()) expect(Number(n.toPrecision(4))).toBe(n);
    // Configs stored once, by id; the open Range game is in the results.
    expect(Object.keys(results.configs)).toEqual([shot.configId]);
    expect(results.games).toEqual([expect.objectContaining({ mode: 'range', shots: MAX_SHOTS + 100 })]);
  }, 30_000);
});

describe('Whee: the look', () => {
  it('tells every seat the screen\'s look, on joining and when it changes; shots and games record it', () => {
    const t = setup();
    expect(t.of(t.screen, 'theme')).toEqual([{ id: 'dusk', palette: 'dusk' }]);
    t.screen.event({ mode: 'range' });
    t.screen.event({ start: true });
    t.noLag();
    const gun = phone(t.g);
    gun.run(100);
    expect(t.of(gun.seat, 'theme')).toEqual([{ id: 'dusk', palette: 'dusk' }]);
    t.screen.event({ theme: { id: 'dusk', palette: 'dusk' } });
    expect(t.of(gun.seat, 'theme')).toHaveLength(2);
    // Only the screen sets it, and only to a look that exists.
    gun.seat.event({ theme: { id: 'dusk', palette: 'dusk' } });
    for (const theme of [{ id: 'nope', palette: 'dusk' }, { id: 'dusk', palette: 'nope' }, 'dusk', null]) t.screen.event({ theme });
    expect(t.of(gun.seat, 'theme')).toHaveLength(2);

    gun.seat.event({ shot: { t: t.g.now / 1000 } });
    gun.run(400);
    t.screen.event({ finish: true });
    const results = t.g.ended!.results as Results;
    expect(results.shots.map((s) => s.theme)).toEqual(['dusk/dusk']);
    expect(results.games.map((g) => g.theme)).toEqual(['dusk/dusk']);
  });
});
