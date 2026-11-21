/**
 * Fitting the aim to a training run, in the room when the run ends. It replays the recorded motion
 * through the same `Aim` the game uses, so a candidate tuning is scored on exactly what it would have
 * drawn. Two stages:
 *
 * 1. **Gain** (relative mode: sensitivity, accel curve, vertical gain), from the hidden-crosshair
 *    jumps. For a fixed curve the jump's travel is linear in the sensitivity, so each curve on a grid
 *    gets its best sensitivity by least squares, and the curve with the smallest endpoint error wins.
 * 2. **Feel** (smoothing cutoff and β, prediction, deadzone), by coordinate descent on all trials.
 *    The loss compares the crosshair with the player's intent (the raw motion, smoothed with no
 *    delay), as it will be when it reaches the screen `latencyMs` later, so lag costs; shake while
 *    holding still past `SHAKE_BUDGET` costs a lot more.
 *
 * `fitTraining` is a generator that yields its progress (0-1), so the server can spread it over
 * ticks; `runFit` runs it to the end (tests).
 */
import { Aim, relativeGain, turnRates } from './aim';
import { sig4 } from './protocol';
import { ENDPOINT_MS, type RecTrial, type Recording } from './training';
import { applyTune, type Tuning } from './tuning';

export interface Metrics {
  /** Mean distance from a jump's endpoint to its dot, screen heights. */
  jumpErr: number;
  /** How far the crosshair travels per intended distance (1 is right, above 1 too fast). */
  gain: number;
  /** Crosshair shake while holding a dot: RMS about its own smoothed path, screen heights. */
  jitter: number;
  /** Hand to pixel while tracking, ms: the filter's delay plus the network and screen, less prediction. */
  lagMs: number;
}

export interface JumpSummary {
  a: [number, number];
  b: [number, number];
  /** The turn the player made, right and up, radians. */
  turn: [number, number];
  /** Fastest turn speed, rad/s. */
  peak: number;
  used: boolean;
}

export interface FitReport {
  v: 1;
  base: Tuning;
  fitted: Tuning;
  before: Metrics;
  after: Metrics;
  usedJumps: number;
  totalJumps: number;
  latencyMs: number;
  jumps: JumpSummary[];
}

/** Need this many usable jumps for a gain fit; below that only the feel is fitted. */
export const MIN_JUMPS = 6;
/** A jump counts if the player held still at the end (mean turn speed below this, rad/s) and moved. */
const STILL_AT_END = 0.5;
const MOVED = 0.01;
const CURVES = Array.from({ length: 25 }, (_, i) => 1 + i * 0.05);
const GRIDS = {
  minCutoff: [0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4.5, 6.5, 10],
  beta: [0, 0.2, 0.5, 1, 1.5, 2.5, 4, 6, 10],
  prediction: [0, 10, 20, 30, 40, 50, 60, 80, 100, 120],
  deadzone: [0, 0.005, 0.01, 0.02, 0.035, 0.05, 0.08],
} satisfies Partial<Record<keyof Tuning, number[]>>;
const PASSES = 3;
/** Zero-delay smoothing of the intent: a Gaussian of this σ (ms), out to 3σ. */
const INTENT_SIGMA_MS = 30;
/** Shake the fit allows while holding still (RMS, screen heights: about 1.5 px on a 1080p screen). */
export const SHAKE_BUDGET = 0.0014;
const SHAKE_PENALTY = 20;
/** Shake is measured about the crosshair's path smoothed this much (ms). */
const SHAKE_SIGMA_MS = 80;
/** Below this speed (screen heights/s) the intent counts as holding still. */
const STILL_SPEED = 0.15;

interface Prepared {
  rec: Recording;
  t: Float64Array;
  /** Per sample: turn speed, the turn right/up (rad/s), and dt (s), as `Aim` sees them. */
  omega: Float64Array;
  right: Float64Array;
  up: Float64Array;
  dt: Float64Array;
  /** Resets: at each trial start and when a jump's B appears, the crosshair goes back to A. */
  resets: { t: number; a: [number, number] }[];
  /** Samples inside a trial and away from a reset (where the loss counts). */
  scored: Uint8Array;
  jumps: { trial: RecTrial; from: number; to: number; endFrom: number; used: boolean }[];
}

