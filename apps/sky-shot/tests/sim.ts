/**
 * A simulated player for the training tests: a hand whose own sense of "this far" is a known
 * relative mapping (`feel`). Given a script, it makes the motion a person would: smooth
 * (minimum-jerk) turns for jumps, a delayed follow for tracks, and tremor throughout. The phone can
 * be held flat or upright like a pistol; the fit should not care.
 */
import { qmul, qnorm, qconj, rotate, relativeGain, fromEuler } from '../game/aim';
import type { Quat, Vec3 } from '../game/protocol';
import { GAP_MS, JUMP_AIM_MS, trackAt, type RecSample, type RecTrial, type Recording, type Trial } from '../game/training';
import { DEFAULT_TUNING, type Tuning } from '../game/tuning';

export interface Hand {
  /** The mapping the player expects (what the fit should find). */
  feel: Pick<Tuning, 'sensitivity' | 'accelCurve' | 'ratioY'>;
  /** Pistol grip: the phone upright, screen facing left (a 90° roll about the barrel). */
  pistol?: boolean;
  /** Tremor (8-12 Hz), rad/s RMS. */
  tremor?: number;
  /** Error on each jump's distance (fraction, RMS). */
  scatter?: number;
  /** Reaction time when tracking, ms. */
  reactionMs?: number;
  seed?: number;
}

const HZ = 100;
const DT = 1 / HZ;

function gauss(random: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
}

/** Angular velocity in the room → the next attitude and the gyro reading in device axes. */
export function step(q: Quat, w: Vec3, dt = DT): { q: Quat; r: Vec3 } {
  const angle = Math.hypot(...w) * dt;
  const axis = angle > 1e-12 ? w.map((x) => (x * dt) / angle) : [0, 0, 1];
  const dq: Quat = [axis[0]! * Math.sin(angle / 2), axis[1]! * Math.sin(angle / 2), axis[2]! * Math.sin(angle / 2), Math.cos(angle / 2)];
  const r = rotate(qconj(q), w);
  return { q: qnorm(qmul(dq, q)), r };
}

/**
 * Room-frame angular velocity for turning the barrel right and up at these rates. Turning right is
 * about −z; up is about the horizontal axis across the barrel.
 */
export function worldRate(q: Quat, right: number, up: number): Vec3 {
  const b = rotate(q, [0, 1, 0]);
  const across: Vec3 = [b[1], -b[0], 0];
  const n = Math.hypot(across[0], across[1]) || 1;
  return [(across[0] / n) * up, (across[1] / n) * up, -right];
}

/** Minimum-jerk speed profile on [0, 1] (integrates to 1). */
const minJerk = (s: number) => 30 * s * s * (1 - s) * (1 - s);

/**
 * Rates (right, up) for a jump of `tx` widths and `ty` heights (down +) taking `ms`, under `feel`.
 * Travel is ∫ gain(ω) ω dt with gain ∝ ω^(c−1), so scaling the profile by k scales travel by k^c.
 */
function jumpRates(tx: number, ty: number, ms: number, feel: Hand['feel'], aspect: number): [number, number][] {
  // Direction in turn space: x travel = s·right·…, y travel (heights, down +) = −s·ratioY·aspect·up·…
  const ux = tx;
  const uy = -ty / (feel.ratioY * aspect);
  const len = Math.hypot(ux, uy);
  const n = Math.max(2, Math.round(ms / 1000 / DT));
  if (len < 1e-9) return Array.from({ length: n }, () => [0, 0]);
  const dir = [ux / len, uy / len] as const;
  const travel = (k: number) => {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const w = (k * minJerk((i + 0.5) / n)) / (ms / 1000);
      sum += relativeGain(w, { sensitivity: feel.sensitivity, accelCurve: feel.accelCurve }) * w * DT;
    }
    return sum;
  };
  // Travel at k = 1, then solve k^c · travel(1) = len.
  const k = Math.pow(len / travel(1), 1 / feel.accelCurve);
  return Array.from({ length: n }, (_, i) => {
    const w = (k * minJerk((i + 0.5) / n)) / (ms / 1000);
    return [w * dir[0], w * dir[1]] as [number, number];
  });
}

