/**
 * Five-point calibration. The screen shows a dot at the centre and then near each corner. The player
 * points the phone at each one and taps. From the five poses, a least-squares fit per axis finds how
 * far the crosshair should move per radian of turn (the gain), the vertical gain relative to the
 * horizontal, and the offsets. The centre pose becomes the reference.
 *
 * The same gain sets both mappings. Absolute and hybrid use it as the turn gain (`fovGain`), so the
 * crosshair sits where the phone points. Relative uses it as the sensitivity, which is the gain at a
 * turn speed of 1 rad/s (the accel curve still makes slow moves finer and fast ones go further).
 */
import { aimAngles, qnorm } from './aim';
import type { Quat } from './protocol';
import { applyTune, type Tuning } from './tuning';

/** Where the dots go (x in screen widths, y in heights): the centre first, then the corners. */
export const CAL_POINTS: [number, number][] = [
  [0.5, 0.5],
  [0.15, 0.2],
  [0.85, 0.2],
  [0.85, 0.8],
  [0.15, 0.8],
];

/** The pose at a tap is the mean over this window before it, which leaves out the jolt of the tap itself. */
export const POSE_FROM_MS = 250;
export const POSE_TO_MS = 50;
/** Points that miss the fit by more than this (screen heights, on average) suggest trying again. */
export const CAL_POOR = 0.06;

/** The mean of nearby attitudes (they are close together, so a normalised sum will do). */
export function meanPose(qs: Quat[]): Quat | null {
  if (!qs.length) return null;
  const first = qs[0]!;
  const sum: Quat = [0, 0, 0, 0];
  for (const q of qs) {
    // q and −q are the same attitude: keep them all on one side.
    const sign = q[0] * first[0] + q[1] * first[1] + q[2] * first[2] + q[3] * first[3] < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) sum[k] = sum[k]! + sign * q[k]!;
  }
  return qnorm(sum);
}

export interface CalibrationResult {
  /** Screen widths per radian. */
  gain: number;
  ratioY: number;
  offsetX: number;
  offsetY: number;
  invertX: boolean;
  invertY: boolean;
  /** Mean distance from each dot to where the fit puts the crosshair, screen heights. */
  error: number;
  /** The tuning change to send (`{ tune }`). */
  change: Partial<Tuning>;
}

/** Slope and intercept of y ≈ a + b·x by least squares. */
function line(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/**
 * Fit the poses taken at `points` (the first one is the centre and becomes the reference). Returns
 * null if the phone barely turned (so no gain can be read).
 */
export function fitCalibration(points: [number, number][], poses: Quat[], tuning: Tuning, aspect: number): CalibrationResult | null {
  if (poses.length < 3 || poses.length !== points.length) return null;
  const ref = poses[0]!;
  const angles = poses.map((q) => aimAngles(ref, q, tuning.orientation));
  const h = angles.map((a) => a.h);
  const v = angles.map((a) => a.v);
  if (Math.max(...h) - Math.min(...h) < 0.02 || Math.max(...v) - Math.min(...v) < 0.02) return null;
  // x = 0.5 + offsetX + gain·h·(invertX ? −1 : 1)
  // y = 0.5 + offsetY − gain·ratioY·aspect·v·(invertY ? −1 : 1)
  const fx = line(h, points.map((p) => p[0] - 0.5));
  const fy = line(v, points.map((p) => p[1] - 0.5));
  const proposed = {
    fovGain: Math.abs(fx.b),
    sensitivity: Math.abs(fx.b),
    ratioY: Math.abs(fy.b) / Math.max(1e-6, Math.abs(fx.b) * aspect),
    offsetX: fx.a,
    offsetY: fy.a,
    invertX: fx.b < 0,
    invertY: fy.b > 0,
  };
  // Clamp to the knobs' ranges, then measure the error with what will actually be used.
  const t = applyTune(tuning, proposed);
  const sx = t.invertX ? -1 : 1;
  const sy = t.invertY ? -1 : 1;
  let error = 0;
  points.forEach(([px, py], k) => {
    const x = 0.5 + t.offsetX + t.fovGain * h[k]! * sx;
    const y = 0.5 + t.offsetY - t.fovGain * t.ratioY * aspect * v[k]! * sy;
    error += Math.hypot((x - px) * aspect, y - py);
  });
  // Relative aim has no fixed centre: an offset would only shrink the reachable screen.
  const change: Partial<Tuning> = {
    fovGain: t.fovGain,
    sensitivity: t.sensitivity,
    ratioY: t.ratioY,
    invertX: t.invertX,
    invertY: t.invertY,
    ...(tuning.mode === 'relative' ? {} : { offsetX: t.offsetX, offsetY: t.offsetY }),
  };
  return { gain: t.fovGain, ratioY: t.ratioY, offsetX: t.offsetX, offsetY: t.offsetY, invertX: t.invertX, invertY: t.invertY, error: error / points.length, change };
}
