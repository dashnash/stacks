/**
 * Raw phone motion → a crosshair on the screen, on the game server. Three mappings (absolute,
 * relative, hybrid), then a deadzone, a one-euro filter and prediction, all from one `Tuning`. Each
 * gun keeps ~1.5 s of crosshair history so a shot can be judged where it was aimed, not where the
 * crosshair is when the shot arrives.
 */
import type { Quat, Vec3 } from './protocol';
import type { Tuning } from './tuning';

// --- Quaternions ([x, y, z, w]) -----------------------------------------------------------------

export const IDENTITY: Quat = [0, 0, 0, 1];

export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

export function qnorm(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 1e-9 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : IDENTITY;
}

const axisAngle = (axis: 0 | 1 | 2, angle: number): Quat => {
  const q: Quat = [0, 0, 0, Math.cos(angle / 2)];
  q[axis] = Math.sin(angle / 2);
  return q;
};

/**
 * CoreMotion's Euler attitude as a quaternion: R = Rz(yaw) · Rx(pitch) · Ry(roll). The phone builds
 * it (the SDK gives Euler angles); the server only ever uses rotations relative to a reference.
 */
export function fromEuler(roll: number, pitch: number, yaw: number): Quat {
  return qnorm(qmul(qmul(axisAngle(2, yaw), axisAngle(0, pitch)), axisAngle(1, roll)));
}

/** Rotate vector `v` by unit quaternion `q`. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [p[0], p[1], p[2]];
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    [bx, by, bz, bw] = [-bx, -by, -bz, -bw];
    dot = -dot;
  }
  if (dot > 0.9995) return qnorm([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  const theta = Math.acos(dot);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

/**
 * Where the gun points relative to a reference pose: `h` radians right of it and `v` above it.
 * Portrait: the top edge (+y) is the barrel; landscape: the right edge (+x). Both are measured in the
 * room (heading about the vertical, elevation above the horizon), so the grip doesn't matter: a
 * phone held upright like a pistol turns right as right, not as down.
 */
export function aimAngles(ref: Quat, q: Quat, orientation: Tuning['orientation']): { h: number; v: number } {
  const axis: Vec3 = orientation === 'landscape' ? [1, 0, 0] : [0, 1, 0];
  const d = rotate(q, axis);
  const d0 = rotate(ref, axis);
  let h = Math.atan2(d[0], d[1]) - Math.atan2(d0[0], d0[1]);
  if (h > Math.PI) h -= 2 * Math.PI;
  else if (h < -Math.PI) h += 2 * Math.PI;
  const elev = (u: Vec3) => Math.asin(Math.max(-1, Math.min(1, u[2])));
  return { h, v: elev(d) - elev(d0) };
}

// --- One-euro filter -----------------------------------------------------------------------------

/** Casiez et al.'s one-euro filter: smooth at rest, responsive when moving fast. */
export class OneEuro {
  private x: number | null = null;
  private raw = 0;
  private dx = 0;
  private t = 0;
  constructor(private readonly dCutoff = 1) {}
  reset(): void {
    this.x = null;
    this.dx = 0;
  }
  /** Filtered value at time `t` (seconds); `velocity` is the smoothed derivative after the call. */
  filter(value: number, t: number, minCutoff: number, beta: number): number {
    if (this.x === null || t <= this.t) {
      if (this.x === null) {
        this.x = value;
        this.raw = value;
      }
      this.t = t;
      return this.x;
    }
    const dt = Math.min(0.25, t - this.t);
    this.t = t;
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    // The derivative of the input, not of the output (that would be the filter's own lag over dt).
    const rawDx = (value - this.raw) / dt;
    this.raw = value;
    this.dx += alpha(this.dCutoff) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += alpha(cutoff) * (value - this.x);
    return this.x;
  }
  get velocity(): number {
    return this.dx;
  }
}

// --- Turning, in the room's frame ----------------------------------------------------------------

/** The barrel: the phone's top edge (portrait) or right edge (landscape). */
const barrel = (orientation: Tuning['orientation']): Vec3 => (orientation === 'landscape' ? [1, 0, 0] : [0, 1, 0]);

