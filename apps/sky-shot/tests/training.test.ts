import { describe, expect, it } from 'vitest';
import { playGame, type TestPlayer } from '@stacks/testing';
import { Aim, fromEuler, IDENTITY, qconj, rotate, turnRates } from '../game/aim';
import { MIN_JUMPS, runFit, SHAKE_BUDGET } from '../game/fit';
import { MAX_RESULTS_BYTES, type Quat, type Results, type ServerEvent, type Snapshot, type Vec3, type WireSample } from '../game/protocol';
import { skyShot } from '../game/server';
import { scriptMs, trainingScript } from '../game/training';
import { DEFAULT_TUNING, type Tuning } from '../game/tuning';
import { simulateRun, step, worldRate, type Hand } from './sim';

const ANN = 'ann@test.dev';

const ASPECT = 16 / 10;
const script = trainingScript(42, ASPECT);
/** What the player feels is right: slower than the default, a steeper curve, less vertical. */
const feel: Hand['feel'] = { sensitivity: 0.7, accelCurve: 1.45, ratioY: 0.8 };

describe('turning, whatever the grip', () => {
  it('turning the barrel right reads as right whether the phone is flat, upright like a pistol, or tilted', () => {
    // Pistol grip (screen facing left): a turn about the room's vertical is about the phone's own
    // x axis, which a device-axis mapping reads as tilting.
    for (const q of [IDENTITY, fromEuler(Math.PI / 2, 0, 0), fromEuler(0.4, 0.3, 1)]) {
      const right = turnRates(q, rotate(qconj(q), [0, 0, -1]), 'portrait');
      expect(right.right).toBeCloseTo(1, 6);
      expect(right.up).toBeCloseTo(0, 6);
    }
    // Raising the barrel: about the horizontal axis across it.
    const pistol = fromEuler(Math.PI / 2, 0, 0);
    expect(turnRates(pistol, rotate(qconj(pistol), [1, 0, 0]), 'portrait').up).toBeCloseTo(1, 6);
  });
});

describe('the training script', () => {
  it('is 16 trials of about a minute: 12 jumps, 2 tracks, 2 holds, all on screen', () => {
    expect(script).toHaveLength(16);
    expect(script[0]!.kind).toBe('hold');
    const count = (k: string) => script.filter((t) => t.kind === k).length;
    expect([count('jump'), count('track'), count('hold')]).toEqual([12, 2, 2]);
    expect(scriptMs(script)).toBeGreaterThan(50_000);
    expect(scriptMs(script)).toBeLessThan(62_000);
    for (const t of script) for (const p of [t.a, t.b].filter(Boolean)) {
      expect(p![0]).toBeGreaterThanOrEqual(0.09);
      expect(p![0]).toBeLessThanOrEqual(0.91);
    }
    // Same seed, same script.
    expect(trainingScript(42, ASPECT)).toEqual(script);
  });
});

