import { gravityFor, type Attitude } from '@stacks/native';

/** A tilt as the maze and the bubble level use it: how far gravity pulls right (x) and down the screen (y), -1..1. */
export interface Tilt {
  x: number;
  y: number;
}

export const ZERO: Attitude = { roll: 0, pitch: 0, yaw: 0 };
const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/** The attitude relative to where "Zero" was pressed. */
export function relative(a: Attitude, ref: Attitude): Attitude {
  const wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
  return { roll: wrap(a.roll - ref.roll), pitch: wrap(a.pitch - ref.pitch), yaw: wrap(a.yaw - ref.yaw) };
}

/** Phone top raised (pitch > 0) rolls things down the screen; right edge down (roll > 0) rolls them right. */
export function tiltFromAttitude(a: Attitude): Tilt {
  const g = gravityFor(a);
  return { x: clamp(g.x), y: clamp(-g.y) };
}

const KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  a: [-1, 0],
  d: [1, 0],
  w: [0, -1],
  s: [0, 1],
};

/** Is this a key that tilts (arrows, WASD)? */
export const isTiltKey = (key: string) => key in KEYS || key.toLowerCase() in KEYS;

/** Held keys as a tilt: half a g each way, diagonals included. */
export function keysToTilt(held: Iterable<string>, strength = 0.5): Tilt {
  let x = 0;
  let y = 0;
  for (const k of held) {
    const d = KEYS[k] ?? KEYS[k.toLowerCase()];
    if (!d) continue;
    x += d[0];
    y += d[1];
  }
  return { x: clamp(Math.sign(x) * strength), y: clamp(Math.sign(y) * strength) };
}

/** A drag from where the pointer went down, over a stage `size` px across: half the stage is a full tilt. */
export function dragToTilt(dx: number, dy: number, size: number): Tilt {
  const s = Math.max(1, size / 2);
  return { x: clamp(dx / s), y: clamp(dy / s) };
}