/** Record a run of `script` the way the server would: samples and trials on one clock (ms). */
export function simulateRun(script: Trial[], hand: Hand, opts: { aspect?: number; latencyMs?: number; base?: Tuning } = {}): Recording {
  const aspect = opts.aspect ?? 16 / 10;
  let seed = hand.seed ?? 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const tremor = hand.tremor ?? 0.1;
  const scatter = hand.scatter ?? 0.06;
  const reaction = hand.reactionMs ?? 150;
  let q: Quat = hand.pistol ? fromEuler(Math.PI / 2, 0, 0) : fromEuler(0, 0, 0);
  const samples: RecSample[] = [];
  const trials: RecTrial[] = [];
  let t = 1000;
  // Physiological tremor: an 8-12 Hz wobble whose phase wanders, plus gyro noise.
  const phase = [random() * 6.28, random() * 6.28];
  const freq = [9 + random() * 2, 9.5 + random() * 2];
  const push = (right: number, up: number) => {
    const s0 = t / 1000;
    phase[0] = phase[0]! + gauss(random) * 0.05;
    phase[1] = phase[1]! + gauss(random) * 0.05;
    const wob = [0, 1].map((k) => tremor * Math.SQRT2 * Math.sin(2 * Math.PI * freq[k]! * s0 + phase[k]!) + gauss(random) * 0.005);
    const s = step(q, worldRate(q, right + wob[0]!, up + wob[1]!));
    q = s.q;
    samples.push({ st: t, q, r: s.r });
    t += DT * 1000;
  };
  const idle = (ms: number) => {
    for (let k = 0; k < ms / (DT * 1000); k++) push(0, 0);
  };
  // The hand's own idea of where the crosshair is, to follow a moving dot.
  for (const trial of script) {
    idle(GAP_MS);
    const rec: RecTrial = { kind: trial.kind, a: trial.a, ...(trial.b ? { b: trial.b } : {}), t0: t, end: t };
    if (trial.kind === 'jump') {
      idle(JUMP_AIM_MS);
      rec.move = t;
      const [ax, ay] = trial.a;
      const [bx, by] = trial.b!;
      const miss = 1 + gauss(random) * scatter;
      const dist = Math.hypot((bx - ax) * aspect, by - ay);
      const ms = 350 + 900 * dist + random() * 100;
      // Wait out the reaction, move, then hold.
      idle(reaction);
      const rates = jumpRates((bx - ax) * miss, (by - ay) * miss, ms, hand.feel, aspect);
      for (const [right, up] of rates) push(right, up);
      idle(trial.ms - JUMP_AIM_MS - reaction - rates.length * DT * 1000);
    } else if (trial.kind === 'track') {
      // Follow the dot as it was `reaction` ago, converting screen speed back to turn rates.
      const n = trial.ms / (DT * 1000);
      for (let k = 0; k < n; k++) {
        const ms = k * DT * 1000 - reaction;
        const p0 = trackAt(trial, Math.max(0, ms));
        const p1 = trackAt(trial, Math.max(0, ms + DT * 1000));
        const vx = (p1[0] - p0[0]) / DT;
        const vy = (p1[1] - p0[1]) / DT;
        const speed = Math.hypot(vx, -vy / (hand.feel.ratioY * aspect));
        // screen speed = s · ω^c  →  ω = (speed / s)^(1/c)
        const w = speed > 1e-9 ? Math.pow(speed / hand.feel.sensitivity, 1 / hand.feel.accelCurve) : 0;
        push(speed > 1e-9 ? (w * vx) / speed : 0, speed > 1e-9 ? (w * (-vy / (hand.feel.ratioY * aspect))) / speed : 0);
      }
    } else idle(trial.ms);
    rec.end = t;
    trials.push(rec);
  }
  return { samples, trials, aspect, latencyMs: opts.latencyMs ?? 60, base: opts.base ?? { ...DEFAULT_TUNING } };
}