describe('fitting', () => {
  const close = (got: number, want: number, within: number) => expect(Math.abs(got - want) / want).toBeLessThan(within);

  it('recovers the gain, curve and vertical gain a player feels, from the hidden jumps', () => {
    // Played in the default relative mode (1.2 widths/rad): too fast for this player.
    const report = runFit(simulateRun(script, { feel }, { aspect: ASPECT, base: { ...DEFAULT_TUNING, mode: 'relative' } }));
    expect(report.usedJumps).toBeGreaterThanOrEqual(10);
    expect(report.fitted.mode).toBe('relative');
    close(report.fitted.sensitivity, feel.sensitivity, 0.12);
    close(report.fitted.accelCurve, feel.accelCurve, 0.08);
    close(report.fitted.ratioY, feel.ratioY, 0.1);
    expect(report.fitted.invertX || report.fitted.invertY).toBe(false);
    // The default moves too far for this player; the fit lands jumps far closer.
    expect(report.before.gain).toBeGreaterThan(1.3);
    expect(report.after.gain).toBeGreaterThan(0.85);
    expect(report.after.gain).toBeLessThan(1.15);
    expect(report.after.jumpErr).toBeLessThan(report.before.jumpErr / 2);
  });

  it('does the same with the phone held upright like a pistol', () => {
    const report = runFit(simulateRun(script, { feel, pistol: true, seed: 3 }, { aspect: ASPECT }));
    close(report.fitted.sensitivity, feel.sensitivity, 0.12);
    close(report.fitted.accelCurve, feel.accelCurve, 0.08);
  });

  it('cuts lag as far as it can while shake stays under the budget: less smoothing for a steadier hand', () => {
    const base: Tuning = { ...DEFAULT_TUNING, mode: 'relative', ...feel };
    const steady = runFit(simulateRun(script, { feel, tremor: 0.05, seed: 11 }, { aspect: ASPECT, latencyMs: 70, base }));
    const shaky = runFit(simulateRun(script, { feel, tremor: 0.3, seed: 11 }, { aspect: ASPECT, latencyMs: 70, base }));
    for (const r of [steady, shaky]) {
      expect(r.after.lagMs).toBeLessThan(r.before.lagMs - 30);
      expect(r.after.jitter).toBeLessThan(SHAKE_BUDGET * 1.1);
    }
    expect(steady.fitted.minCutoff).toBeGreaterThan(shaky.fitted.minCutoff);
    expect(steady.after.lagMs).toBeLessThan(shaky.after.lagMs);
  });

  it('skips the gain with too few usable jumps, and keeps every non-aim knob', () => {
    const base: Tuning = { ...DEFAULT_TUNING, trigger: 'flick', flickThreshold: 2.2, hitboxScale: 1.4 };
    const rec = simulateRun(script, { feel }, { aspect: ASPECT, base });
    rec.trials = rec.trials.filter((t) => t.kind !== 'jump').concat(rec.trials.filter((t) => t.kind === 'jump').slice(0, 3));
    rec.trials.sort((a, b) => a.t0 - b.t0);
    const report = runFit(rec);
    expect(report.usedJumps).toBeLessThan(MIN_JUMPS);
    expect(report.fitted.sensitivity).toBe(base.sensitivity);
    expect(report.fitted).toMatchObject({ trigger: 'flick', flickThreshold: 2.2, hitboxScale: 1.4 });
  });

  it('replays through the same Aim the game uses (place puts a relative crosshair on its dot)', () => {
    const aim = new Aim();
    const rel: Tuning = { ...DEFAULT_TUNING, mode: 'relative', minCutoff: 10, beta: 0, prediction: 0 };
    aim.update(0, IDENTITY, [0, 0, 0], rel, ASPECT);
    aim.place(0.2, 0.7);
    const p = aim.update(10, IDENTITY, [0, 0, 0], rel, ASPECT);
    expect([p.x, p.y]).toEqual([0.2, 0.7]);
  });
});

