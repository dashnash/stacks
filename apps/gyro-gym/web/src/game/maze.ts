import type { Tilt } from '../motion/tilt';

/** The maze: `#` wall, `.` floor, `S` start, `G` goal (the hole). One cell is one unit. */
export const MAZE = [
  '#########',
  '#S..#...#',
  '###.#.#.#',
  '#...#.#.#',
  '#.###.#.#',
  '#.....#.#',
  '#####.#.#',
  '#.....#.#',
  '#.#####.#',
  '#.#...#.#',
  '#.#.#.#.#',
  '#...#..G#',
  '#########',
];

export const BALL_R = 0.3;
/** Cells per second² at a full tilt. */
export const ACCEL = 18;
/** Fraction of speed lost per second when rolling. */
export const FRICTION = 0.9;
/** Speed kept (and reversed) when bouncing off a wall. */
export const BOUNCE = 0.35;
/** Slower than this (cells/s) into a wall is a bump, not a hit. */
export const HIT_SPEED = 1.5;
export const MAX_SPEED = 14;

export interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface StepResult {
  /** The hardest wall hit this step (its speed into the wall), or 0. */
  hit: number;
  goal: boolean;
}

export const width = (m = MAZE) => m[0]!.length;
export const height = (m = MAZE) => m.length;
export const isWall = (cx: number, cy: number, m = MAZE) => cy < 0 || cy >= m.length || cx < 0 || cx >= m[0]!.length || m[cy]![cx] === '#';

export function find(ch: 'S' | 'G', m = MAZE): { x: number; y: number } {
  for (let y = 0; y < m.length; y++) {
    const x = m[y]!.indexOf(ch);
    if (x >= 0) return { x: x + 0.5, y: y + 0.5 };
  }
  throw new Error(`No ${ch} in the maze`);
}

export const startBall = (m = MAZE): Ball => ({ ...find('S', m), vx: 0, vy: 0 });

/** Push the ball out of every wall cell it overlaps; returns the speed it hit with. */
function collide(b: Ball, m: string[]): number {
  let hit = 0;
  const x0 = Math.floor(b.x - BALL_R);
  const x1 = Math.floor(b.x + BALL_R);
  const y0 = Math.floor(b.y - BALL_R);
  const y1 = Math.floor(b.y + BALL_R);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (!isWall(cx, cy, m)) continue;
      const px = Math.max(cx, Math.min(b.x, cx + 1));
      const py = Math.max(cy, Math.min(b.y, cy + 1));
      let dx = b.x - px;
      let dy = b.y - py;
      let d = Math.hypot(dx, dy);
      if (d >= BALL_R) continue;
      if (d === 0) {
        // Centre inside the wall (a huge step): push out the shortest way.
        const left = b.x - cx, right = cx + 1 - b.x, up = b.y - cy, down = cy + 1 - b.y;
        const min = Math.min(left, right, up, down);
        [dx, dy] = min === left ? [-1, 0] : min === right ? [1, 0] : min === up ? [0, -1] : [0, 1];
        d = 0;
      } else {
        dx /= d;
        dy /= d;
      }
      b.x += dx * (BALL_R - d);
      b.y += dy * (BALL_R - d);
      const into = -(b.vx * dx + b.vy * dy);
      if (into > 0) {
        b.vx += (1 + BOUNCE) * into * dx;
        b.vy += (1 + BOUNCE) * into * dy;
        hit = Math.max(hit, into);
      }
    }
  }
  return hit;
}

/** Advance the ball by `dt` seconds under `tilt`. Small substeps so it never tunnels through a wall. */
export function step(b: Ball, tilt: Tilt, dt: number, m = MAZE): StepResult {
  let hit = 0;
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    b.vx += tilt.x * ACCEL * h;
    b.vy += tilt.y * ACCEL * h;
    const keep = Math.max(0, 1 - FRICTION * h);
    b.vx *= keep;
    b.vy *= keep;
    const speed = Math.hypot(b.vx, b.vy);
    if (speed > MAX_SPEED) {
      b.vx *= MAX_SPEED / speed;
      b.vy *= MAX_SPEED / speed;
    }
    b.x += b.vx * h;
    b.y += b.vy * h;
    hit = Math.max(hit, collide(b, m));
  }
  const g = find('G', m);
  return { hit: hit >= HIT_SPEED ? hit : 0, goal: Math.hypot(b.x - g.x, b.y - g.y) < 0.35 };
}

/** Is there a way from S to G? (For tests: a maze change must stay solvable.) */
export function solvable(m = MAZE): boolean {
  const s = find('S', m);
  const g = find('G', m);
  const seen = new Set<string>();
  const queue = [[Math.floor(s.x), Math.floor(s.y)]];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    if (x === Math.floor(g.x) && y === Math.floor(g.y)) return true;
    for (const [nx, ny] of [[x! + 1, y!], [x! - 1, y!], [x!, y! + 1], [x!, y! - 1]]) {
      const k = `${nx},${ny}`;
      if (!seen.has(k) && !isWall(nx!, ny!, m)) {
        seen.add(k);
        queue.push([nx!, ny!]);
      }
    }
  }
  return false;
}

/** Best time in ms, kept in this browser only. */
const BEST_KEY = 'gyro-gym:best-ms';
export function loadBest(): number | null {
  try {
    const v = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
export function saveBest(ms: number): boolean {
  const best = loadBest();
  if (best !== null && best <= ms) return false;
  try {
    localStorage.setItem(BEST_KEY, String(Math.round(ms)));
  } catch {
    /* private mode: the best time lasts this visit only */
  }
  return true;
}
