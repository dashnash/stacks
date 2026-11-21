/**
 * Dusk: the original look. A dusk sky, rolling hills, flat vector birds, clay discs and balloons.
 */
import type { CalibrationView, GunView, TargetView } from '../../../game/protocol';
import type { Ctx, Effect, Palette, Theme } from './types';

export interface DuskPalette extends Palette {
  skyTop: string;
  skyMid: string;
  skyLow: string;
  sun: string;
  hillBack: string;
  hillFront: string;
}

const EFFECT_MS = 600;

export function duskCalibration(ctx: Ctx, w: number, h: number, now: number, _p: Palette, at: { centre: boolean; cal?: CalibrationView }) {
  if (at.centre) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, Math.max(8, h * 0.015), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, h * 0.05 + (Math.sin(now / 300) + 1) * h * 0.01, 0, Math.PI * 2);
    ctx.stroke();
  }
  const cal = at.cal;
  if (!cal) return;
  // The dot to point at (pulsing), and the ones already done (faint).
  const r = Math.max(10, h * 0.02);
  cal.pts.forEach(([px, py], k) => {
    if (k === cal.i) return;
    ctx.strokeStyle = k < cal.i ? 'rgba(198,255,61,0.45)' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px * w, py * h, r * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  });
  const [x, y] = cal.pts[cal.i] ?? [0.5, 0.5];
  ctx.fillStyle = '#c6ff3d';
  ctx.beginPath();
  ctx.arc(x * w, y * h, r * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#c6ff3d';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x * w, y * h, r + (Math.sin(now / 250) + 1) * 3, 0, Math.PI * 2);
  ctx.stroke();
}

export const dusk: Theme<DuskPalette> = {
  id: 'dusk',
  name: 'Dusk',
  palettes: {
    dusk: {
      name: 'Dusk',
      seats: ['#ff4f6d', '#3ec8ff', '#ffd23f'],
      ground: '#21134d',
      skyTop: '#21134d',
      skyMid: '#7b2d8b',
      skyLow: '#ff8a5b',
      sun: 'rgba(255, 210, 63, 0.9)',
      hillBack: '#2f1d5c',
      hillFront: '#1a1038',
      css: {
        '--sky-bg': 'linear-gradient(#21134d, #7b2d8b 60%, #ff8a5b)',
        '--hud-fg': '#fdf6ff',
        '--hud-accent': '#ffd23f',
        '--hud-shell': '#ff4f6d',
        '--hud-font': 'inherit',
        '--banner-bg': 'rgba(23, 13, 51, 0.8)',
        '--gun-bg': '#170d33',
        '--gun-fg': '#fdf6ff',
        '--trigger-bg': 'radial-gradient(circle at 50% 40%, #ff6f88, #ff4f6d 60%, #b8233f)',
        '--trigger-fg': '#fff',
        '--trigger-font': 'inherit',
      },
    },
  },
  hitMotion: 'fall',
  hitMs: 0,
  verb: { tap: 'FIRE', flick: 'Flick to fire' },
  shells: ['●', '○'],
  fonts: [],

  background(ctx, w, h, p) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, p.skyTop);
    g.addColorStop(0.6, p.skyMid);
    g.addColorStop(1, p.skyLow);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // A big low sun.
    ctx.fillStyle = p.sun;
    ctx.beginPath();
    ctx.arc(w * 0.78, h * 0.78, h * 0.16, 0, Math.PI * 2);
    ctx.fill();
    for (const [color, base, amp, freq] of [
      [p.hillBack, 0.82, 0.05, 2.3],
      [p.hillFront, 0.9, 0.04, 3.7],
    ] as const) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += w / 40) ctx.lineTo(x, h * (base - amp * Math.sin((x / w) * Math.PI * freq + base * 10)));
      ctx.lineTo(w, h);
      ctx.fill();
    }
  },

  target(ctx: Ctx, t: TargetView, r: number, now: number) {
    if (t.s === 1) ctx.globalAlpha = 0.55;
    if (t.k === 0) {
      // Bird: a teardrop body, a beak, wings flapping.
      const flap = Math.sin(now / 90 + t.id) * 0.8;
      const facing = Math.cos(t.h) < 0 ? -1 : 1;
      ctx.scale(facing, 1);
      ctx.fillStyle = '#14b8a6';
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.65, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath();
      ctx.moveTo(r * 0.9, -r * 0.15);
      ctx.lineTo(r * 1.45, 0);
      ctx.lineTo(r * 0.9, r * 0.15);
      ctx.fill();
      ctx.fillStyle = '#0f766e';
      ctx.beginPath();
      ctx.moveTo(-r * 0.3, 0);
      ctx.lineTo(r * 0.2, 0);
      ctx.lineTo(-r * 0.1, -r * (0.3 + 1.1 * Math.max(0, flap)) * (t.s === 1 ? -1 : 1));
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(r * 0.45, -r * 0.2, r * 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.arc(r * 0.5, -r * 0.2, r * 0.08, 0, Math.PI * 2);
      ctx.fill();
    } else if (t.k === 1) {
      // Clay disc: a squashed orange disc with a rim.
      ctx.rotate(now / 300 + t.id);
      ctx.fillStyle = '#ff7a1a';
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffd6a8';
      ctx.lineWidth = Math.max(1, r * 0.15);
      ctx.stroke();
    } else {
      // Balloon: a bright oval on a string.
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, r);
      ctx.quadraticCurveTo(r * 0.3, r * 1.6, 0, r * 2.2);
      ctx.stroke();
      ctx.fillStyle = '#ff4fb0';
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.85, r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.beginPath();
      ctx.ellipse(-r * 0.3, -r * 0.35, r * 0.18, r * 0.3, -0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  effect(ctx: Ctx, e: Effect, w: number, h: number, now: number, p) {
    const k = (now - e.at) / EFFECT_MS;
    if (k < 0 || k > 1) return;
    const x = e.x * w;
    const y = e.y * h;
    ctx.globalAlpha = 1 - k;
    if (e.kind === 'hit') {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const r0 = h * 0.02 + k * h * 0.05;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
        ctx.lineTo(x + Math.cos(a) * (r0 + h * 0.025), y + Math.sin(a) * (r0 + h * 0.025));
        ctx.stroke();
      }
      if (e.pts) {
        ctx.fillStyle = '#fff';
        ctx.font = `800 ${Math.round(h * 0.035)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`+${e.pts}`, x, y - h * 0.04 - k * h * 0.05);
      }
    } else {
      ctx.fillStyle = p.seats[e.c % p.seats.length]!;
      ctx.beginPath();
      ctx.arc(x, y, h * 0.015 + k * h * 0.03, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  crosshair(ctx: Ctx, g: GunView, { x, y, raw }, h: number, _now: number, p) {
    const color = p.seats[g.c % p.seats.length]!;
    const s = Math.max(14, h * 0.03);
    if (raw) {
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(raw[0], raw[1], s * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      ctx.moveTo(x + dx * s * 0.45, y + dy * s * 0.45);
      ctx.lineTo(x + dx * s * 1.5, y + dy * s * 1.5);
    }
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  },

  calibration: duskCalibration,
};
