/**
 * Stargazer: a night sky of layered construction paper. Shooting stars with ribbon tails (bird),
 * paper fireflies (clay) and sleeping stars hanging on threads (balloon). A hit star lights up, pops
 * and fades where it was hit, showering paper confetti. Ported from the concept page's `stars`
 * object (spec #144), with its seconds turned into ms.
 */
import type { GunView, TargetView } from '../../../game/protocol';
import type { Ctx, Effect, Palette, Theme } from './types';

export interface StarsPalette extends Palette {
  sky0: string;
  sky1: string;
  sky2: string;
  /** Back to front. */
  hills: [string, string, string];
  tree: string;
  moon: string;
  star: string;
  unlit: string;
  /** The three ribbon tails of a shooting star. */
  tail: [string, string, string];
  glow: string;
  bug: string;
  confetti: [string, string, string, string];
  tag: string;
  tagInk: string;
}

const TAU = Math.PI * 2;
const FONT = '"Sniglet", "Baloo 2", "Trebuchet MS", system-ui, sans-serif';
/** A hit target pops for this long, starts fading here, and is gone here (ms). */
const POP_MS = 300;
const FADE_AT = 700;
const FADE_MS = 400;
const HIT_FX_MS = 1100;
const MISS_FX_MS = 700;

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

function starPath(ctx: Ctx, r: number, n = 5, inner = 0.46) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const q = i % 2 ? r * inner : r;
    if (i) ctx.lineTo(Math.cos(a) * q, Math.sin(a) * q);
    else ctx.moveTo(Math.cos(a) * q, Math.sin(a) * q);
  }
  ctx.closePath();
}

/**
 * Device pixels per CSS pixel of the current transform. Shadows ignore the transform, so they are
 * scaled by this to look the same at any pixel ratio (the concept drew in device pixels).
 */
function devScale(ctx: Ctx) {
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : undefined;
  const s = m ? Math.hypot(m.a, m.b) : 1;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** A cut-paper drop shadow for something of size `r` (px). */
function paperShadow(ctx: Ctx, r: number) {
  const k = devScale(ctx);
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = r * 0.25 * k;
  ctx.shadowOffsetY = r * 0.08 * k;
}
function glowShadow(ctx: Ctx, color: string, r: number) {
  ctx.shadowColor = color;
  ctx.shadowBlur = r * 1.4 * devScale(ctx);
}
function noShadow(ctx: Ctx) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/** Paper grain tiles (light and dark specks), made once. None where there is no OffscreenCanvas. */
const grains: Partial<Record<'l' | 'd', OffscreenCanvas | null>> = {};
const GRAIN = 140;
function grain(dark: boolean) {
  const key = dark ? 'd' : 'l';
  if (key in grains) return grains[key]!;
  let c: OffscreenCanvas | null = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    c = new OffscreenCanvas(GRAIN, GRAIN);
    const g = c.getContext('2d');
    if (g) {
      const img = g.createImageData(GRAIN, GRAIN);
      const R = mulberry(dark ? 3 : 5);
      for (let i = 0; i < img.data.length; i += 4)
        if (R() < 0.4) {
          const v = dark ? 40 : 255;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 10 + R() * 26;
        }
      g.putImageData(img, 0, 0);
    } else c = null;
  }
  return (grains[key] = c);
}
/** Tile a grain over the area, one grain pixel per device pixel. */
function tile(ctx: Ctx, src: OffscreenCanvas | null, w: number, h: number, alpha: number) {
  if (!src) return;
  const s = GRAIN / devScale(ctx);
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) ctx.drawImage(src, x, y, s, s);
  ctx.restore();
}

function hillY(x: number, w: number, h: number, base: number, amp: number, f1: number, f2: number, s: number) {
  return h * (base - amp * (0.6 * Math.sin((x / w) * Math.PI * f1 + s) + 0.4 * Math.sin((x / w) * Math.PI * f2 + s * 2)));
}