const lowerBound = (t: Float64Array, v: number) => {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

function prepare(rec: Recording): Prepared {
  const samples = [...rec.samples].sort((a, b) => a.st - b.st);
  const n = samples.length;
  const p: Prepared = {
    rec: { ...rec, samples },
    t: new Float64Array(n),
    omega: new Float64Array(n),
    right: new Float64Array(n),
    up: new Float64Array(n),
    dt: new Float64Array(n),
    resets: [],
    scored: new Uint8Array(n),
    jumps: [],
  };
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    p.t[i] = s.st;
    p.omega[i] = Math.hypot(s.r[0], s.r[1], s.r[2]);
    const turn = turnRates(s.q, s.r, rec.base.orientation);
    p.right[i] = turn.right;
    p.up[i] = turn.up;
    p.dt[i] = i ? Math.min(0.1, Math.max(0, (s.st - samples[i - 1]!.st) / 1000)) : 0;
  }
  for (const trial of rec.trials) {
    p.resets.push({ t: trial.t0, a: trial.a });
    if (trial.move !== undefined) p.resets.push({ t: trial.move, a: trial.a });
    const from = lowerBound(p.t, trial.t0);
    const to = lowerBound(p.t, trial.end);
    for (let i = from; i < to; i++) p.scored[i] = 1;
  }
  p.resets.sort((a, b) => a.t - b.t);
  // Not right after a reset (the crosshair jumped there), nor just before one (the intent ahead is past it).
  const lead = Math.max(0, rec.latencyMs) + 3 * INTENT_SIGMA_MS;
  for (const r of p.resets) for (let i = lowerBound(p.t, r.t - lead), end = lowerBound(p.t, r.t + 150); i < end; i++) p.scored[i] = 0;
  for (const trial of rec.trials) {
    if (trial.kind !== 'jump' || trial.move === undefined || !trial.b) continue;
    const from = lowerBound(p.t, trial.move);
    const to = lowerBound(p.t, trial.end);
    const endFrom = lowerBound(p.t, trial.end - ENDPOINT_MS);
    let still = 0;
    let turned = 0;
    for (let i = endFrom; i < to; i++) still += p.omega[i]!;
    for (let i = from; i < to; i++) turned += Math.hypot(p.right[i]!, p.up[i]!) * p.dt[i]!;
    const used = to - endFrom >= 3 && still / (to - endFrom) < STILL_AT_END && turned > MOVED;
    p.jumps.push({ trial, from, to, endFrom, used });
  }
  return p;
}

// --- Stage 1: gain from the jumps ----------------------------------------------------------------

interface GainFit {
  sx: number;
  sy: number;
  err: number;
  used: boolean[];
}

/** For accel curve `c`: each jump's travel at sensitivity 1 (x in widths, y in heights), the endpoint averaged. */
function travel(p: Prepared, c: number, deadzone: number) {
  const aspect = p.rec.aspect;
  return p.jumps.map((j) => {
    let dx = 0;
    let dy = 0;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let i = j.from; i < j.to; i++) {
      const w = p.omega[i]!;
      if (w >= deadzone) {
        const g = relativeGain(w, { sensitivity: 1, accelCurve: c }) * p.dt[i]!;
        dx += p.right[i]! * g;
        dy -= p.up[i]! * g * aspect;
      }
      if (i >= j.endFrom) {
        sumX += dx;
        sumY += dy;
        count++;
      }
    }
    return count ? [sumX / count, sumY / count] : [dx, dy];
  });
}