describe('training in a room', () => {
  /**
   * A phone bot that plays the script from the screen's snapshot: it keeps its own idea of where the
   * crosshair is (by `feel`), knows it starts each trial on the dot, and steers toward the dot. It
   * never looks at the real crosshair, so what it does is its feel and nothing else.
   */
  function bot(g: ReturnType<typeof playGame>, screen: TestPlayer<Snapshot>, aspect: number) {
    const p = g.join(ANN, { device: 'gun' }) as TestPlayer<Snapshot>;
    p.event({ menu: { calSkip: true } });
    let seq = 0;
    let q: Quat = fromEuler(Math.PI / 2, 0, 0); // pistol grip
    const recent: WireSample[] = [];
    let belief: [number, number] = [0.5, 0.5];
    let last = '';
    let r: Vec3 = [0, 0, 0];
    const seen: string[] = [];
    return {
      seat: p,
      seen,
      run(ms: number) {
        const end = g.now + ms;
        while (g.now < end) {
          const tr = screen.state?.tr;
          let right = 0;
          let up = 0;
          if (tr && ['jump', 'track', 'hold'].includes(tr.k)) {
            const key = `${tr.i}:${tr.k}:${tr.show}`;
            if (key !== last) {
              // A trial starts, or a jump's B appears: the crosshair was put on the start dot.
              if (!last.startsWith(`${tr.i}:`) || !tr.show) belief = tr.ax !== undefined ? [tr.ax, tr.ay!] : [tr.x, tr.y];
              last = key;
              seen.push(`${tr.k}${tr.show ? '' : ' (hidden)'}`);
            }
            const vx = (tr.x - belief[0]) * 8;
            const vy = (tr.y - belief[1]) * 8;
            const sx = vx;
            const sy = -vy / (feel.ratioY * aspect);
            const speed = Math.hypot(sx, sy);
            if (speed > 1e-6) {
              const w = Math.pow(speed / feel.sensitivity, 1 / feel.accelCurve);
              right = (w * sx) / speed;
              up = (w * sy) / speed;
              // What the bot believes that did (its feel), over one step.
              belief = [belief[0] + vx * 0.016, belief[1] + vy * 0.016];
            }
          }
          const s = step(q, worldRate(q, right, up), 0.016);
          q = s.q;
          r = s.r;
          recent.push({ t: g.now / 1000, q, r, a: [0, 0, 0] });
          if (recent.length > 8) recent.shift();
          p.input({ seq: ++seq, t: g.now / 1000, rtt: 0, samples: [...recent] });
          g.advance(16);
        }
      },
    };
  }

  it('runs the script, hides the crosshair while a jump is made, fits, and keeps the run in the results', () => {
    const g = playGame(skyShot({ seed: 5 }), { maxPlayers: 3 });
    const screen = g.join(ANN, { device: 'screen' }) as TestPlayer<Snapshot>;
    screen.event({ view: { aspect: ASPECT } });
    screen.event({ mode: 'training' });
    const phone = bot(g, screen, ASPECT);
    phone.run(200);
    expect(screen.state!.tr).toMatchObject({ k: 'ready', n: 16 });
    screen.event({ start: true });
    phone.run(200);
    // The game's calibration runs first, both passes; skipping it (or finishing it) starts the script.
    expect(screen.state!.cal).toMatchObject({ gun: phone.seat.id, st: 'init' });
    expect(screen.state!.tr!.k).toBe('ready');
    phone.seat.event({ menu: { calSkip: true } });
    phone.run(70_000);
    for (let i = 0; i < 400 && screen.state!.tr!.k !== 'done'; i++) g.advance(100);
    expect(phone.seen).toContain('jump (hidden)');
    expect(phone.seen).toContain('track');
    // The phone can't shoot during training.
    phone.seat.event({ shot: { t: g.now / 1000 } });
    const events = screen.events as ServerEvent[];
    expect(events.some((e) => 'hit' in e || 'miss' in e)).toBe(false);
    const report = events.map((e) => ('trained' in e ? e.trained : null)).find(Boolean)!;
    expect(report).toBeTruthy();
    expect(report.usedJumps).toBeGreaterThanOrEqual(9);
    expect(Math.abs(report.fitted.sensitivity - feel.sensitivity) / feel.sensitivity).toBeLessThan(0.15);
    expect(Math.abs(report.fitted.accelCurve - feel.accelCurve)).toBeLessThan(0.15);
    expect(report.after.jumpErr).toBeLessThan(report.before.jumpErr);

    screen.event({ finish: true });
    const results = g.ended!.results as Results;
    expect(results.training).toHaveLength(1);
    const run = results.training![0]!;
    expect(run).toMatchObject({ shooterId: 'u_ann_test_dev', aspect: ASPECT });
    expect(run.trials).toHaveLength(16);
    // About 25 Hz for the whole run (this phone sends every 16 ms, so every third sample).
    expect(run.raw.length).toBeGreaterThan(1000);
    expect(JSON.stringify(results).length).toBeLessThanOrEqual(MAX_RESULTS_BYTES);
  }, 60_000);

  it('needs a phone: with none (or only a mouse) it says so and stays ready', () => {
    const g = playGame(skyShot({ seed: 5 }), { maxPlayers: 3 });
    const screen = g.join(ANN, { device: 'screen' }) as TestPlayer<Snapshot>;
    g.join(ANN, { device: 'mouse' });
    screen.event({ mode: 'training' });
    screen.event({ start: true });
    g.advance(100);
    expect(screen.events).toContainEqual({ trainFailed: { reason: expect.stringContaining('phone') } });
    expect(screen.state!.tr!.k).toBe('ready');
  });
});