/** Shooting star: a paper star spinning, three ribbon tails streaming behind it (tails don't count for hits). */
function comet(ctx: Ctx, r: number, now: number, t: TargetView, p: StarsPalette, lit: boolean) {
  if (!lit) {
    ctx.save();
    ctx.rotate(t.h);
    paperShadow(ctx, r);
    for (let i = 0; i < 3; i++) {
      const y0 = [-0.22, 0, 0.22][i]! * r;
      const len = r * (2.5 + (i % 2) * 0.8);
      const sw = Math.sin(now * 0.006 + i * 1.7 + t.id) * r * 0.14;
      ctx.fillStyle = p.tail[i]!;
      ctx.beginPath();
      ctx.moveTo(-r * 0.2, y0 - r * 0.12);
      ctx.quadraticCurveTo(-len * 0.5, y0 + sw, -len, y0 * 0.3 + sw * 1.5);
      ctx.quadraticCurveTo(-len * 0.5, y0 + sw + r * 0.06, -r * 0.2, y0 + r * 0.12);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.save();
  if (lit) glowShadow(ctx, p.glow, r);
  else paperShadow(ctx, r);
  ctx.rotate(now * 0.0015 + t.id);
  starPath(ctx, r, 5, 0.48);
  ctx.fillStyle = p.star;
  ctx.fill();
  ctx.restore();
}

/** Firefly: a paper bug with a glowing tail and blurred wings; the glow pulses. */
function firefly(ctx: Ctx, r: number, now: number, t: TargetView, p: StarsPalette, lit: boolean) {
  const pulse = 0.65 + 0.35 * Math.sin(now * 0.003 + t.id) + (lit ? 0.6 : 0);
  ctx.rotate(t.h);
  const g = ctx.createRadialGradient(-r * 0.4, 0, 0, -r * 0.4, 0, r * 1.5 * pulse);
  g.addColorStop(0, rgba(p.glow, 0.55));
  g.addColorStop(1, rgba(p.glow, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(-r * 0.4, 0, r * 1.5 * pulse, 0, TAU);
  ctx.fill();
  const f = Math.sin(now * 0.04 + t.id) * 0.35;
  ctx.fillStyle = 'rgba(255,255,255,.6)';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(r * 0.05, s * r * 0.32, r * 0.5, r * 0.2, s * (0.5 + f), 0, TAU);
    ctx.fill();
  }
  ctx.save();
  paperShadow(ctx, r);
  ctx.fillStyle = lit ? p.star : p.bug;
  ctx.beginPath();
  ctx.ellipse(r * 0.1, 0, r * 0.55, r * 0.36, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = p.glow;
  ctx.beginPath();
  ctx.ellipse(-r * 0.45, 0, r * 0.34, r * 0.3, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = lit ? p.star : p.bug;
  ctx.beginPath();
  ctx.arc(r * 0.68, 0, r * 0.2, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/**
 * Sleeping star: hangs on a thread from the top of the play area and sways; a dashed cut line until
 * lit. `ctx` is at the target's centre, so the thread's length is its height above the top edge:
 * `t.y` screen heights, and a screen height is `r / t.r` px.
 */
function sleeper(ctx: Ctx, r: number, now: number, t: TargetView, p: StarsPalette, lit: boolean) {
  const top = t.r > 0 ? (t.y * r) / t.r : r * 40;
  ctx.strokeStyle = rgba(p.star, 0.35);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.95);
  ctx.lineTo(0, -top);
  ctx.stroke();
  ctx.rotate(Math.sin(now * 0.0012 + t.id) * 0.12);
  ctx.save();
  if (lit) glowShadow(ctx, p.glow, r);
  else paperShadow(ctx, r);
  starPath(ctx, r, 5, 0.5);
  ctx.fillStyle = lit ? p.star : p.unlit;
  ctx.fill();
  ctx.restore();
  if (!lit) {
    ctx.save();
    starPath(ctx, r * 0.86, 5, 0.5);
    ctx.setLineDash([r * 0.12, r * 0.1]);
    ctx.strokeStyle = rgba(p.star, 0.75);
    ctx.lineWidth = Math.max(1, r * 0.04);
    ctx.stroke();
    ctx.restore();
  }
}

/** The HUD and phone, from the palette (see styles.css, `[data-theme="stars"]`). */
function css(p: Omit<StarsPalette, 'css'>): StarsPalette['css'] {
  return {
    '--sky-bg': `linear-gradient(${p.sky0}, ${p.sky1} 55%, ${p.sky2})`,
    '--hud-fg': p.tag,
    '--hud-accent': p.star,
    '--hud-shell': p.star,
    '--hud-font': FONT,
    '--banner-bg': p.tag,
    '--gun-bg': p.sky0,
    '--gun-fg': p.tag,
    '--trigger-bg': p.sky1,
    '--trigger-fg': p.tag,
    '--trigger-font': FONT,
    '--tag-bg': p.tag,
    '--tag-ink': p.tagInk,
    '--star-unlit': p.unlit,
  };
}
function palette(p: Omit<StarsPalette, 'css'>): StarsPalette {
  return { ...p, css: css(p) };
}

export const stars: Theme<StarsPalette> = {
  id: 'stars',
  name: 'Stargazer',
  palettes: {
    dusk: palette({
      name: 'Dusk paper',
      seats: ['#3ec8ff', '#c6ff3d', '#ffffff'],
      // Most of the play area is the sky between its top and middle colours; this is the lighter end.
      ground: '#7a2f6e',
      sky0: '#26134a',
      sky1: '#7a2f6e',
      sky2: '#e0786b',
      hills: ['#8a3f7a', '#5b2a62', '#33183f'],
      tree: '#271030',
      moon: '#fff0d4',
      star: '#fff2c2',
      unlit: '#9a5a8c',
      tail: ['#ffd27a', '#ffffff', '#ffb3c1'],
      glow: '#ffe9a8',
      bug: '#3b1d45',
      confetti: ['#fff2c2', '#ffb3c1', '#ffd27a', '#b9f2e4'],
      tag: '#fff4e4',
      tagInk: '#3b1d45',
    }),
    indigo: palette({
      name: 'Indigo paper',
      seats: ['#ff7a59', '#6fe0c8', '#f6a6ff'],
      ground: '#232c6e',
      sky0: '#131944',
      sky1: '#232c6e',
      sky2: '#3b4192',
      hills: ['#4b4fa3', '#33367f', '#1f2157'],
      tree: '#16173f',
      moon: '#fff1c9',
      star: '#ffe7a3',
      unlit: '#585d9c',
      tail: ['#ffd27a', '#ff9f8a', '#b9a8ff'],
      glow: '#ffe38a',
      bug: '#2b2f5f',
      confetti: ['#ffe7a3', '#ff9f8a', '#9fe7d4', '#c9b8ff'],
      tag: '#fff4dc',
      tagInk: '#2a2350',
    }),
  },
  hitMotion: 'hold',
  hitMs: FADE_AT + FADE_MS,
  verb: { tap: 'Tap to light', flick: 'Flick to light' },
  shells: ['★', '☆'],
  fonts: [`800 1em "Sniglet"`, `400 1em "Sniglet"`],

  background(ctx, w, h, p) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, p.sky0);
    g.addColorStop(0.55, p.sky1);
    g.addColorStop(1, p.sky2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Still stars.
    const R = mulberry(7);
    for (let i = 0; i < 46; i++) {
      const x = R() * w;
      const y = R() * h * 0.62;
      const s = h * (0.004 + R() * 0.007);
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = rgba(p.star, 0.35 + R() * 0.45);
      starPath(ctx, s, 4, 0.35);
      ctx.fill();
      ctx.restore();
    }
    // A faint constellation (decoration only).
    const pts = [
      [0.2, 0.18],
      [0.27, 0.12],
      [0.35, 0.16],
      [0.4, 0.09],
      [0.31, 0.24],
    ] as const;
    ctx.save();
    ctx.strokeStyle = rgba(p.star, 0.28);
    ctx.lineWidth = Math.max(1, h * 0.0022);
    ctx.setLineDash([h * 0.006, h * 0.008]);
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
    ctx.stroke();
    ctx.restore();
    for (const [x, y] of pts) {
      ctx.save();
      ctx.translate(x * w, y * h);
      ctx.fillStyle = rgba(p.star, 0.6);
      starPath(ctx, h * 0.008, 5);
      ctx.fill();
      ctx.restore();
    }
    // The moon, with a few craters.
    ctx.save();
    paperShadow(ctx, h * 0.09);
    ctx.fillStyle = p.moon;
    ctx.beginPath();
    ctx.arc(w * 0.83, h * 0.2, h * 0.085, 0, TAU);
    ctx.fill();
    noShadow(ctx);
    ctx.fillStyle = 'rgba(0,0,0,.06)';
    for (const [dx, dy, r] of [
      [-0.02, -0.015, 0.018],
      [0.025, 0.02, 0.012],
      [0.01, -0.035, 0.008],
    ] as const) {
      ctx.beginPath();
      ctx.arc(w * 0.83 + dx * h, h * (0.2 + dy), h * r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    // Three layers of paper hills, each casting a shadow on the one behind.
    const k = devScale(ctx);
    const layers = [
      [0.7, 0.07, 2.1, 5.3, 1],
      [0.8, 0.06, 3.0, 7.1, 2],
      [0.91, 0.045, 2.6, 6.3, 3],
    ] as const;
    layers.forEach(([b, a, f1, f2, s], i) => {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.38)';
      ctx.shadowBlur = h * 0.02 * k;
      ctx.shadowOffsetY = -h * 0.004 * k;
      ctx.fillStyle = p.hills[i]!;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += w / 80) ctx.lineTo(x, hillY(x, w, h, b, a, f1, f2, s));
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
    // Paper fir trees on the front hill.
    for (const fx of [0.06, 0.11, 0.58, 0.63, 0.94]) {
      const x = fx * w;
      const base = hillY(x, w, h, 0.91, 0.045, 2.6, 6.3, 3) + h * 0.01;
      const th = h * 0.09;
      ctx.save();
      paperShadow(ctx, h * 0.05);
      ctx.fillStyle = p.tree;
      for (let j = 0; j < 3; j++) {
        const y0 = base - j * th * 0.28;
        const hw = th * (0.32 - j * 0.07);
        ctx.beginPath();
        ctx.moveTo(x - hw, y0);
        ctx.lineTo(x, y0 - th * 0.5);
        ctx.lineTo(x + hw, y0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  },

  ambient(ctx, w, h, now, p) {
    // Six twinkling stars: no shadows, a handful of paths.
    for (let i = 0; i < 6; i++) {
      const x = srand(i, 1) * w;
      const y = srand(i, 2) * h * 0.55;
      const a = 0.5 + 0.5 * Math.sin(now * 0.002 + i * 1.7);
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = rgba(p.star, a * 0.8);
      starPath(ctx, h * 0.009, 4, 0.3);
      ctx.fill();
      ctx.restore();
    }
  },

  overlay(ctx, w, h) {
    tile(ctx, grain(false), w, h, 0.55);
    tile(ctx, grain(true), w, h, 0.35);
  },

  target(ctx, t, r, now, p, hitAge) {
    const lit = hitAge >= 0;
    if (lit) {
      // Light up, pop to 1.35× and settle, then fade.
      const sc = hitAge < POP_MS ? 1 + 0.35 * Math.sin((hitAge / POP_MS) * Math.PI) : 1;
      ctx.scale(sc, sc);
      if (hitAge > FADE_AT) ctx.globalAlpha *= Math.max(0, 1 - (hitAge - FADE_AT) / FADE_MS);
    }
    if (t.k === 0) comet(ctx, r, now, t, p, lit);
    else if (t.k === 1) firefly(ctx, r, now, t, p, lit);
    else sleeper(ctx, r, now, t, p, lit);
  },

  effect(ctx, e: Effect, w, h, now, p) {
    const x = e.x * w;
    const y = e.y * h;
    if (e.kind === 'hit') {
      // Paper confetti falling under gravity, and the points on top.
      const k = (now - e.at) / HIT_FX_MS;
      if (k < 0 || k > 1) return;
      for (let i = 0; i < 16; i++) {
        const a = srand(e.id, i) * TAU;
        const sp = 0.5 + srand(e.id, i + 30) * 0.8;
        const px = x + Math.cos(a) * sp * k * h * 0.16;
        const py = y + Math.sin(a) * sp * k * h * 0.16 + k * k * h * 0.14;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(a + k * 8);
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = p.confetti[i % 4]!;
        if (i % 3) ctx.fillRect(-h * 0.006, -h * 0.003, h * 0.012, h * 0.006);
        else {
          ctx.beginPath();
          ctx.moveTo(0, -h * 0.007);
          ctx.lineTo(h * 0.006, h * 0.005);
          ctx.lineTo(-h * 0.006, h * 0.005);
          ctx.fill();
        }
        ctx.restore();
      }
      if (e.pts) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, 2 - 2 * k);
        paperShadow(ctx, h * 0.04);
        ctx.fillStyle = p.star;
        ctx.font = `800 ${Math.round(h * 0.048)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(`+${e.pts}`, x, y - (e.r ?? 0.05) * h - h * 0.02 - k * h * 0.05);
        ctx.restore();
      }
    } else {
      // A puff of paper dust.
      const k = (now - e.at) / MISS_FX_MS;
      if (k < 0 || k > 1) return;
      ctx.fillStyle = rgba(p.star, (1 - k) * 0.3);
      for (let i = 0; i < 7; i++) {
        const a = srand(e.id, i) * TAU;
        const d = h * (0.008 + k * 0.035);
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, h * (0.006 + k * 0.01), 0, TAU);
        ctx.fill();
      }
    }
  },

  crosshair(ctx, g: GunView, { x, y, raw }, h, now, p) {
    const col = p.seats[g.c % p.seats.length]!;
    const s = h * 0.034;
    if (raw) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(raw[0], raw[1], s * 0.7, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
    // A punched-paper ring in the seat colour, with stitches running round it.
    ctx.save();
    paperShadow(ctx, h * 0.05);
    ctx.strokeStyle = col;
    ctx.lineWidth = h * 0.01;
    ctx.beginPath();
    ctx.arc(x, y, s, 0, TAU);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = Math.max(1, h * 0.0025);
    ctx.setLineDash([h * 0.006, h * 0.006]);
    ctx.lineDashOffset = (-now / 1000) * h * 0.02;
    ctx.beginPath();
    ctx.arc(x, y, s * 0.72, 0, TAU);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, h * 0.005, 0, TAU);
    ctx.fill();
  },
};
