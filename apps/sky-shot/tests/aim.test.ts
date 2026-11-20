import { describe, expect, it } from 'vitest';
import { Aim, aimAngles, fromEuler, IDENTITY, OneEuro, toEuler } from '../game/aim';
import type { Vec3 } from '../game/protocol';
import { applyTune, configId, DEFAULT_TUNING, type Tuning } from '../game/tuning';

const ASPECT = 16 / 9;
/** No smoothing lag, no prediction: the mapping alone. */
const exact: Tuning = { ...DEFAULT_TUNING, minCutoff: 10, beta: 3, prediction: 0, deadzone: 0 };
const still: Vec3 = [0, 0, 0];

/** Hold a pose for `ms` at 100 Hz, from server time `from`; returns the end time. */
function hold(aim: Aim, from: number, ms: number, q = IDENTITY, r: Vec3 = still, tuning = exact) {
  let t = from;
  for (; t < from + ms; t += 10) aim.update(t, q, r, tuning, ASPECT);
  return t;
}

describe('quaternions', () => {
  it('turn left (yaw +) points left, top edge up (pitch +) points up, in portrait and landscape', () => {
    expect(aimAngles(IDENTITY, fromEuler(0, 0, 0.2), 'portrait').h).toBeCloseTo(-0.2, 6);
    expect(aimAngles(IDENTITY, fromEuler(0, 0.15, 0), 'portrait').v).toBeCloseTo(0.15, 6);
    expect(aimAngles(IDENTITY, fromEuler(0, 0, 0.2), 'landscape').h).toBeCloseTo(-0.2, 6);
    // Relative to a reference pose, not to the world: the same turn from a pitched-up start.
    const ref = fromEuler(0, 0.4, 0);
    expect(aimAngles(ref, fromEuler(0, 0.5, 0), 'portrait').v).toBeCloseTo(0.1, 6);
  });

  it('round-trips CoreMotion Euler angles, with no flip near vertical', () => {
    for (const [roll, pitch, yaw] of [
      [0.3, -0.2, 1.1],
      [-1, 0.6, -2.5],
      [0.1, 1.5, 0.2],
    ] as const) {
      const e = toEuler(fromEuler(roll, pitch, yaw));
      expect([e.roll, e.pitch, e.yaw].map((n) => +n.toFixed(6))).toEqual([roll, pitch, yaw]);
    }
  });
});

describe('absolute mapping', () => {
  it('maps a known turn to a known crosshair: 0.5 + angle × gain (heights scale by the aspect)', () => {
    const aim = new Aim();
    aim.update(0, IDENTITY, still, exact, ASPECT);
    aim.update(10, fromEuler(0, 0.05, -0.1), [0, 0, -1], exact, ASPECT);
    expect(aim.current.rx).toBeCloseTo(0.5 + 0.1 * 1.6, 3);
    expect(aim.current.ry).toBeCloseTo(0.5 - 0.05 * 1.6 * ASPECT, 3);
  });

  it('calibrate makes the current pose the centre; offsets and inversion apply after', () => {
    const aim = new Aim();
    hold(aim, 0, 50, fromEuler(0, 0, 0.3));
    aim.calibrate();
    hold(aim, 100, 50, fromEuler(0, 0, 0.3));
    expect([aim.current.x, aim.current.y].map((n) => +n.toFixed(3))).toEqual([0.5, 0.5]);
    const shifted: Tuning = { ...exact, offsetX: 0.1, invertX: true };
    aim.update(200, fromEuler(0, 0, 0.2), [0, 0, -1], shifted, ASPECT);
    // Turned right by 0.1 rad: inverted, it moves left; then offset by +0.1.
    expect(aim.current.rx).toBeCloseTo(0.5 - 0.16 + 0.1, 3);
  });

  it('holds the crosshair still under the deadzone (tremor) and moves above it', () => {
    const aim = new Aim();
    const dz: Tuning = { ...exact, deadzone: 0.05 };
    hold(aim, 0, 50, IDENTITY, still, dz);
    aim.update(60, fromEuler(0, 0, -0.01), [0, 0, -0.02], dz, ASPECT);
    expect(aim.current.x).toBeCloseTo(0.5, 3);
    hold(aim, 70, 300, fromEuler(0, 0, -0.1), [0, 0, -1], dz);
    expect(aim.current.x).toBeCloseTo(0.66, 2);
  });
});

