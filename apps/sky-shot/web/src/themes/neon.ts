/**
 * Neon Courier: a synthwave night delivery run. A gradient sky with a striped sun and a skyline over a
 * perspective grid that scrolls towards you; courier drones, data packets and beacons drawn as
 * glowing wireframes. Ported from the concept art (spec #144).
 *
 * Performance: the sky, sun, skyline, grid verticals and the scanline/vignette overlay are cached
 * layers; `ambient` only draws the scrolling horizontal grid lines, with a cheap two-stroke glow and no
 * `shadowBlur`. `shadowBlur` is used only on targets, effects and crosshairs.
 */
import type { GunView, TargetView } from '../../../game/protocol';
import type { Ctx, Effect, Palette, Theme } from './types';

export interface NeonPalette extends Palette {
  sky0: string;
  sky1: string;
  sun0: string;
  sun1: string;
  city: string;
  win: string;
  floor: string;
  grid: string;
  /** The two neon tubes: `a` (warm) and `b` (cool). */
  a: string;
  b: string;
  text: string;
}

const TAU = Math.PI * 2;
/** Where the floor starts, as a share of the height. */
const HORIZON = 0.62;
const HIT_FX_MS = 750;
const MISS_FX_MS = 500;
const FONT = '"Chakra Petch", "Rajdhani", ui-monospace, "SF Mono", Menlo, monospace';
const TITLE_FONT = '"Tilt Neon", "Chakra Petch", system-ui, sans-serif';

function mulberry(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const srand = (id: number, i: number) => mulberry(id * 131 + i * 7919 + 17)();

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/**
 * Device pixels per CSS pixel of `ctx`'s transform. `shadowBlur` ignores the transform, so glows are
 * scaled by this to look the same at every pixel ratio (the concept art drew in device pixels).
 */
function deviceScale(ctx: Ctx) {
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : undefined;
  const s = m ? Math.hypot(m.a, m.b) : 1;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** Stroke and glow in one colour. */
function glow(ctx: Ctx, c: string, blur: number) {
  ctx.strokeStyle = c;
  ctx.shadowColor = c;
  ctx.shadowBlur = blur;
}

function drone(ctx: Ctx, r: number, now: number, t: TargetView, p: NeonPalette, blur: number) {
  ctx.rotate(Math.cos(t.h) * 0.25);
  const arms = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const;
  glow(ctx, p.a, blur);
  ctx.beginPath();
  for (const [sx, sy] of arms) {
    ctx.moveTo(sx * r * 0.2, sy * r * 0.1);
    ctx.lineTo(sx * r * 0.72, sy * r * 0.36);
  }
  ctx.stroke();
  // Rotors: a disc and a spinning blade on each arm.
  glow(ctx, p.b, blur);
  for (const [sx, sy] of arms) {
    const cx = sx * r * 0.72;
    const cy = sy * r * 0.36 - r * 0.07;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.32, r * 0.08, 0, 0, TAU);
    ctx.stroke();
    const a = now * 0.028 + sx + sy;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(a) * r * 0.32, cy - Math.sin(a) * r * 0.08);
    ctx.lineTo(cx + Math.cos(a) * r * 0.32, cy + Math.sin(a) * r * 0.08);
    ctx.stroke();
  }
  // The parcel on its hook.
  ctx.beginPath();
  ctx.moveTo(0, r * 0.17);
  ctx.lineTo(0, r * 0.32);
  ctx.stroke();
  roundRect(ctx, -r * 0.16, r * 0.32, r * 0.32, r * 0.26, r * 0.04);
  ctx.stroke();
  // Body and its blinking light.
  glow(ctx, p.a, blur);
  ctx.fillStyle = rgba(p.sky0, 0.85);
  roundRect(ctx, -r * 0.3, -r * 0.17, r * 0.6, r * 0.34, r * 0.09);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = Math.sin(now * 0.008 + t.id) > 0 ? p.b : p.a;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.07, 0, TAU);
  ctx.fill();
}

function packet(ctx: Ctx, r: number, now: number, t: TargetView, p: NeonPalette, blur: number) {
  ctx.rotate(now * 0.0025 + t.id);
  const diamond = (s: number) => {
    ctx.beginPath();
    ctx.moveTo(s, 0);
    ctx.lineTo(0, s);
    ctx.lineTo(-s, 0);
    ctx.lineTo(0, -s);
    ctx.closePath();
  };
  glow(ctx, p.b, blur);
  diamond(r * 0.95);
  ctx.stroke();
  glow(ctx, p.a, blur);
  diamond(r * 0.48);
  ctx.stroke();
  ctx.fillStyle = p.text;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.1, 0, TAU);
  ctx.fill();
}

