/**
 * Camera calibration (#167): the screen shows four QR codes at its corners, the phone (held up like
 * a camera) finds them with `native.camera.locate`, and this turns their directions into how wide
 * and tall the screen looks from the player's seat. One centre tap afterwards, in the player's own
 * grip, sets the reference pose. Together: absolute aim without the five dots.
 *
 * Only the screen's angular size comes from the camera; where the barrel points comes from the tap,
 * so the camera's own axis never has to line up with the barrel.
 */
import { aimAngles, fromEuler, rotate } from './aim';
import type { Quat, Vec3 } from './protocol';
import { applyTune, type Tuning } from './tuning';

export const CORNERS = ['tl', 'tr', 'br', 'bl'] as const;
export type Corner = (typeof CORNERS)[number];

/** Each code's side and its margin from the window's edge, in screen heights. */
export const CODE_SIZE = 0.16;
export const CODE_MARGIN = 0.03;

/** The codes' payloads for a room: `whee-cal:<nonce>:<corner>`. */
export const codePayloads = (nonce: string): string[] => CORNERS.map((c) => `whee-cal:${nonce}:${c}`);

/** Where each code's centre is drawn: x in screen widths, y in heights (top left, top right, bottom right, bottom left). */
export function codeSpots(aspect: number): [number, number][] {
  const c = CODE_MARGIN + CODE_SIZE / 2;
  const x = c / aspect;
  return [
    [x, c],
    [1 - x, c],
    [1 - x, 1 - c],
    [x, 1 - c],
  ];
}

/** What the phone sends after a snap (`{ menu: { snapped } }`): each corner's direction in the phone's frame, and the phone's attitude. */
export interface Snapped {
  /** Unit vectors (CoreMotion device axes), in CORNERS order. */
  rays: Vec3[];
  /** CoreMotion Euler attitude, rad. */
  att: { roll: number; pitch: number; yaw: number };
}

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** A snap from a phone, or null if it isn't one (four unit-ish rays and an attitude). */
export function readSnapped(raw: unknown): Snapped | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const att = s.att as Record<string, unknown> | undefined;
  if (!Array.isArray(s.rays) || s.rays.length !== CORNERS.length || !att || !fin(att.roll) || !fin(att.pitch) || !fin(att.yaw)) return null;
  if ([att.roll, att.pitch, att.yaw].some((a) => Math.abs(a as number) > 7)) return null;
  const rays: Vec3[] = [];
  for (const r of s.rays as unknown[]) {
    if (!Array.isArray(r) || r.length !== 3 || !r.every(fin)) return null;
    const [x, y, z] = r as [number, number, number];
    const len = Math.hypot(x, y, z);
    if (len < 0.9 || len > 1.1) return null;
    rays.push([x / len, y / len, z / len]);
  }
  return { rays, att: { roll: att.roll as number, pitch: att.pitch as number, yaw: att.yaw as number } };
}

/** A pose whose barrel (portrait: the top edge) points along `d` (a direction in the room). */
function poseAlong(d: Vec3): Quat {
  const yaw = Math.atan2(-d[0], d[1]);
  const pitch = Math.asin(Math.max(-1, Math.min(1, d[2])));
  return fromEuler(0, pitch, yaw);
}

export interface SnapFit {
  /** Screen widths per radian of heading: the absolute mapping's gain. */
  gain: number;
  ratioY: number;
  /** How wide and tall the screen looks (rad), corner code to corner code scaled to the whole screen. */
  widthRad: number;
  heightRad: number;
  /** Mean distance from each code to where the fit puts it, screen heights. */
  error: number;
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
  return { a: my - (sxx > 1e-12 ? sxy / sxx : 0) * mx, b: sxx > 1e-12 ? sxy / sxx : 0 };
}