function fitGain(p: Prepared, c: number, deadzone: number): GainFit {
  const aspect = p.rec.aspect;
  const d = travel(p, c, deadzone);
  const target = p.jumps.map((j) => [j.trial.b![0] - j.trial.a[0], j.trial.b![1] - j.trial.a[1]]);
  let used = p.jumps.map((j) => j.used);
  let fit: GainFit = { sx: 1, sy: 1, err: Infinity, used };
  for (let round = 0; round < 2; round++) {
    let xx = 0;
    let xt = 0;
    let yy = 0;
    let yt = 0;
    d.forEach((v, k) => {
      if (!used[k]) return;
      xx += v[0]! * v[0]!;
      xt += v[0]! * target[k]![0]!;
      yy += v[1]! * v[1]!;
      yt += v[1]! * target[k]![1]!;
    });
    if (xx < 1e-12 || yy < 1e-12) return fit;
    const sx = xt / xx;
    const sy = yt / yy;
    const errs = d.map((v, k) => Math.hypot((sx * v[0]! - target[k]![0]!) * aspect, sy * v[1]! - target[k]![1]!));
    const kept = errs.filter((_, k) => used[k]);
    const err = kept.reduce((a, b) => a + b, 0) / Math.max(1, kept.length);
    fit = { sx, sy, err, used };
    // Once more without the outliers (a jump the player fumbled).
    const sorted = [...kept].sort((a, b) => a - b);
    const cut = Math.max(0.05, 3 * (sorted[sorted.length >> 1] ?? 0));
    used = used.map((u, k) => u && errs[k]! <= cut);
  }
  return fit;
}

// --- Replay --------------------------------------------------------------------------------------

interface Replay {
  x: Float64Array;
  y: Float64Array;
  rx: Float64Array;
  ry: Float64Array;
}

/** What `tuning` would have drawn for this recording, sample by sample. */
function replay(p: Prepared, tuning: Tuning): Replay {
  const n = p.t.length;
  const out: Replay = { x: new Float64Array(n), y: new Float64Array(n), rx: new Float64Array(n), ry: new Float64Array(n) };
  const aim = new Aim();
  let next = 0;
  const samples = p.rec.samples;
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    while (next < p.resets.length && p.resets[next]!.t <= s.st) {
      const a = p.resets[next++]!.a;
      if (tuning.mode === 'relative') aim.place(a[0] - tuning.offsetX, a[1] - tuning.offsetY);
      else aim.calibrate();
    }
    const pt = aim.update(s.st, s.q, s.r, tuning, p.rec.aspect);
    out.x[i] = pt.x;
    out.y[i] = pt.y;
    out.rx[i] = pt.rx;
    out.ry[i] = pt.ry;
  }
  return out;
}

/** A path smoothed with no delay (a centred Gaussian of `sigma` ms): for the raw path, what the hand meant without tremor. */
function smoothOf(p: Prepared, rx: Float64Array, ry: Float64Array, sigma = INTENT_SIGMA_MS): { x: Float64Array; y: Float64Array } {
  const n = p.t.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const reach = 3 * sigma;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const t = p.t[i]!;
    while (p.t[lo]! < t - reach) lo++;
    while (hi < n && p.t[hi]! <= t + reach) hi++;
    let w = 0;
    let sx = 0;
    let sy = 0;
    for (let k = lo; k < hi; k++) {
      const d = (p.t[k]! - t) / sigma;
      const g = Math.exp(-0.5 * d * d);
      w += g;
      sx += g * rx[k]!;
      sy += g * ry[k]!;
    }
    x[i] = sx / w;
    y[i] = sy / w;
  }
  return { x, y };
}

/** `v` at time `t` by linear interpolation (clamped to the ends). */
function at(p: Prepared, v: Float64Array, t: number): number {
  const i = lowerBound(p.t, t);
  if (i <= 0) return v[0]!;
  if (i >= p.t.length) return v[p.t.length - 1]!;
  const t0 = p.t[i - 1]!;
  const t1 = p.t[i]!;
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  return v[i - 1]! + (v[i]! - v[i - 1]!) * f;
}

interface Intent {
  x: Float64Array;
  y: Float64Array;
  still: Uint8Array;
}