function beacon(ctx: Ctx, r: number, now: number, t: TargetView, p: NeonPalette, blur: number) {
  // The light beam down to the floor (no glow: it is a soft gradient already).
  const beam = ctx.createLinearGradient(0, r * 0.8, 0, r * 5);
  beam.addColorStop(0, rgba(p.b, 0.4));
  beam.addColorStop(1, rgba(p.b, 0));
  ctx.fillStyle = beam;
  ctx.fillRect(-r * 0.09, r * 0.8, r * 0.18, r * 4.2);
  const hex = (s: number) => {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + Math.PI / 6;
      if (i) ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s);
      else ctx.moveTo(Math.cos(a) * s, Math.sin(a) * s);
    }
    ctx.closePath();
  };
  // A ring pulsing outwards (decoration: it spills past the hitbox).
  const k = (now * 0.0011 + t.id * 0.37) % 1;
  glow(ctx, p.b, blur);
  ctx.save();
  ctx.globalAlpha *= 1 - k;
  hex(r * (0.9 + 0.6 * k));
  ctx.stroke();
  ctx.restore();
  glow(ctx, p.a, blur);
  ctx.lineWidth = Math.max(2, r * 0.1);
  hex(r * 0.8);
  ctx.fillStyle = rgba(p.a, 0.22);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = p.text;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.14, 0, TAU);
  ctx.fill();
}

function palette(name: string, c: Omit<NeonPalette, 'name' | 'css' | 'ground' | 'seats'> & { seats: NeonPalette['seats']; ground: string }): NeonPalette {
  return {
    name,
    ...c,
    css: {
      '--sky-bg': `linear-gradient(${c.sky0}, ${c.sky1} ${HORIZON * 100}%, ${c.floor} ${HORIZON * 100}%)`,
      '--hud-fg': c.text,
      '--hud-accent': c.b,
      '--hud-shell': c.a,
      '--hud-shell-spent': rgba(c.a, 0.5),
      '--hud-glow': c.b,
      '--hud-font': FONT,
      '--title-font': TITLE_FONT,
      '--banner-bg': rgba(c.sky0, 0.85),
      '--gun-bg': c.sky0,
      '--gun-fg': c.text,
      '--gun-accent': c.a,
      '--trigger-bg': rgba(c.a, 0.12),
      '--trigger-fg': c.text,
      '--trigger-font': FONT,
    },
  };
}

