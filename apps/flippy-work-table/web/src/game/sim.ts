/**
 * The table-flip simulation. Pure and seeded: the whole flip is computed up front into frames, then
 * the canvas plays them back. Tests run it without a browser.
 *
 * World units are "pixels" of an 800 x 450 stage; y grows downwards.
 */
import { scoreOf } from '../../../api/tools';

export const WORLD = { w: 800, h: 450, floor: 400 };
/** The table: top from x0 to x1 at height `top`, hinged at its far leg's foot. */
export const TABLE = { x0: 120, x1: 460, top: 300, thick: 16, legInset: 18 };
const PIVOT = { x: TABLE.x1 - TABLE.legInset, y: WORLD.floor };
const GRAVITY = 1400;
const DT = 1 / 120;
const MAX_T = 6;

export interface ItemDef {
  id: string;
  label: string;
  emoji: string;
  /** Half width / height of the item's box. */
  w: number;
  h: number;
  /** Damage per unit of hard impact speed. */
  fragility: number;
  /** Damage it takes to break. */
  hp: number;
  color: string;
}

/** What sits on the table. Deliberately random office junk. */
export const ITEMS: ItemDef[] = [
  { id: 'monitor', label: 'Мonitor', emoji: '🖥️', w: 34, h: 28, fragility: 2.2, hp: 900, color: '#333' },
  { id: 'keyboard', label: 'Keybоard', emoji: '⌨️', w: 34, h: 8, fragility: 1.2, hp: 500, color: '#999' },
  { id: 'mug', label: 'Coffe mug', emoji: '☕', w: 12, h: 13, fragility: 3, hp: 250, color: '#c33' },
  { id: 'plant', label: 'Plant (fake)', emoji: '🪴', w: 14, h: 20, fragility: 1.5, hp: 400, color: '#3a3' },
  { id: 'lamp', label: 'Lamp', emoji: '💡', w: 10, h: 22, fragility: 2.6, hp: 300, color: '#fc3' },
  { id: 'stapler', label: 'Stapler', emoji: '📎', w: 14, h: 6, fragility: 0.6, hp: 2000, color: '#a22' },
  { id: 'phone', label: 'Phonе', emoji: '📱', w: 8, h: 14, fragility: 3.4, hp: 220, color: '#225' },
  { id: 'papers', label: 'Papers ТПС report', emoji: '📄', w: 16, h: 4, fragility: 0.3, hp: 5000, color: '#eee' },
  { id: 'trophy', label: 'Trophy "Best employe"', emoji: '🏆', w: 10, h: 14, fragility: 1.8, hp: 600, color: '#db2' },
];

/** Where each item rests on the table (x of its centre). */
const LAYOUT: Record<string, number> = {
  monitor: 190, keyboard: 280, mug: 360, plant: 430, lamp: 142, stapler: 320, phone: 395, papers: 235, trophy: 342,
};

export interface ItemFrame {
  x: number;
  y: number;
  a: number;
  broken: boolean;
}
export interface Frame {
  t: number;
  /** Table rotation about the pivot (0 = standing, π = upside down). */
  table: number;
  items: ItemFrame[];
  damage: number;
}

export interface ItemResult {
  id: string;
  label: string;
  damage: number;
  broken: boolean;
}

export interface FlipResult {
  frames: Frame[];
  /** False if the table didn't go over (too weak a pull). Items still wobble. */
  flipped: boolean;
  damage: number;
  hangMs: number;
  score: number;
  items: ItemResult[];
  duration: number;
}

/** Small seeded PRNG (mulberry32), so a flip with the same seed always plays the same. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resting positions, for drawing the table before a flip. */
export function restingFrame(): Frame {
  return {
    t: 0,
    table: 0,
    damage: 0,
    items: ITEMS.map((d) => ({ x: LAYOUT[d.id]!, y: TABLE.top - d.h, a: 0, broken: false })),
  };
}

/**
 * Simulate a flip. `strength` is roughly 0.3 (weak) to 3 (rocket); 1 is a decent swipe.
 * The table needs about 0.55 to go over.
 */