/** The gain an absolute crosshair needs, from a snap: null if the codes don't make a plausible screen. */
export function fitSnap(snap: Snapped, aspect: number): SnapFit | null {
  const q = fromEuler(snap.att.roll, snap.att.pitch, snap.att.yaw);
  const world = snap.rays.map((r) => rotate(q, r));
  // Heading and elevation of each code, measured the way the aim measures the barrel.
  const mean = world.reduce<Vec3>((s, w) => [s[0] + w[0], s[1] + w[1], s[2] + w[2]], [0, 0, 0]);
  const ref = poseAlong(mean);
  const angles = world.map((w) => aimAngles(ref, poseAlong(w), 'portrait'));
  const spots = codeSpots(aspect);
  const fx = line(
    angles.map((a) => a.h),
    spots.map((s) => s[0]),
  );
  const fy = line(
    angles.map((a) => a.v),
    spots.map((s) => s[1]),
  );
  // x grows to the right as the heading turns right and y down as the elevation drops; only the
  // sizes are used (inverting stays the player's setting, and a mirrored lens reading can't flip it).
  const gain = Math.abs(fx.b);
  const gy = Math.abs(fy.b);
  if (gain < 1e-6 || gy < 1e-6) return null;
  const ratioY = gy / (gain * aspect);
  const widthRad = 1 / gain;
  const heightRad = 1 / gy;
  // A screen between 4° and 120° wide, not wildly stretched one way.
  if (widthRad < 0.07 || widthRad > 2.1 || ratioY < 0.5 || ratioY > 2) return null;
  let error = 0;
  angles.forEach((a, k) => {
    error += Math.hypot((fx.a + fx.b * a.h - spots[k]![0]) * aspect, fy.a + fy.b * a.v - spots[k]![1]);
  });
  return { gain, ratioY, widthRad, heightRad, error: error / angles.length };
}

/**
 * The tuning change a snap and tap make: the absolute gain and vertical ratio from the camera, no
 * offsets (the tap is the centre). Relative aim keeps its own feel (sensitivity in screen widths per
 * radian already crosses any screen with the same turn).
 */
export function snapChange(fit: SnapFit, tuning: Tuning): Partial<Tuning> {
  const t = applyTune(tuning, { fovGain: fit.gain, ratioY: fit.ratioY });
  return tuning.mode === 'relative' ? { fovGain: t.fovGain } : { fovGain: t.fovGain, ratioY: t.ratioY, offsetX: 0, offsetY: 0 };
}

// --- The quiet correction during play ------------------------------------------------------------

/** How a near miss nudges a phone's aim: offsets (absolute, hybrid) and the gain (relative). */
export interface Nudge {
  dx: number;
  dy: number;
  gain: number;
}

export const NUDGE_STEP = 0.05;
export const NUDGE_MAX_OFFSET = 0.05;
export const NUDGE_MAX_GAIN = 0.15;
/** Only misses whose centre is within this many hitbox radii count. */
export const NUDGE_NEAR = 1.5;

export const NO_NUDGE: Nudge = { dx: 0, dy: 0, gain: 1 };

const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));

/**
 * One near miss: `err` is crosshair − target centre (x in widths, y in heights). Absolute and hybrid
 * move the offset a step against the error; relative compares the error with the move just made
 * (`move`, the crosshair's travel over the last 300 ms, same units): past the target lowers the gain,
 * short of it raises it. Everything stays within its cap.
 */
export function nudge(n: Nudge, mode: Tuning['mode'], err: [number, number], move: [number, number], aspect: number): Nudge {
  if (mode !== 'relative') {
    return { ...n, dx: clamp(n.dx - NUDGE_STEP * err[0], NUDGE_MAX_OFFSET), dy: clamp(n.dy - NUDGE_STEP * err[1], NUDGE_MAX_OFFSET) };
  }
  const mx = move[0] * aspect;
  const my = move[1];
  const len = Math.hypot(mx, my);
  if (len < 0.05) return n;
  const along = (err[0] * aspect * mx + err[1] * my) / len;
  const rel = Math.max(-1, Math.min(1, along / len));
  return { ...n, gain: 1 + clamp(n.gain * (1 - NUDGE_STEP * rel) - 1, NUDGE_MAX_GAIN) };
}

/** A tuning with a nudge on top. */
export const withNudge = (t: Tuning, n: Nudge | null): Tuning =>
  !n || (n.dx === 0 && n.dy === 0 && n.gain === 1) ? t : { ...t, offsetX: t.offsetX + n.dx, offsetY: t.offsetY + n.dy, sensitivity: t.sensitivity * n.gain };