function intentFor(p: Prepared, tuning: Tuning): Intent {
  const raw = replay(p, { ...tuning, deadzone: 0, prediction: 0 });
  const { x, y } = smoothOf(p, raw.rx, raw.ry);
  const still = new Uint8Array(p.t.length);
  for (let i = 1; i < p.t.length; i++) {
    const dt = (p.t[i]! - p.t[i - 1]!) / 1000;
    const speed = dt > 0 ? Math.hypot((x[i]! - x[i - 1]!) * p.rec.aspect, y[i]! - y[i - 1]!) / dt : 0;
    still[i] = speed < STILL_SPEED ? 1 : 0;
  }
  return { x, y, still };
}

/**
 * The feel loss: the crosshair against the intent `latencyMs` ahead (RMS: lag shows up here while
 * moving), plus a steep penalty once the shake while still passes `SHAKE_BUDGET`. Shake is far more
 * noticeable than its size suggests, so the fit buys as little lag as it can without visible shake.
 */
function feelLoss(p: Prepared, out: Replay, intent: Intent): number {
  const lead = p.rec.latencyMs;
  const aspect = p.rec.aspect;
  const calm = smoothOf(p, out.x, out.y, SHAKE_SIGMA_MS);
  let err = 0;
  let n = 0;
  let shake = 0;
  let nShake = 0;
  for (let i = 0; i < p.t.length; i++) {
    if (!p.scored[i]) continue;
    const t = p.t[i]! + lead;
    err += ((out.x[i]! - at(p, intent.x, t)) * aspect) ** 2 + (out.y[i]! - at(p, intent.y, t)) ** 2;
    n++;
    if (intent.still[i]) {
      shake += ((out.x[i]! - calm.x[i]!) * aspect) ** 2 + (out.y[i]! - calm.y[i]!) ** 2;
      nShake++;
    }
  }
  const over = Math.max(0, Math.sqrt(shake / Math.max(1, nShake)) - SHAKE_BUDGET);
  return Math.sqrt(err / Math.max(1, n)) + SHAKE_PENALTY * over;
}

/** The four numbers the screen shows for a tuning. */
function metricsFor(p: Prepared, tuning: Tuning): Metrics {
  const out = replay(p, tuning);
  const intent = intentFor(p, tuning);
  const aspect = p.rec.aspect;

  // Jumps: where the (unsmoothed) crosshair ended up against the dot.
  let err = 0;
  let dot = 0;
  let tt = 0;
  let used = 0;
  for (const j of p.jumps) {
    if (!j.used || j.to <= j.endFrom) continue;
    let ex = 0;
    let ey = 0;
    for (let i = j.endFrom; i < j.to; i++) {
      ex += out.rx[i]!;
      ey += out.ry[i]!;
    }
    ex /= j.to - j.endFrom;
    ey /= j.to - j.endFrom;
    const sx = out.rx[j.from]!;
    const sy = out.ry[j.from]!;
    const tx = (j.trial.b![0] - j.trial.a[0]) * aspect;
    const ty = j.trial.b![1] - j.trial.a[1];
    const dx = (ex - sx) * aspect;
    const dy = ey - sy;
    err += Math.hypot(dx - tx, dy - ty);
    dot += dx * tx + dy * ty;
    tt += tx * tx + ty * ty;
    used++;
  }

  // Holds: the crosshair's shake about its own smoothed path (slow drift isn't shake).
  const calm = smoothOf(p, out.x, out.y, SHAKE_SIGMA_MS);
  let jit = 0;
  let nJit = 0;
  for (const trial of p.rec.trials) {
    if (trial.kind !== 'hold') continue;
    for (let i = lowerBound(p.t, trial.t0 + 1000), end = lowerBound(p.t, trial.end); i < end; i++) {
      jit += ((out.x[i]! - calm.x[i]!) * aspect) ** 2 + (out.y[i]! - calm.y[i]!) ** 2;
      nJit++;
    }
  }

  // Tracks: the delay that best lines the crosshair up with the intent.
  const tracks = p.rec.trials.filter((t) => t.kind === 'track');
  let bestTau = 0;
  let best = Infinity;
  for (let tau = -150; tau <= 300; tau += 5) {
    let e = 0;
    let n = 0;
    for (const trial of tracks)
      for (let i = lowerBound(p.t, trial.t0 + 500), end = lowerBound(p.t, trial.end); i < end; i += 2) {
        const t = p.t[i]! - tau;
        e += ((out.x[i]! - at(p, intent.x, t)) * aspect) ** 2 + (out.y[i]! - at(p, intent.y, t)) ** 2;
        n++;
      }
    if (n && e / n < best) {
      best = e / n;
      bestTau = tau;
    }
  }

  return {
    jumpErr: sig4(used ? err / used : 0),
    gain: sig4(tt ? dot / tt : 0),
    jitter: sig4(nJit ? Math.sqrt(jit / nJit) : 0),
    lagMs: Math.round((tracks.length ? bestTau : 0) + p.rec.latencyMs),
  };
}

