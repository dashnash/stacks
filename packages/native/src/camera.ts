/**
 * Camera for @stacks/native: `camera.locate` finds codes (QR payloads, e.g. shown on a big screen)
 * and says which way each one is from the phone. The page never sees a frame. Also the fake the
 * demos and tests drive, and the geometry to build its answers.
 */

import type { Attitude, Vec3 } from './motion';

export interface CameraLocateArgs {
  /** The QR payloads to find (1-8, distinct). */
  codes: string[];
  /** How long every code must stay steady before it answers (ms, 300-5000, default 1500). */
  holdMs?: number;
  /** Fails (`failed`) when not all codes were found steady by then (ms, 2000-30000, default 10000). */
  timeoutMs?: number;
  /** A line the app shows over its camera view (at most 120 characters). */
  prompt?: string;
}

/** A code's direction (its centre) and its four corners, as unit vectors in the phone's frame. */
export interface LocatedCode {
  centre: Vec3;
  corners: Vec3[];
}

export interface CameraLocateResult {
  found: Record<string, LocatedCode>;
  /** The motion stream's attitude at that moment (same reference frame as its samples). */
  attitude: Attitude;
}

export const CAMERA_MAX_CODES = 8;

/** CoreMotion's attitude as a matrix taking the phone's frame to the reference frame: Rz(yaw) · Rx(pitch) · Ry(roll). */
export function attitudeMatrix(a: Attitude): number[][] {
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(a.roll), Math.sin(a.roll), Math.cos(a.pitch), Math.sin(a.pitch), Math.cos(a.yaw), Math.sin(a.yaw)];
  const rz = [[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]];
  const rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
  const ry = [[cr, 0, sr], [0, 1, 0], [-sr, 0, cr]];
  const mul = (m: number[][], k: number[][]) => m.map((row) => [0, 1, 2].map((j) => row[0]! * k[0]![j]! + row[1]! * k[1]![j]! + row[2]! * k[2]![j]!));
  return mul(mul(rz, rx), ry);
}

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

/** A direction in the phone's frame, into the reference frame (for an attitude). */
export function toReference(a: Attitude, v: Vec3): Vec3 {
  const m = attitudeMatrix(a);
  return { x: m[0]![0]! * v.x + m[0]![1]! * v.y + m[0]![2]! * v.z, y: m[1]![0]! * v.x + m[1]![1]! * v.y + m[1]![2]! * v.z, z: m[2]![0]! * v.x + m[2]![1]! * v.y + m[2]![2]! * v.z };
}

/** A direction in the reference frame, into the phone's frame. */
export function toDevice(a: Attitude, v: Vec3): Vec3 {
  const m = attitudeMatrix(a);
  return { x: m[0]![0]! * v.x + m[1]![0]! * v.y + m[2]![0]! * v.z, y: m[0]![1]! * v.x + m[1]![1]! * v.y + m[2]![1]! * v.z, z: m[0]![2]! * v.x + m[1]![2]! * v.y + m[2]![2]! * v.z };
}

export interface PretendScreen {
  /** Where its centre is from the player, in the reference frame (rad): yaw about vertical, pitch up. */
  yaw: number;
  pitch: number;
  /** How wide it looks (rad), and its width over its height. */
  widthRad: number;
  aspect: number;
}

/**
 * Where a point on a pretend screen is from the player, in the reference frame: `x` 0-1 left to
 * right, `y` 0-1 top to bottom. A flat screen, square on to the player.
 */
export function screenPoint(s: PretendScreen, x: number, y: number): Vec3 {
  const d = { x: -Math.sin(s.yaw) * Math.cos(s.pitch), y: Math.cos(s.yaw) * Math.cos(s.pitch), z: Math.sin(s.pitch) };
  const right = { x: Math.cos(s.yaw), y: Math.sin(s.yaw), z: 0 };
  const up = { x: right.y * d.z - right.z * d.y, y: right.z * d.x - right.x * d.z, z: right.x * d.y - right.y * d.x };
  const hw = Math.tan(s.widthRad / 2);
  const hh = hw / s.aspect;
  const a = (2 * x - 1) * hw;
  const b = (1 - 2 * y) * hh;
  return unit({ x: d.x + a * right.x + b * up.x, y: d.y + a * right.y + b * up.y, z: d.z + a * right.z + b * up.z });
}

/**
 * What `camera.locate` would answer for codes at `codes` (screen fractions, see screenPoint) on a
 * pretend screen, with the phone at `attitude`. `size`: each code's side, as a fraction of the
 * screen's width.
 */
export function screenRays(s: PretendScreen, codes: { code: string; x: number; y: number }[], attitude: Attitude, size = 0.08): CameraLocateResult {
  const found: Record<string, LocatedCode> = {};
  const h = size / 2;
  const hy = h * s.aspect;
  for (const c of codes) {
    const dev = (x: number, y: number) => unit(toDevice(attitude, screenPoint(s, x, y)));
    found[c.code] = { centre: dev(c.x, c.y), corners: [dev(c.x - h, c.y - hy), dev(c.x + h, c.y - hy), dev(c.x + h, c.y + hy), dev(c.x - h, c.y + hy)] };
  }
  return { found, attitude: { ...attitude } };
}

export interface FakeCameraOptions {
  /** Answers each `camera.locate` (default: a screen straight ahead that the phone faces, holding every code). */
  locate?: (args: CameraLocateArgs) => CameraLocateResult | Promise<CameraLocateResult>;
}

/**
 * A pretend camera for `installFakeNative`: `{ ...fakeCamera().handlers }` answers `camera.locate`.
 * By default it sees a 16:9 screen 30° wide straight ahead, the phone held up facing it, with the
 * codes at its corners in the order given (top left, top right, bottom right, bottom left, then the centre).
 */
export function fakeCamera(opts: FakeCameraOptions = {}) {
  const calls: CameraLocateArgs[] = [];
  const spots = [[0.06, 0.1], [0.94, 0.1], [0.94, 0.9], [0.06, 0.9], [0.5, 0.5]] as const;
  const fallback = (args: CameraLocateArgs) =>
    screenRays(
      { yaw: 0, pitch: 0, widthRad: Math.PI / 6, aspect: 16 / 9 },
      args.codes.slice(0, spots.length).map((code, i) => ({ code, x: spots[i]![0], y: spots[i]![1] })),
      { roll: 0, pitch: Math.PI / 2, yaw: 0 },
    );
  const handlers = {
    'camera.locate': (args: CameraLocateArgs) => {
      calls.push(args);
      return (opts.locate ?? fallback)(args);
    },
  };
  return { handlers, calls };
}