export const neon: Theme<NeonPalette> = {
  id: 'neon',
  name: 'Neon Courier',
  palettes: {
    midnight: palette('Midnight run', {
      sky0: '#05021a',
      sky1: '#2b0b4d',
      sun0: '#ffe66d',
      sun1: '#ff2e88',
      city: '#0b0620',
      win: '#ff8ad8',
      floor: '#07031a',
      grid: '#ff2bd6',
      a: '#ff2bd6',
      b: '#22e6ff',
      text: '#eaf7ff',
      seats: ['#ffe14a', '#7dff6a', '#ffffff'],
      // The middle of the sky gradient (the floor below is darker still).
      ground: '#180633',
    }),
    amber: palette('Amber terminal', {
      sky0: '#0a0500',
      sky1: '#2c1400',
      sun0: '#fff1b8',
      sun1: '#ff7a00',
      city: '#130a00',
      win: '#ffb347',
      floor: '#070400',
      grid: '#ff9d1a',
      a: '#ff9d1a',
      b: '#19f0c5',
      text: '#fff3e0',
      seats: ['#ffffff', '#ff4f8b', '#9dff4a'],
      ground: '#1b0c00',
    }),
  },
  hitMotion: 'fall',
  hitMs: 0,
  verb: { tap: 'Tap to sign', flick: 'Flick to sign' },
  shells: ['▮', '▯'],
  fonts: ['700 1em "Chakra Petch"', '500 1em "Chakra Petch"', '400 1em "Tilt Neon"'],

  background(ctx, w, h, p) {
    const s = deviceScale(ctx);
    const hz = h * HORIZON;
    const sky = ctx.createLinearGradient(0, 0, 0, hz);
    sky.addColorStop(0, p.sky0);
    sky.addColorStop(1, p.sky1);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, hz);
    // Stars.
    const R0 = mulberry(9);
    ctx.fillStyle = rgba(p.text, 0.6);
    const dot = Math.max(1, h * 0.002);
    for (let i = 0; i < 50; i++) ctx.fillRect(R0() * w, R0() * hz * 0.8, dot, dot);
    // The sun, glowing, with stripes cut out of its lower half (painted back with the sky).
    const sr = h * 0.24;
    const cx = w * 0.5;
    const sun = ctx.createLinearGradient(0, hz - sr, 0, hz);
    sun.addColorStop(0, p.sun0);
    sun.addColorStop(1, p.sun1);
    ctx.save();
    ctx.shadowColor = p.sun1;
    ctx.shadowBlur = h * 0.05 * s;
    ctx.fillStyle = sun;
    ctx.beginPath();
    ctx.arc(cx, hz, sr, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = sky;
    for (let i = 0; i < 7; i++) {
      const y = hz - sr * 0.55 + i * sr * 0.085;
      const sh = sr * (0.012 + i * 0.008);
      const half = Math.sqrt(Math.max(0, sr * sr - (hz - y - sh) ** 2)) + 2;
      ctx.fillRect(cx - half, y, half * 2, sh);
    }
    ctx.fillStyle = p.floor;
    ctx.fillRect(0, hz, w, h - hz);
    // The skyline, lower in the middle so the sun shows, with lit windows.
    const R = mulberry(42);
    const ws = Math.max(1, h * 0.006);
    let x = 0;
    while (x < w) {
      const bw = w * (0.025 + R() * 0.045);
      const bh = h * (0.05 + R() * 0.17) * (Math.abs(x + bw / 2 - w / 2) < w * 0.17 ? 0.45 : 1);
      ctx.fillStyle = p.city;
      ctx.fillRect(x, hz - bh, bw + 1, bh);
      ctx.fillStyle = rgba(p.win, 0.55);
      for (let wy = hz - bh + ws * 2; wy < hz - ws; wy += ws * 2.6) for (let wx = x + ws; wx < x + bw - ws; wx += ws * 2.4) if (R() < 0.22) ctx.fillRect(wx, wy, ws, ws);
      x += bw;
    }
    // The horizon line and the grid's still verticals.
    ctx.save();
    ctx.strokeStyle = p.grid;
    ctx.shadowColor = p.grid;
    ctx.shadowBlur = h * 0.012 * s;
    ctx.lineWidth = Math.max(1, h * 0.003);
    ctx.beginPath();
    ctx.moveTo(0, hz);
    ctx.lineTo(w, hz);
    ctx.stroke();
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = Math.max(1, h * 0.0018);
    ctx.beginPath();
    for (let i = -16; i <= 16; i++) {
      ctx.moveTo(w / 2 + i * w * 0.015, hz);
      ctx.lineTo(w / 2 + i * w * 0.15, h);
    }
    ctx.stroke();
    ctx.restore();
  },

  ambient(ctx, w, h, now, p) {
    // The grid's horizontal lines scrolling towards you. The glow is a wide faint stroke under a thin
    // bright one: no shadowBlur, since this runs every frame.
    const hz = h * HORIZON;
    ctx.strokeStyle = p.grid;
    const scroll = (now * 0.0011) % 1;
    for (let j = 0; j < 12; j++) {
      const k = (j + scroll) / 12;
      const y = hz + (h - hz) * k * k;
      const lw = Math.max(1, h * (0.001 + k * 0.003));
      const alpha = 0.25 + k * 0.7;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.globalAlpha = alpha * 0.22;
      ctx.lineWidth = lw + h * 0.008;
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  },

  overlay(ctx, w, h) {
    // Scanlines and a vignette. Faint enough to tint the crosshairs, never hide them.
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    const step = Math.max(3, Math.round(h / 240));
    for (let y = 0; y < h; y += step) ctx.fillRect(0, y, w, Math.max(1, step / 3));
    const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, w * 0.62);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
  },

  target(ctx, t, r, now, p, hitAge) {
    // A hit target falls (the server moves it), flickering.
    if (hitAge >= 0) ctx.globalAlpha *= Math.sin(hitAge * 0.07) > 0 ? 1 : 0.25;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, r * 0.08);
    const blur = r * 0.5 * deviceScale(ctx);
    if (t.k === 0) drone(ctx, r, now, t, p, blur);
    else if (t.k === 1) packet(ctx, r, now, t, p, blur);
    else beacon(ctx, r, now, t, p, blur);
  },

  effect(ctx, e: Effect, w, h, now, p) {
    const x = e.x * w;
    const y = e.y * h;
    const s = deviceScale(ctx);
    if (e.kind === 'hit') {
      // Vector shards flying out, and a SIGNED stamp in the shooter's colour.
      const k = (now - e.at) / HIT_FX_MS;
      if (k < 0 || k > 1) return;
      const R = (e.r ?? 0.05) * h;
      ctx.lineWidth = Math.max(1.5, h * 0.004);
      ctx.lineCap = 'round';
      for (let i = 0; i < 11; i++) {
        const a = srand(e.id, i) * TAU;
        const d = R * (0.4 + k * 2.4);
        const L = R * 0.4 * (1 - k);
        const rot = a + k * 5;
        const px = x + Math.cos(a) * d;
        const py = y + Math.sin(a) * d;
        const c = i % 2 ? p.a : p.b;
        ctx.strokeStyle = rgba(c, 1 - k);
        ctx.shadowColor = c;
        ctx.shadowBlur = h * 0.01 * s;
        ctx.beginPath();
        ctx.moveTo(px - Math.cos(rot) * L, py - Math.sin(rot) * L);
        ctx.lineTo(px + Math.cos(rot) * L, py + Math.sin(rot) * L);
        ctx.stroke();
      }
      if (e.pts) {
        const col = p.seats[e.c % p.seats.length]!;
        ctx.fillStyle = col;
        ctx.shadowColor = col;
        ctx.shadowBlur = h * 0.012 * s;
        ctx.globalAlpha = 1 - k;
        ctx.font = `700 ${Math.round(h * 0.034)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(`SIGNED +${e.pts}`, x, y - R - h * 0.02 - k * h * 0.05);
      }
    } else {
      // An RGB-split glitch square.
      const k = (now - e.at) / MISS_FX_MS;
      if (k < 0 || k > 1) return;
      const size = h * (0.015 + k * 0.05);
      const o = Math.max(2, h * 0.004);
      ctx.lineWidth = Math.max(1.5, h * 0.003);
      for (const [dx, c] of [
        [-o, '#ff2b6d'],
        [0, p.text],
        [o, '#22e6ff'],
      ] as const) {
        ctx.strokeStyle = rgba(c, (1 - k) * 0.85);
        ctx.strokeRect(x - size + dx, y - size, size * 2, size * 2);
      }
    }
  },

  crosshair(ctx, g: GunView, { x, y, raw }, h, _now, p, trail) {
    const col = p.seats[g.c % p.seats.length]!;
    const s = h * 0.032;
    ctx.lineCap = 'round';
    // The light trail, fading towards its tail. It starts after the last jump (a dropped frame, a
    // recalibration), so a jump never draws a streak across the screen.
    ctx.lineWidth = Math.max(1.5, h * 0.004);
    let from = 1;
    for (let i = 1; i < trail.length; i++) if (Math.hypot(trail[i]![0] - trail[i - 1]![0], trail[i]![1] - trail[i - 1]![1]) > h * 0.15) from = i + 1;
    for (let i = from; i < trail.length; i++) {
      ctx.strokeStyle = rgba(col, (i / trail.length) * 0.5);
      ctx.beginPath();
      ctx.moveTo(trail[i - 1]![0], trail[i - 1]![1]);
      ctx.lineTo(trail[i]![0], trail[i]![1]);
      ctx.stroke();
    }
    if (raw) {
      ctx.strokeStyle = rgba(p.text, 0.65);
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(raw[0] - s * 0.6, raw[1] - s * 0.6, s * 1.2, s * 1.2);
      ctx.setLineDash([]);
    }
    // Corner brackets and a small cross.
    const L = s * 0.45;
    ctx.strokeStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = h * 0.012 * deviceScale(ctx);
    ctx.lineWidth = Math.max(2, h * 0.005);
    ctx.beginPath();
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      ctx.moveTo(x + sx * s, y + sy * (s - L));
      ctx.lineTo(x + sx * s, y + sy * s);
      ctx.lineTo(x + sx * (s - L), y + sy * s);
    }
    ctx.moveTo(x - s * 0.25, y);
    ctx.lineTo(x + s * 0.25, y);
    ctx.moveTo(x, y - s * 0.25);
    ctx.lineTo(x, y + s * 0.25);
    ctx.stroke();
  },
};