const nearest = (grid: number[], v: number) => grid.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

/** Fit a tuning to a training run. Yields progress (0-1); returns the report. */
export function* fitTraining(rec: Recording): Generator<number, FitReport> {
  const p = prepare(rec);
  const base = rec.base;
  const usable = p.jumps.filter((j) => j.used).length;
  let tuning: Tuning = { ...base, mode: 'relative' };

  // Stage 1: gain.
  let used = p.jumps.map((j) => j.used);
  if (usable >= MIN_JUMPS) {
    let best: (GainFit & { c: number }) | null = null;
    for (const c of CURVES) {
      const fit = fitGain(p, c, base.deadzone);
      if (!best || fit.err < best.err) best = { ...fit, c };
    }
    yield 0.1;
    if (best && Number.isFinite(best.err)) {
      used = best.used;
      tuning = applyTune(tuning, {
        accelCurve: best.c,
        sensitivity: Math.abs(best.sx),
        invertX: best.sx < 0,
        invertY: best.sy < 0,
        ratioY: Math.abs(best.sy / best.sx),
      });
    }
  }

  // Stage 2: feel, against a fixed intent.
  const intent = intentFor(p, tuning);
  const loss = (t: Tuning) => feelLoss(p, replay(p, t), intent);
  const keys = Object.keys(GRIDS) as (keyof typeof GRIDS)[];
  for (const k of keys) tuning = applyTune(tuning, { [k]: nearest(GRIDS[k], tuning[k]) });
  let current = loss(tuning);
  const steps = PASSES * keys.reduce((n, k) => n + GRIDS[k].length, 0);
  let done = 0;
  for (let pass = 0; pass < PASSES; pass++) {
    let improved = false;
    for (const k of keys) {
      for (const v of GRIDS[k]) {
        done++;
        if (v === tuning[k]) continue;
        const candidate = applyTune(tuning, { [k]: v });
        const l = loss(candidate);
        if (l < current - 1e-9) {
          current = l;
          tuning = candidate;
          improved = true;
        }
        yield 0.1 + (0.8 * done) / steps;
      }
    }
    if (!improved) break;
  }

  const before = metricsFor(p, base);
  yield 0.95;
  const after = metricsFor(p, tuning);
  return {
    v: 1,
    base,
    fitted: tuning,
    before,
    after,
    usedJumps: used.filter(Boolean).length,
    totalJumps: p.jumps.length,
    latencyMs: Math.round(rec.latencyMs),
    jumps: p.jumps.map((j, k) => {
      let right = 0;
      let up = 0;
      let peak = 0;
      for (let i = j.from; i < j.to; i++) {
        right += p.right[i]! * p.dt[i]!;
        up += p.up[i]! * p.dt[i]!;
        peak = Math.max(peak, p.omega[i]!);
      }
      return { a: j.trial.a, b: j.trial.b!, turn: [sig4(right), sig4(up)], peak: sig4(peak), used: !!used[k] };
    }),
  };
}

/** Run a fit to the end. */
export function runFit(rec: Recording): FitReport {
  const gen = fitTraining(rec);
  for (;;) {
    const step = gen.next();
    if (step.done) return step.value;
  }
}
