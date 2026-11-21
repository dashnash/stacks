/**
 * Ink Koi: a sumi-e brush painting of a pond on rice paper. Koi (birds), dragonflies (clay) and
 * lotus on lily pads (balloons); hit targets sink where they were caught. Ported from the concept
 * page's `koi` object (spec #144), with its seconds turned into ms.
 */
import type { CalibrationView, GunView, TargetView } from '../../../game/protocol';
import type { Ctx, Effect, Palette, Theme } from './types';

export interface KoiPalette extends Palette {
  paper: string;
  ink: string;
  wash: string;
  accent: string;
  lotus: string;
  gold: string;
  /** The calibration dot ("point at the green dot"). */
  moss: string;
  /** Dark grain on light paper, light grain on dark water. */
  darkGrain: boolean;
}

const TAU = Math.PI * 2;
const HIT_MS = 1000;
const BLOOM_MS = 900;
const RIPPLE_MS = 800;
/** One ambient ripple's life. */
const AMBIENT_MS = 4500;

const BRUSH = '"Yuji Syuku", "Hiragino Mincho ProN", "Yu Mincho", serif';
const MINCHO = '"Shippori Mincho", "Hiragino Mincho ProN", "Yu Mincho", Georgia, serif';

// ---- private helpers (each theme keeps its own; spec #144 PRs 2-4 are independent)

function mulberry(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A stable random 0-1 for (id, i). */
const srand = (id: number, i: number) => mulberry(id * 131 + i * 7919 + 17)();

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** A quadratic brush stroke from overlapping dabs, added to the current path (fill once, so alpha doesn't stack). */
function brushQuad(ctx: Ctx, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, w0: number, w1: number) {
  const steps = Math.max(30, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(0.5, Math.min(w0, w1) * 1.2)));
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const v = 1 - u;
    const x = v * v * x0 + 2 * v * u * cx + u * u * x1;
    const y = v * v * y0 + 2 * v * u * cy + u * u * y1;
    const r = Math.max(0.4, w0 + (w1 - w0) * u);
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, TAU);
  }
}

type Tile = OffscreenCanvas;
const grainTiles: Partial<Record<'d' | 'l', Tile | null>> = {};
/** A 140 px tile of paper grain, or null where there is no OffscreenCanvas (tests, old browsers: no grain). */
function grain(dark: boolean): Tile | null {
  const key = dark ? 'd' : 'l';
  if (key in grainTiles) return grainTiles[key]!;
  let tile: Tile | null = null;
  try {
    const c = new OffscreenCanvas(140, 140);
    const g = c.getContext('2d');
    if (g) {
      const img = g.createImageData(140, 140);
      const R = mulberry(dark ? 3 : 5);
      for (let i = 0; i < img.data.length; i += 4) {
        if (R() < 0.4) {
          const v = dark ? 40 : 255;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 10 + R() * 26;
        }
      }
      g.putImageData(img, 0, 0);
      tile = c;
    }
  } catch {
    tile = null;
  }
  return (grainTiles[key] = tile);
}

// ---- the cast

