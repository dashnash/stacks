/**
 * Targets in world units: `x` from 0 to the screen's aspect (width / height), `y` from 0 (top) to 1
 * (bottom), so distances are the same in both directions. Plus ~1 s of per-tick history, so a shot
 * can be tested against where targets were when the screen showed them.
 */
import { TARGET_KINDS, type RangeKind, type TargetKind, type TargetView } from './protocol';

export interface Target {
  id: number;
  kind: TargetKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radius, screen heights. */
  r: number;
  state: 'fly' | 'hit' | 'flee';
  /** Server ms it appeared (time to target, in Range). */
  born: number;
  /** Lateral wobble: amplitude (heights/s) and phase. */
  wobble: number;
  phase: number;
  /** Range pop-ups vanish at this time; other targets flee at it. */
  until: number;
  /** Which release (rounds). */
  wave: number;
}

/** Small deterministic PRNG (mulberry32): the same seed plays the same game, so tests can rely on it. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const RADIUS: Record<TargetKind, number> = { bird: 0.05, clay: 0.035, balloon: 0.06 };
/** How fast a fleeing target leaves (heights/s) and a hit one falls. */
const FLEE_SPEED = 0.9;
const FALL_SPEED = 1.2;
/** Flying targets turn back at these edges (the top band is where they escape). */
const TOP = 0.08;
const BOTTOM = 0.8;

/** A Rounds target: rises from below the screen at a random angle, faster each round. */
export function spawnRoundTarget(id: number, round: number, wave: number, now: number, aspect: number, random: () => number): Target {
  const kind: TargetKind = round >= 2 && random() < 0.35 ? 'clay' : 'bird';
  const speed = (kind === 'clay' ? 0.42 : 0.3) * (1 + 0.15 * (round - 1));
  const angle = (-Math.PI / 2) + (random() - 0.5) * 1.4;
  const flyMs = Math.max(3000, 6500 - round * 350);
  return {
    id,
    kind,
    x: aspect * (0.15 + random() * 0.7),
    y: 1.05,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    r: RADIUS[kind],
    state: 'fly',
    born: now,
    wobble: kind === 'bird' ? 0.08 + 0.03 * round : 0,
    phase: random() * Math.PI * 2,
    until: now + flyMs,
    wave,
  };
}

/** A Range target: still, sweeping side to side, or popping up for two seconds. `speed` 0-2. */
export function spawnRangeTarget(id: number, kind: RangeKind, speed: number, now: number, aspect: number, random: () => number): Target {
  const x = aspect * (0.12 + random() * 0.76);
  const y = 0.15 + random() * 0.6;
  const base: Target = { id, kind: kind === 'popup' ? 'balloon' : 'clay', x, y, vx: 0, vy: 0, r: RADIUS.balloon, state: 'fly', born: now, wobble: 0, phase: 0, until: Infinity, wave: 0 };
  if (kind === 'sweep') return { ...base, kind: 'bird', r: RADIUS.bird, vx: (random() < 0.5 ? -1 : 1) * 0.25 * speed };
  if (kind === 'popup') return { ...base, until: now + 2000 };
  return base;
}

/** Move every target by `dt` seconds. Returns those that left the screen or timed out (to remove). */
export function stepTargets(targets: Target[], dt: number, now: number, aspect: number, range: boolean): Target[] {
  const gone: Target[] = [];
  for (const t of targets) {
    if (t.state === 'hit') {
      t.vx = 0;
      t.vy = FALL_SPEED;
    } else if (t.state === 'fly' && now >= t.until) {
      if (range) {
        gone.push(t);
        continue;
      }
      t.state = 'flee';
    }
    if (t.state === 'flee') {
      t.vx *= 0.9;
      t.vy = -FLEE_SPEED;
    }
    const wob = t.state === 'fly' && t.wobble ? Math.cos(now / 400 + t.phase) * t.wobble : 0;
    t.x += (t.vx + wob) * dt;
    t.y += t.vy * dt;
    if (t.state === 'fly') {
      // Bounce inside the play area while flying.
      if (t.x < t.r && t.vx < 0) t.vx = -t.vx;
      if (t.x > aspect - t.r && t.vx > 0) t.vx = -t.vx;
      if (t.y < TOP && t.vy < 0) t.vy = -t.vy;
      if (!range && t.y > BOTTOM && t.vy > 0 && now - t.born > 1200) t.vy = -t.vy;
      t.x = Math.min(aspect + t.r, Math.max(-t.r, t.x));
    }
    if (t.y < -0.2 || t.y > 1.25) gone.push(t);
  }
  return gone;
}

/** One tick of history: each target's id, position, radius and whether it could be hit. */
export interface Frame {
  t: number;
  targets: { id: number; x: number; y: number; r: number; live: boolean }[];
}

/** History length: more than any allowed rewind. */
export const HISTORY_MS = 1000;

export class TargetHistory {
  readonly frames: Frame[] = [];
  record(t: number, targets: Target[]): void {
    this.frames.push({ t, targets: targets.map((g) => ({ id: g.id, x: g.x, y: g.y, r: g.r, live: g.state !== 'hit' })) });
    while (this.frames.length > 2 && this.frames[0]!.t < t - HISTORY_MS) this.frames.shift();
  }
  /** Targets as they were at `t` (interpolated between the two frames around it). */
  at(t: number): Frame['targets'] {
    const f = this.frames;
    if (!f.length) return [];
    if (t <= f[0]!.t) return f[0]!.targets;
    for (let i = f.length - 1; i > 0; i--) {
      const a = f[i - 1]!;
      const b = f[i]!;
      if (t >= a.t) {
        if (t >= b.t) return b.targets;
        const k = (t - a.t) / (b.t - a.t || 1);
        return b.targets.map((tb) => {
          const ta = a.targets.find((x) => x.id === tb.id);
          return ta ? { ...tb, x: ta.x + (tb.x - ta.x) * k, y: ta.y + (tb.y - ta.y) * k, live: ta.live && tb.live } : tb;
        });
      }
    }
    return f[f.length - 1]!.targets;
  }
  clear(): void {
    this.frames.length = 0;
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function targetView(t: Target, aspect: number): TargetView {
  return { id: t.id, k: TARGET_KINDS.indexOf(t.kind), x: r3(t.x / aspect), y: r3(t.y), r: r3(t.r), s: t.state === 'fly' ? 0 : t.state === 'hit' ? 1 : 2, h: r3(Math.atan2(t.vy, t.vx)) };
}
