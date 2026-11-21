/**
 * Training mode's script: a fixed set of moves the screen shows and the player follows with the
 * phone. Three kinds of trial:
 *
 * - **jump** (crosshair hidden): the crosshair sits on dot A; dot B appears and the crosshair
 *   disappears; the player points where they think B is and holds. With no crosshair to correct
 *   against, this measures the player's own sense of "this far", which fits the gain and the
 *   accel curve.
 * - **track** (crosshair shown): follow a dot moving on a smooth path, at four speeds.
 * - **hold** (crosshair shown): keep the crosshair on a still dot.
 *
 * Tracks and holds give the motion that the smoothing and prediction are fitted on. The script is
 * seeded, so a recording can be replayed against the trials that produced it.
 */
import type { Quat, Vec3 } from './protocol';
import { rng } from './targets';
import type { Tuning } from './tuning';

export type TrialKind = 'jump' | 'track' | 'hold';

export interface Trial {
  kind: TrialKind;
  /** Jump: the start dot (the crosshair is put here). Hold: the dot. Track: where the path starts. */
  a: [number, number];
  /** Jump: the dot to point at. */
  b?: [number, number];
  /** Track: the path's frequencies (Hz) and phases. */
  f?: [number, number];
  ph?: [number, number];
  /** How long the trial runs after the gap, ms. */
  ms: number;
}

/** Between trials: the next dot shows, faint, so nobody is surprised. */
export const GAP_MS = 600;
/** Jump: settle on A, then point at B and hold. The endpoint is the mean over the last ENDPOINT_MS. */
export const JUMP_AIM_MS = 900;
export const JUMP_MOVE_MS = 1600;
export const ENDPOINT_MS = 300;
export const TRACK_MS = 6000;
export const HOLD_MS = 4000;

/** Jump distances (screen heights) and how many directions each is tried in. */
export const JUMP_DISTANCES = [0.08, 0.16, 0.28, 0.42];
export const JUMP_DIRECTIONS = 6;
export const TRACK_SPEEDS = [0.12, 0.2, 0.3, 0.42];
export const HOLDS = 3;
const TRACK_AMP: [number, number] = [0.3, 0.28];

const inside = (p: [number, number]) => p[0] >= 0.1 && p[0] <= 0.9 && p[1] >= 0.12 && p[1] <= 0.88;

/** The dot on a track trial, `ms` after it started (x in screen widths, y in heights). */
export function trackAt(trial: Trial, ms: number): [number, number] {
  const s = ms / 1000;
  const [f1, f2] = trial.f ?? [0.2, 0.27];
  const [p1, p2] = trial.ph ?? [0, 0];
  return [0.5 + TRACK_AMP[0] * Math.sin(2 * Math.PI * f1 * s + p1), 0.5 + TRACK_AMP[1] * Math.sin(2 * Math.PI * f2 * s + p2)];
}

/** The whole script: one hold to settle in, then every other trial in a shuffled order. */
export function trainingScript(seed: number, aspect: number): Trial[] {
  const random = rng(seed);
  const jumps: Trial[] = [];
  for (const d of JUMP_DISTANCES) {
    const turn = random() * Math.PI * 2;
    for (let k = 0; k < JUMP_DIRECTIONS; k++) {
      const angle = turn + (k / JUMP_DIRECTIONS) * Math.PI * 2 + (random() - 0.5) * 0.4;
      // x is in widths: a jump of d heights across is d / aspect widths.
      const dx = (Math.cos(angle) * d) / aspect;
      const dy = Math.sin(angle) * d;
      let a: [number, number] = [0.5, 0.5];
      for (let tries = 0; tries < 20; tries++) {
        const c: [number, number] = [0.2 + random() * 0.6, 0.22 + random() * 0.56];
        if (inside([c[0] + dx, c[1] + dy])) {
          a = c;
          break;
        }
        a = [0.5 - dx / 2, 0.5 - dy / 2];
      }
      jumps.push({ kind: 'jump', a, b: [a[0] + dx, a[1] + dy], ms: JUMP_AIM_MS + JUMP_MOVE_MS });
    }
  }
  const tracks: Trial[] = TRACK_SPEEDS.map((f) => {
    const ph: [number, number] = [random() * Math.PI * 2, random() * Math.PI * 2];
    const t: Trial = { kind: 'track', a: [0.5, 0.5], f: [f, f * 1.37], ph, ms: TRACK_MS };
    t.a = trackAt(t, 0);
    return t;
  });
  const holds: Trial[] = Array.from({ length: HOLDS }, () => ({ kind: 'hold' as const, a: [0.3 + random() * 0.4, 0.3 + random() * 0.4] as [number, number], ms: HOLD_MS }));
  const rest = [...jumps, ...tracks, ...holds.slice(1)];
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return [holds[0]!, ...rest];
}

/** How long the script runs, ms. */
export const scriptMs = (script: Trial[]) => script.reduce((sum, t) => sum + GAP_MS + t.ms, 0);

// --- What the server records ---------------------------------------------------------------------

/** One raw sample on the server's clock (ms). */
export interface RecSample {
  st: number;
  q: Quat;
  r: Vec3;
}

/** A trial as it ran: server times of its start, of B appearing (jumps), and of its end. */
export interface RecTrial {
  kind: TrialKind;
  a: [number, number];
  b?: [number, number];
  t0: number;
  move?: number;
  end: number;
}

export interface Recording {
  samples: RecSample[];
  trials: RecTrial[];
  /** The screen's width / height. */
  aspect: number;
  /** Mean motion → pixel delay during the run: half the gun's round trip plus the crosshair's lag. */
  latencyMs: number;
  /** The tuning the player had when training started. */
  base: Tuning;
}

/** Most samples one run keeps (100 Hz for over 6 minutes). */
export const MAX_REC_SAMPLES = 40_000;

/** How many trials a script has. */
export const TRIALS = JUMP_DISTANCES.length * JUMP_DIRECTIONS + TRACK_SPEEDS.length + HOLDS;