/**
 * How fast the barrel turns right and up (rad/s), from the rotation rate (device axes) and the
 * attitude. Measured about the room's vertical and the horizontal axis across the barrel, so it
 * doesn't matter how the phone is gripped: flat like a remote, upright like a pistol, or tilted.
 */
export function turnRates(q: Quat, r: Vec3, orientation: Tuning['orientation']): { right: number; up: number } {
  const w = rotate(q, r);
  const b = rotate(q, barrel(orientation));
  // Across the barrel, horizontal: b × up. Turning about it by + raises the barrel.
  const across: Vec3 = [b[1], -b[0], 0];
  const n = Math.hypot(across[0], across[1]);
  const up = n > 0.2 ? (w[0] * across[0] + w[1] * across[1]) / n : 0;
  // Turning about the vertical by + swings the barrel left.
  return { right: -w[2], up };
}

/** Relative mode: screen widths per radian at turn speed `omega` (rad/s), with the accel curve. */
export const relativeGain = (omega: number, tuning: Pick<Tuning, 'sensitivity' | 'accelCurve'>) => tuning.sensitivity * Math.pow(Math.max(omega, 1e-3), tuning.accelCurve - 1);

// --- One gun's aim -------------------------------------------------------------------------------

export interface AimPoint {
  /** Server time, ms. */
  t: number;
  x: number;
  y: number;
  /** Raw: the mapping with no deadzone, smoothing or prediction. */
  rx: number;
  ry: number;
}