describe('relative mapping', () => {
  it('integrates the rotation rate times sensitivity, with the accel curve, clamped to the screen', () => {
    const rel: Tuning = { ...exact, mode: 'relative', accelCurve: 1 };
    const aim = new Aim();
    aim.update(0, IDENTITY, still, rel, ASPECT);
    // 1 rad/s to the right (yaw rate −1) for 100 ms: 0.1 rad × 1.2 widths/rad.
    hold(aim, 10, 100, IDENTITY, [0, 0, -1], rel);
    expect(aim.current.rx).toBeCloseTo(0.5 + 0.12, 2);
    // A steeper curve makes fast turns travel further than slow ones.
    const curved: Tuning = { ...rel, accelCurve: 2 };
    const fast = new Aim();
    fast.update(0, IDENTITY, still, curved, ASPECT);
    hold(fast, 10, 50, IDENTITY, [0, 0, -2], curved);
    const slow = new Aim();
    slow.update(0, IDENTITY, still, curved, ASPECT);
    hold(slow, 10, 100, IDENTITY, [0, 0, -1], curved);
    expect(fast.current.rx - 0.5).toBeGreaterThan(slow.current.rx - 0.5);
    // Never off the screen.
    hold(aim, 200, 3000, IDENTITY, [0, 0, -3], rel);
    expect(aim.current.rx).toBe(1);
  });
});

describe('hybrid mapping', () => {
  it('lets the reference drift to the current pose while the gun is still (recentring)', () => {
    const hy: Tuning = { ...exact, mode: 'hybrid', recentreRate: 1, fineGain: 0 };
    const aim = new Aim();
    aim.update(0, IDENTITY, still, hy, ASPECT);
    const turned = fromEuler(0, 0, -0.1);
    aim.update(10, turned, [0, 0, -1], hy, ASPECT);
    expect(aim.current.rx).toBeCloseTo(0.66, 2);
    hold(aim, 20, 5000, turned, still, hy);
    expect(aim.current.rx).toBeLessThan(0.51);
    // With no recentring it stays put.
    const fixed = new Aim();
    const none: Tuning = { ...hy, recentreRate: 0 };
    fixed.update(0, IDENTITY, still, none, ASPECT);
    hold(fixed, 10, 2000, turned, still, none);
    expect(fixed.current.rx).toBeCloseTo(0.66, 2);
  });
});

describe('smoothing, prediction, history', () => {
  it('one-euro smooths jitter at rest and follows fast moves', () => {
    const f = new OneEuro();
    let out = 0;
    for (let i = 0; i < 100; i++) out = f.filter(0.5 + (i % 2 ? 0.01 : -0.01), i / 100, 1, 0);
    expect(Math.abs(out - 0.5)).toBeLessThan(0.002);
  });

  it('prediction leads a moving crosshair; history answers "where was it at t"', () => {
    const lead: Tuning = { ...exact, prediction: 100 };
    const a = new Aim();
    const b = new Aim();
    for (let i = 0; i <= 30; i++) {
      const q = fromEuler(0, 0, -0.005 * i);
      a.update(i * 10, q, [0, 0, -0.5], exact, ASPECT);
      b.update(i * 10, q, [0, 0, -0.5], lead, ASPECT);
    }
    expect(b.current.x).toBeGreaterThan(a.current.x + 0.005);
    expect(a.at(150).x).toBeCloseTo((a.at(140).x + a.at(160).x) / 2, 3);
    expect(a.at(-1000)).toEqual(a.history[0]);
  });
});

describe('tuning', () => {
  it('clamps numbers, checks choices and flags, drops unknown keys; the id follows the content', () => {
    const t = applyTune(DEFAULT_TUNING, { fovGain: 99, mode: 'nope', trigger: 'flick', invertX: 'yes', bogus: 1, deadzone: Number.NaN });
    expect(t).toEqual({ ...DEFAULT_TUNING, fovGain: 5, trigger: 'flick' });
    expect(applyTune(DEFAULT_TUNING, null)).toBe(DEFAULT_TUNING);
    expect(configId(DEFAULT_TUNING)).toBe(configId({ ...DEFAULT_TUNING }));
    expect(configId(t)).not.toBe(configId(DEFAULT_TUNING));
    expect(configId(DEFAULT_TUNING)).toMatch(/^[0-9a-z]{7}$/);
  });
});
