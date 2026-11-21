import { describe, expect, it } from 'vitest';
import { playGame, type TestPlayer } from '@stacks/testing';
import { aimAngles, fromEuler, IDENTITY, OneEuro, qconj, rotate, turnRates } from '../game/aim';
import { CAL_POINTS, fitCalibration, meanPose } from '../game/calibrate';
import type { Quat, ServerEvent, Snapshot, WireSample } from '../game/protocol';
import { skyShot } from '../game/server';
import { DEFAULT_TUNING } from '../game/tuning';

const ASPECT = 16 / 10;
const PISTOL = Math.PI / 2;

/**
 * The pose that points at screen point (x, y) for a player whose true geometry is `g` widths/rad,
 * vertical `ratioY`, and whose centre is off by (ox, oy). `roll` is the grip (0 flat, π/2 pistol).
 */
function poseFor([x, y]: [number, number], g: number, ratioY: number, ox = 0, oy = 0, roll = 0): Quat {
  const h = (x - 0.5 - ox) / g;
  const v = -(y - 0.5 - oy) / (g * ratioY * ASPECT);
  return fromEuler(roll, v, -h);
}

describe('the grip does not matter', () => {
  it('pointer aim: turning right is right, raising is up, flat, upright like a pistol, or tilted', () => {
    for (const roll of [0, PISTOL, 0.5]) {
      const ref = fromEuler(roll, 0, 0);
      const right = aimAngles(ref, fromEuler(roll, 0, -0.2), 'portrait');
      expect(right.h).toBeCloseTo(0.2, 6);
      expect(right.v).toBeCloseTo(0, 6);
      expect(aimAngles(ref, fromEuler(roll, 0.15, 0), 'portrait').v).toBeCloseTo(0.15, 6);
    }
  });

  it('mouse-like aim: a turn about the room vertical reads as right, whatever the gyro axes', () => {
    for (const q of [IDENTITY, fromEuler(PISTOL, 0, 0), fromEuler(0.4, 0.3, 1)]) {
      const t = turnRates(q, rotate(qconj(q), [0, 0, -1]), 'portrait');
      expect(t.right).toBeCloseTo(1, 6);
      expect(t.up).toBeCloseTo(0, 6);
    }
  });

  it("the smoothing filter's speed is the input's, not its own lag (so prediction doesn't overshoot)", () => {
    const f = new OneEuro();
    // A ramp at 1 unit/s through a heavy filter: the speed estimate settles at 1.
    for (let i = 0; i <= 300; i++) f.filter(i / 100, i / 100, 0.3, 0);
    expect(f.velocity).toBeCloseTo(1, 1);
  });
});

describe('5-point calibration fit', () => {
  it('recovers gain, vertical gain and offsets from five poses, flat or pistol grip', () => {
    for (const roll of [0, PISTOL]) {
      const poses = CAL_POINTS.map((p) => poseFor(p, 1.4, 0.8, 0.03, -0.02, roll));
      // The first (centre) pose is off by the offset too: the fit treats it as the reference.
      const fit = fitCalibration(CAL_POINTS, poses, DEFAULT_TUNING, ASPECT)!;
      expect(fit.gain).toBeCloseTo(1.4, 2);
      expect(fit.ratioY).toBeCloseTo(0.8, 2);
      expect(fit.error).toBeLessThan(0.002);
      expect(fit.change).toMatchObject({ fovGain: fit.gain, sensitivity: fit.gain, invertX: false, invertY: false });
      expect(fit.change).toHaveProperty('offsetX');
    }
  });

  it('copes with a shaky hand, and leaves offsets alone in relative mode', () => {
    let seed = 3;
    const jiggle = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 0.02;
    const poses = CAL_POINTS.map(([x, y]) => poseFor([x + jiggle(), y + jiggle()], 0.9, 1));
    const fit = fitCalibration(CAL_POINTS, poses, { ...DEFAULT_TUNING, mode: 'relative' }, ASPECT)!;
    expect(fit.gain).toBeGreaterThan(0.8);
    expect(fit.gain).toBeLessThan(1);
    expect(fit.error).toBeLessThan(0.03);
    expect(fit.change).not.toHaveProperty('offsetX');
  });

  it('gives up when the phone barely moved, and averages poses across the q/−q sign flip', () => {
    expect(fitCalibration(CAL_POINTS, CAL_POINTS.map(() => IDENTITY), DEFAULT_TUNING, ASPECT)).toBeNull();
    const q = fromEuler(0, 0.1, 0.2);
    const m = meanPose([q, q.map((n) => -n) as Quat])!;
    expect(Math.abs(m[0] * q[0] + m[1] * q[1] + m[2] * q[2] + m[3] * q[3])).toBeCloseTo(1, 6);
  });
});