/** How long the crosshair history goes back (covers the max rewind plus the flick look-back). */
export const AIM_HISTORY_MS = 1500;
/** Below this (rad/s) the hybrid mapping counts the gun as still and lets the reference drift. */
export const HYBRID_STILL = 0.15;
/** Hybrid fine aim applies to rotations slower than this (rad/s). */
export const HYBRID_FINE_MAX = 0.6;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export class Aim {
  /** The pose that maps to the centre (plus offsets), set by calibrate. */
  ref: Quat | null = null;
  q: Quat | null = null;
  calibrated = false;
  private rel = { x: 0.5, y: 0.5 };
  private fine = { x: 0, y: 0 };
  private raw = { x: 0.5, y: 0.5 };
  private held = { x: 0.5, y: 0.5 };
  private readonly fx = new OneEuro();
  private readonly fy = new OneEuro();
  private lastT: number | null = null;
  readonly history: AimPoint[] = [];

  /** The crosshair now. */
  get current(): AimPoint {
    return this.history[this.history.length - 1] ?? { t: 0, x: 0.5, y: 0.5, rx: 0.5, ry: 0.5 };
  }

  /** "This is the centre": the current pose becomes the reference; relative aim starts in the middle. */
  calibrate(): void {
    if (this.q) this.ref = this.q;
    this.rel = { x: 0.5, y: 0.5 };
    this.fine = { x: 0, y: 0 };
    this.fx.reset();
    this.fy.reset();
    this.calibrated = true;
  }

  /** Relative mode: put the crosshair at (x, y) now (training starts each jump on its dot). */
  place(x: number, y: number): void {
    this.rel = { x: clamp01(x), y: clamp01(y) };
    this.fx.reset();
    this.fy.reset();
  }

  /** One motion sample, at server time `t` (ms). `aspect` is the screen's width / height. */
  update(t: number, q: Quat, r: Vec3, tuning: Tuning, aspect: number): AimPoint {
    const dt = this.lastT === null ? 0 : Math.min(0.1, Math.max(0, (t - this.lastT) / 1000));
    this.lastT = t;
    this.q = q;
    if (!this.ref) this.ref = q;
    const omega = Math.hypot(r[0], r[1], r[2]);
    const sx = tuning.invertX ? -1 : 1;
    const sy = tuning.invertY ? -1 : 1;

    const moving = omega >= tuning.deadzone;
    const turn = moving ? turnRates(q, r, tuning.orientation) : { right: 0, up: 0 };
    const dh = turn.right * dt * sx;
    const dv = turn.up * dt * sy * tuning.ratioY;

    let x: number;
    let y: number;
    if (tuning.mode === 'relative') {
      const scale = relativeGain(omega, tuning);
      this.rel.x = clamp01(this.rel.x + dh * scale);
      this.rel.y = clamp01(this.rel.y - dv * scale * aspect);
      x = this.rel.x;
      y = this.rel.y;
    } else {
      if (tuning.mode === 'hybrid') {
        if (omega < HYBRID_STILL && tuning.recentreRate > 0) this.ref = qnorm(slerp(this.ref, q, 1 - Math.exp(-tuning.recentreRate * dt)));
        const decay = Math.exp(-tuning.recentreRate * dt);
        const fine = omega < HYBRID_FINE_MAX ? tuning.fineGain * tuning.fovGain : 0;
        this.fine.x = Math.max(-0.3, Math.min(0.3, this.fine.x * decay + dh * fine));
        this.fine.y = Math.max(-0.3, Math.min(0.3, this.fine.y * decay - dv * fine * aspect));
      }
      const { h, v } = aimAngles(this.ref, q, tuning.orientation);
      x = 0.5 + h * sx * tuning.fovGain + (tuning.mode === 'hybrid' ? this.fine.x : 0);
      y = 0.5 - v * sy * tuning.ratioY * tuning.fovGain * aspect + (tuning.mode === 'hybrid' ? this.fine.y : 0);
    }
    this.raw = { x: clamp01(x + tuning.offsetX), y: clamp01(y + tuning.offsetY) };
    // Deadzone: tremor below the threshold doesn't move the crosshair (relative already ignores it).
    if (moving || tuning.mode === 'relative') this.held = this.raw;
    return this.push(t, this.held.x, this.held.y, tuning);
  }

  /** A mouse seat: the pointer is the crosshair, as is (it is already smooth; filtering only adds lag). */
  point(t: number, x: number, y: number): AimPoint {
    this.lastT = t;
    this.calibrated = true;
    this.raw = { x: clamp01(x), y: clamp01(y) };
    const point: AimPoint = { t, x: this.raw.x, y: this.raw.y, rx: this.raw.x, ry: this.raw.y };
    this.history.push(point);
    while (this.history.length > 2 && this.history[0]!.t < t - AIM_HISTORY_MS) this.history.shift();
    return point;
  }

  private push(t: number, x: number, y: number, tuning: Tuning): AimPoint {
    const fx = this.fx.filter(x, t / 1000, tuning.minCutoff, tuning.beta);
    const fy = this.fy.filter(y, t / 1000, tuning.minCutoff, tuning.beta);
    const ahead = tuning.prediction / 1000;
    const point: AimPoint = { t, x: clamp01(fx + this.fx.velocity * ahead), y: clamp01(fy + this.fy.velocity * ahead), rx: this.raw.x, ry: this.raw.y };
    this.history.push(point);
    while (this.history.length > 2 && this.history[0]!.t < t - AIM_HISTORY_MS) this.history.shift();
    return point;
  }

  /** The crosshair at server time `t` (interpolated; the oldest or newest point outside the history). */
  at(t: number): AimPoint {
    const h = this.history;
    if (!h.length) return this.current;
    if (t <= h[0]!.t) return h[0]!;
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1]!;
      const b = h[i]!;
      if (t >= a.t) {
        if (t >= b.t) return b;
        const f = (t - a.t) / (b.t - a.t || 1);
        return { t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, rx: a.rx + (b.rx - a.rx) * f, ry: a.ry + (b.ry - a.ry) * f };
      }
    }
    return h[h.length - 1]!;
  }
}

/** The phone's yaw/pitch/roll of a quaternion relative to identity (for the panel's graphs). */
export function toEuler(q: Quat): { roll: number; pitch: number; yaw: number } {
  // Inverse of R = Rz(yaw) · Rx(pitch) · Ry(roll).
  const [x, y, z, w] = q;
  const m21 = 2 * (y * z + w * x);
  const pitch = Math.asin(Math.max(-1, Math.min(1, m21)));
  const m20 = 2 * (x * z - w * y);
  const m22 = 1 - 2 * (x * x + y * y);
  const m01 = 2 * (x * y - w * z);
  const m11 = 1 - 2 * (x * x + z * z);
  return { roll: Math.atan2(-m20, m22), pitch, yaw: Math.atan2(-m01, m11) };
}