function fish(ctx: Ctx, r: number, s: number, id: number, p: KoiPalette) {
  const sw = Math.sin(s * 7 + id) * 0.3;
  ctx.save();
  ctx.rotate(sw * 0.25);
  // Tail (may spill out of the hitbox).
  ctx.save();
  ctx.translate(-r * 0.8, 0);
  ctx.rotate(-sw);
  ctx.fillStyle = p.ink;
  ctx.globalAlpha *= 0.72;
  ctx.beginPath();
  ctx.moveTo(r * 0.05, 0);
  ctx.quadraticCurveTo(-r * 0.35, -r * 0.2, -r * 0.72, -r * 0.55);
  ctx.quadraticCurveTo(-r * 0.5, 0, -r * 0.72, r * 0.55);
  ctx.quadraticCurveTo(-r * 0.35, r * 0.2, r * 0.05, 0);
  ctx.fill();
  ctx.restore();
  // Fins.
  ctx.save();
  ctx.fillStyle = p.ink;
  ctx.globalAlpha *= 0.42;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(r * 0.3, side * r * 0.42, r * 0.3, r * 0.11, side * 0.7, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  // Body: nose at 1.05 r, inside the 1.1 r hitbox.
  const g = ctx.createLinearGradient(-r, 0, r, 0);
  g.addColorStop(0, p.wash);
  g.addColorStop(0.55, p.ink);
  g.addColorStop(1, p.ink);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(r * 1.05, 0);
  ctx.bezierCurveTo(r * 0.9, -r * 0.5, -r * 0.3, -r * 0.46, -r * 0.85, -r * 0.06);
  ctx.lineTo(-r * 0.85, r * 0.06);
  ctx.bezierCurveTo(-r * 0.3, r * 0.46, r * 0.9, r * 0.5, r * 1.05, 0);
  ctx.fill();
  // The red or gold patch.
  ctx.fillStyle = id % 2 ? p.accent : p.gold;
  ctx.beginPath();
  ctx.ellipse(r * 0.45, 0, r * 0.32, r * 0.22, 0, 0, TAU);
  ctx.fill();
  if (id % 3 === 0) {
    ctx.beginPath();
    ctx.ellipse(-r * 0.2, r * 0.06, r * 0.18, r * 0.13, 0.4, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function dragonfly(ctx: Ctx, r: number, s: number, id: number, p: KoiPalette) {
  const f = Math.sin(s * 55 + id) * 0.22;
  for (const [ax, ang] of [
    [r * 0.25, 1.25],
    [r * 0.25, -1.25],
    [-r * 0.05, 1.85],
    [-r * 0.05, -1.85],
  ] as const) {
    ctx.save();
    ctx.translate(ax, 0);
    ctx.rotate(ang + (ang > 0 ? f : -f));
    ctx.beginPath();
    ctx.ellipse(r * 0.5, 0, r * 0.55, r * 0.13, 0, 0, TAU);
    ctx.fillStyle = rgba(p.ink, 0.2);
    ctx.fill();
    ctx.strokeStyle = rgba(p.ink, 0.65);
    ctx.lineWidth = Math.max(1, r * 0.035);
    ctx.stroke();
    ctx.restore();
  }
  // Head, thorax and the long abdomen (its tip, past 1.1 r, is tail).
  ctx.strokeStyle = p.ink;
  ctx.fillStyle = p.ink;
  ctx.lineCap = 'round';
  ctx.lineWidth = r * 0.16;
  ctx.beginPath();
  ctx.moveTo(-r * 1.15, 0);
  ctx.lineTo(r * 0.45, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(r * 0.6, 0, r * 0.2, 0, TAU);
  ctx.fill();
}

function lotus(ctx: Ctx, r: number, s: number, id: number, p: KoiPalette) {
  // The lily pad, with its notch: inside 1.1 r.
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.ellipse(0, r * 0.1, r * 1.05, r * 0.85, 0, -1.2, -1.2 + TAU - 0.45);
  ctx.closePath();
  ctx.fillStyle = rgba(p.wash, 0.28);
  ctx.fill();
  const open = 0.72 + 0.28 * Math.sin(s * 1.3 + id);
  for (const [n, dist, len, wid] of [
    [8, 0.4, 0.42, 0.17],
    [5, 0.2, 0.28, 0.13],
  ] as const) {
    for (let i = 0; i < n; i++) {
      ctx.save();
      ctx.rotate((i / n) * TAU + id + (n === 5 ? 0.3 : 0));
      ctx.beginPath();
      ctx.ellipse(r * dist * open, 0, r * len, r * wid, 0, 0, TAU);
      ctx.fillStyle = rgba(p.lotus, n === 5 ? 0.75 : 0.5);
      ctx.fill();
      ctx.strokeStyle = rgba(p.lotus, 0.95);
      ctx.lineWidth = Math.max(1, r * 0.03);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.fillStyle = p.gold;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.13, 0, TAU);
  ctx.fill();
}

/** An ensō: an open brush circle, thick where the brush lands and thinning out. */
function enso(ctx: Ctx, x: number, y: number, s: number, a0: number, h: number) {
  const N = 52;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const a = a0 + u * Math.PI * 1.82;
    const r = h * (0.0075 * (1 - u) + 0.0014) * (1 + 0.25 * Math.sin(u * 9));
    const px = x + Math.cos(a) * s;
    const py = y + Math.sin(a) * s;
    ctx.moveTo(px + r, py);
    ctx.arc(px, py, r, 0, TAU);
  }
  ctx.fill();
}

const css = (p: { paper: string; ink: string; accent: string; trigger: string; banner: string }) => ({
  '--sky-bg': p.paper,
  '--hud-fg': p.ink,
  '--hud-accent': p.ink,
  '--hud-shell': p.ink,
  '--hud-font': MINCHO,
  '--banner-bg': p.banner,
  '--gun-bg': p.paper,
  '--gun-fg': p.ink,
  '--trigger-bg': p.trigger,
  '--trigger-fg': p.ink,
  '--trigger-font': MINCHO,
  '--koi-seal': p.accent,
  '--koi-paper': p.paper,
  '--koi-brush': BRUSH,
});

export const koi: Theme<KoiPalette> = {
  id: 'koi',
  name: 'Ink Koi',
  palettes: {
    rice: {
      name: 'Rice paper',
      paper: '#ede4cf',
      ink: '#1c1b19',
      wash: '#55524b',
      accent: '#c23a22',
      lotus: '#cf5f78',
      gold: '#b7862c',
      moss: '#2e6b3c',
      seats: ['#c23a22', '#23439a', '#7a5200'],
      // The paper under its faint ink washes (the washes darken it a little).
      ground: '#e3dac6',
      darkGrain: true,
      css: css({ paper: '#ede4cf', ink: '#1c1b19', accent: '#c23a22', trigger: '#e4d9bf', banner: 'rgba(237, 228, 207, 0.92)' }),
    },
    moon: {
      name: 'Moon pond',
      paper: '#111b24',
      ink: '#e8dec6',
      wash: '#93a6b5',
      accent: '#ff6b4a',
      lotus: '#f08aa0',
      gold: '#e3b55a',
      moss: '#7fd18b',
      seats: ['#ff6b4a', '#86bcff', '#f2c94c'],
      // The water under its pale washes (they lighten it a little).
      ground: '#1d2831',
      darkGrain: false,
      css: css({ paper: '#111b24', ink: '#e8dec6', accent: '#ff6b4a', trigger: '#18242f', banner: 'rgba(17, 27, 36, 0.92)' }),
    },
  },
  hitMotion: 'sink',
  hitMs: HIT_MS,
  verb: { tap: 'Tap to catch', flick: 'Flick to catch' },
  shells: ['●', '○'],
  fonts: ['400 1em "Yuji Syuku"', '700 1em "Shippori Mincho"'],

  background(ctx, w, h, p) {
    ctx.fillStyle = p.paper;
    ctx.fillRect(0, 0, w, h);
    const R = mulberry(11);
    // Ink washes.
    for (let i = 0; i < 8; i++) {
      const x = R() * w;
      const y = R() * h;
      const r = h * (0.15 + R() * 0.35);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(p.wash, 0.13));
      g.addColorStop(1, rgba(p.wash, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    // Lily pads.
    for (const [px, py, s, a] of [
      [0.14, 0.32, 0.07, 0.4],
      [0.86, 0.62, 0.09, 2.1],
      [0.66, 0.2, 0.05, 4],
      [0.32, 0.74, 0.06, 1.2],
    ] as const) {
      const r = s * h;
      ctx.save();
      ctx.translate(px * w, py * h);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.ellipse(0, 0, r, r * 0.86, 0, 0.25, TAU - 0.05);
      ctx.closePath();
      ctx.fillStyle = rgba(p.wash, 0.16);
      ctx.fill();
      ctx.strokeStyle = rgba(p.ink, 0.3);
      ctx.lineWidth = Math.max(1, h * 0.0016);
      ctx.stroke();
      ctx.restore();
    }
    // Reeds at both edges, and their seed heads.
    ctx.fillStyle = rgba(p.ink, 0.72);
    ctx.beginPath();
    for (const [x0, side] of [
      [0.015, 1],
      [0.985, -1],
    ] as const) {
      for (let i = 0; i < 7; i++) {
        const bx = w * (x0 + side * i * 0.011);
        const tx = bx + side * (R() - 0.25) * w * 0.06;
        const ty = h * (0.5 + R() * 0.25);
        brushQuad(ctx, bx, h * 1.02, bx + side * w * 0.01, (h + ty) / 2, tx, ty, h * 0.0055, h * 0.0007);
      }
    }
    ctx.fill();
    ctx.fillStyle = rgba(p.ink, 0.8);
    for (const [x, y] of [
      [0.035, 0.56],
      [0.965, 0.6],
    ] as const) {
      ctx.beginPath();
      ctx.ellipse(x * w, y * h, h * 0.006, h * 0.022, 0.1, 0, TAU);
      ctx.fill();
    }
  },

  ambient(ctx, w, h, now, p) {
    // Three slow ripples, each somewhere new every cycle: three strokes a frame.
    ctx.lineWidth = Math.max(1, h * 0.0018);
    for (let i = 0; i < 3; i++) {
      const cyc = now / AMBIENT_MS + i / 3;
      const ph = cyc % 1;
      const n = Math.floor(cyc);
      const x = (0.15 + srand(n, i) * 0.7) * w;
      const y = (0.15 + srand(n, i + 5) * 0.7) * h;
      ctx.strokeStyle = rgba(p.ink, (1 - ph) * 0.14);
      ctx.beginPath();
      ctx.arc(x, y, h * (0.02 + ph * 0.12), 0, TAU);
      ctx.stroke();
    }
  },

  overlay(ctx, w, h, p) {
    const tile = grain(p.darkGrain);
    const pattern = tile && ctx.createPattern(tile, 'repeat');
    if (!pattern) return;
    // One grain dot per device pixel, as on the concept page.
    const k = ctx.getTransform?.()?.a || 1;
    ctx.globalAlpha = 0.9;
    ctx.scale(1 / k, 1 / k);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w * k, h * k);
  },

  target(ctx: Ctx, t: TargetView, r: number, now: number, p, hitAge: number) {
    const s = now / 1000;
    if (hitAge >= 0) {
      // Sink: shrink and fade where it was caught.
      const k = Math.min(1, hitAge / HIT_MS);
      ctx.globalAlpha *= 1 - k;
      ctx.scale(1 - k * 0.45, 1 - k * 0.45);
    }
    if (t.k === 0) {
      ctx.rotate(t.h);
      fish(ctx, r, s, t.id, p);
    } else if (t.k === 1) {
      ctx.rotate(t.h);
      dragonfly(ctx, r, s, t.id, p);
    } else lotus(ctx, r, s, t.id, p);
  },

  effect(ctx: Ctx, e: Effect, w: number, h: number, now: number, p) {
    const x = e.x * w;
    const y = e.y * h;
    if (e.kind === 'hit') {
      // An ink bloom where it was caught, and the points in red brush.
      const k = (now - e.at) / BLOOM_MS;
      if (k < 0 || k > 1) return;
      const R = (e.r ?? 0.05) * h;
      ctx.fillStyle = rgba(p.ink, (1 - k) * 0.4);
      ctx.beginPath();
      for (let i = 0; i < 9; i++) {
        const a = srand(e.id, i) * TAU;
        const d = R * (0.2 + srand(e.id, i + 9) * 0.8) * (0.4 + k);
        const r = R * (0.3 + srand(e.id, i + 20) * 0.4) * (0.5 + k * 1.4);
        const bx = x + Math.cos(a) * d;
        const by = y + Math.sin(a) * d;
        ctx.moveTo(bx + r, by);
        ctx.arc(bx, by, r, 0, TAU);
      }
      ctx.fill();
      if (e.pts) {
        ctx.fillStyle = rgba(p.accent, 1 - k);
        ctx.font = `${Math.round(h * 0.05)}px ${BRUSH}`;
        ctx.textAlign = 'center';
        ctx.fillText(`+${e.pts}`, x, y - R - k * h * 0.05);
      }
    } else {
      // Two ripple rings.
      const k = (now - e.at) / RIPPLE_MS;
      if (k < 0 || k > 1) return;
      ctx.strokeStyle = rgba(p.ink, (1 - k) * 0.7);
      ctx.lineWidth = Math.max(1, h * 0.003);
      for (const [a, b] of [
        [0.012, 0.07],
        [0.004, 0.04],
      ] as const) {
        ctx.beginPath();
        ctx.arc(x, y, h * (a + k * b), 0, TAU);
        ctx.stroke();
      }
    }
  },

  crosshair(ctx: Ctx, g: GunView, { x, y, raw }, h: number, now: number, p) {
    const col = p.seats[g.c % p.seats.length]!;
    const s = h * 0.04;
    if (raw) {
      ctx.strokeStyle = rgba(p.ink, 0.6);
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(raw[0], raw[1], s * 0.6, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = col;
    enso(ctx, x, y, s, g.c * 2 + (now / 1000) * 0.3, h);
    ctx.beginPath();
    ctx.arc(x, y, h * 0.005, 0, TAU);
    ctx.fill();
  },

  calibration(ctx: Ctx, w: number, h: number, now: number, p, at: { centre: boolean; cal?: CalibrationView }) {
    // Dusk's white and lime dots vanish on rice paper: ink dots and a moss-green ensō instead.
    if (at.centre) {
      ctx.fillStyle = p.ink;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.max(8, h * 0.015), 0, TAU);
      ctx.fill();
      ctx.strokeStyle = rgba(p.ink, 0.45);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, h * 0.05 + (Math.sin(now / 300) + 1) * h * 0.01, 0, TAU);
      ctx.stroke();
    }
    const cal = at.cal;
    if (!cal) return;
    const r = Math.max(10, h * 0.02);
    cal.pts.forEach(([px, py], k) => {
      if (k === cal.i) return;
      ctx.strokeStyle = k < cal.i ? rgba(p.moss, 0.55) : rgba(p.ink, 0.35);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px * w, py * h, r * 0.6, 0, TAU);
      ctx.stroke();
    });
    const [x, y] = cal.pts[cal.i] ?? [0.5, 0.5];
    ctx.fillStyle = p.moss;
    ctx.beginPath();
    ctx.arc(x * w, y * h, r * 0.45, 0, TAU);
    ctx.fill();
    enso(ctx, x * w, y * h, r + (Math.sin(now / 250) + 1) * 3, now / 1000, h);
  },
};