describe('5-point calibration in a room', () => {
  const ANN = 'ann@test.dev';
  function setup() {
    const g = playGame(skyShot({ seed: 1 }), { maxPlayers: 3 });
    const screen = g.join(ANN, { device: 'screen' }) as TestPlayer<Snapshot>;
    screen.event({ view: { aspect: ASPECT } });
    const p = g.join(ANN, { device: 'gun' }) as TestPlayer<Snapshot>;
    let seq = 0;
    let pose: Quat = IDENTITY;
    const recent: WireSample[] = [];
    const run = (ms: number) => {
      const end = g.now + ms;
      while (g.now < end) {
        // A small rotation rate keeps it above the deadzone (a real phone reports its turn).
        recent.push({ t: g.now / 1000, q: pose, r: [0, 0, 0.3], a: [0, 0, 0] });
        if (recent.length > 8) recent.shift();
        p.input({ seq: ++seq, t: g.now / 1000, rtt: 0, samples: [...recent] });
        g.advance(16);
      }
    };
    return { g, screen, phone: p, run, point: (q: Quat) => (pose = q) };
  }

  it('walks the five dots, applies the fit, and the crosshair then lands on where the phone points', () => {
    const t = setup();
    t.run(200);
    t.screen.event({ calibrate: 'points' });
    t.run(50);
    expect(t.screen.state!.cal).toEqual({ i: 0, pts: CAL_POINTS });
    for (const [k, p] of CAL_POINTS.entries()) {
      t.point(poseFor(p, 1.2, 0.9, 0, 0, PISTOL));
      t.run(400);
      // A tap during calibration marks the dot: it doesn't shoot.
      t.phone.event(k % 2 ? { shot: { t: t.g.now / 1000 } } : { calibrate: { t: t.g.now / 1000 } });
      t.run(50);
    }
    const events = t.screen.events as ServerEvent[];
    const done = events.map((e) => ('calibrated' in e ? e.calibrated : null)).find(Boolean)!;
    expect(done).toMatchObject({ poor: false });
    expect(done.gain).toBeCloseTo(1.2, 1);
    expect(done.ratioY).toBeCloseTo(0.9, 1);
    expect(events.some((e) => 'hit' in e || 'miss' in e)).toBe(false);
    expect(t.screen.state!.cal).toBeUndefined();
    // Now point at a spot: the crosshair goes there (no smoothing in the way once still).
    t.point(poseFor([0.3, 0.7], 1.2, 0.9, 0, 0, PISTOL));
    t.run(1500);
    const g = t.screen.state!.g[0]!;
    expect(g.x).toBeCloseTo(0.3, 1);
    expect(g.y).toBeCloseTo(0.7, 1);
  });

  it('needs a phone, and can be cancelled', () => {
    const g = playGame(skyShot({ seed: 1 }), { maxPlayers: 3 });
    const screen = g.join(ANN, { device: 'screen' }) as TestPlayer<Snapshot>;
    screen.event({ calibrate: 'points' });
    g.advance(50);
    expect(screen.events).toContainEqual({ calibrationFailed: { reason: 'Pair a phone first.' } });
    const t = setup();
    t.run(100);
    t.screen.event({ calibrate: 'points' });
    t.run(50);
    expect(t.screen.state!.cal).toBeTruthy();
    t.screen.event({ calibrate: 'cancel' });
    t.run(50);
    expect(t.screen.state!.cal).toBeUndefined();
  });
});