export function simulateFlip(strength: number, seed = 1): FlipResult {
  const rand = rng(seed);
  const s = Math.max(0, Math.min(strength, 4));
  const L = PIVOT.x - TABLE.x0; // lever length from pivot to the front edge
  const alphaK = (3 * GRAVITY) / (2 * L);
  let theta = 0;
  let omega = s * 6.2;
  let tableLanded = false;
  let tableDamage = 0;
  let ceilingDamage = 0;

  const bodies = ITEMS.map((d) => {
    const x = LAYOUT[d.id]!;
    const r = PIVOT.x - x; // horizontal distance from the pivot: the front flies higher
    const jitter = () => (rand() - 0.5) * 2;
    // Velocity of that point of the table top as it starts to rotate, plus a kick.
    const vy = -(260 + 500 * s + r * 0.4 * s) * (0.8 + rand() * 0.4);
    const vx = (110 * s + 100 * s * jitter()) * (s > 0.2 ? 1 : 0);
    return {
      d,
      x,
      y: TABLE.top - d.h,
      vx,
      vy: s > 0.2 ? vy : 0,
      a: 0,
      va: jitter() * 9 * s,
      damage: 0,
      broken: false,
      airborne: s > 0.2,
      firstLand: 0,
      resting: s <= 0.2,
    };
  });

  const frames: Frame[] = [];
  let t = 0;
  let step = 0;
  let settledFor = 0;
  while (t < MAX_T) {
    // Table: a rod rotating about its far foot, with gravity torque.
    if (!tableLanded) {
      omega += -alphaK * Math.cos(theta) * DT;
      theta += omega * DT;
      if (theta >= Math.PI) {
        theta = Math.PI;
        tableDamage = Math.round(Math.abs(omega) * 120);
        omega = 0;
        tableLanded = true;
      } else if (theta <= 0 && omega < 0) {
        // Didn't make it over: it falls back onto its legs with a thud.
        theta = 0;
        tableDamage = Math.round(Math.abs(omega) * 10);
        omega = 0;
        tableLanded = true;
      }
    }
    let allResting = true;
    for (const b of bodies) {
      if (b.resting) continue;
      allResting = false;
      b.vy += GRAVITY * DT;
      b.x += b.vx * DT;
      b.y += b.vy * DT;
      b.a += b.va * DT;
      const ground = WORLD.floor - b.d.h;
      if (b.y >= ground) {
        b.y = ground;
        const impact = Math.abs(b.vy);
        if (b.airborne) {
          b.airborne = false;
          b.firstLand = t;
        }
        if (impact > 140) {
          b.damage += Math.round((impact - 140) * b.d.fragility * 0.35);
          if (b.damage >= b.d.hp) b.broken = true;
        }
        b.vy = -b.vy * (b.broken ? 0.2 : 0.38);
        b.vx *= 0.7;
        b.va *= 0.6;
        if (Math.abs(b.vy) < 60) {
          b.vy = 0;
          b.vx *= 0.9;
          if (Math.abs(b.vx) < 8) {
            b.vx = 0;
            b.va = 0;
            b.resting = true;
          }
        }
      }
      // Ceiling: things hit it hard at high strength. It dents (counts as damage), they come back down.
      if (b.y < b.d.h + 4 && b.vy < 0) {
        b.y = b.d.h + 4;
        ceilingDamage += Math.round(Math.abs(b.vy) * 0.3);
        b.vy = Math.abs(b.vy) * 0.3;
      }
      // Walls: bounce off the edges of the stage (no damage, the walls are very soft).
      if (b.x < b.d.w) {
        b.x = b.d.w;
        b.vx = Math.abs(b.vx) * 0.5;
      } else if (b.x > WORLD.w - b.d.w) {
        b.x = WORLD.w - b.d.w;
        b.vx = -Math.abs(b.vx) * 0.5;
      }
    }
    settledFor = allResting && tableLanded ? settledFor + DT : 0;
    if (step % 2 === 0) {
      frames.push({
        t,
        table: theta,
        damage: tableDamage + ceilingDamage + bodies.reduce((n, b) => n + b.damage, 0),
        items: bodies.map((b) => ({ x: b.x, y: b.y, a: b.a, broken: b.broken })),
      });
    }
    if (settledFor > 0.4) break;
    t += DT;
    step++;
  }

  const damage = Math.min(50_000, tableDamage + ceilingDamage + bodies.reduce((n, b) => n + b.damage, 0));
  const hangMs = Math.min(15_000, Math.round(Math.max(0, ...bodies.map((b) => (b.firstLand || (b.airborne ? t : 0)) * 1000))));
  return {
    frames,
    flipped: theta >= Math.PI,
    damage,
    hangMs,
    score: scoreOf(damage, hangMs),
    items: bodies.map((b) => ({ id: b.d.id, label: b.d.label, damage: b.damage, broken: b.broken })),
    duration: t,
  };
}

/** Turn a pointer swipe into a strength: upward speed in stage pixels per second. */
export function swipeStrength(dyUp: number, ms: number): number {
  if (dyUp < 20 || ms <= 0) return 0;
  const speed = dyUp / (ms / 1000);
  return Math.min(1.8, Math.max(0.25, speed / 900));
}

export { PIVOT };
