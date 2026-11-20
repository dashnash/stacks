/**
 * The screen's canvas: a dusk sky, rolling hills, flat vector targets and the crosshairs. Pure
 * drawing from a snapshot (interpolated by `createStateBuffer`) plus short-lived effects.
 */
import type { GunView, Snapshot, TargetView } from '../../game/protocol';

/** One colour per gun seat (the server hands out the index). */
export const GUN_COLORS = ['#ff4f6d', '#3ec8ff', '#ffd23f'];
const SKY_TOP = '#21134d';
const SKY_MID = '#7b2d8b';
const SKY_LOW = '#ff8a5b';
const HILL_BACK = '#2f1d5c';
const HILL_FRONT = '#1a1038';

export interface Effect {
  kind: 'pop' | 'flash' | 'score';
  x: number;
  y: number;
  /** Colour index (the gun). */
  c: number;
  at: number;
  text?: string;
}
export const EFFECT_MS = 600;

function sky(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, SKY_TOP);
  g.addColorStop(0.6, SKY_MID);
  g.addColorStop(1, SKY_LOW);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // A big low sun.
  ctx.fillStyle = 'rgba(255, 210, 63, 0.9)';
  ctx.beginPath();
  ctx.arc(w * 0.78, h * 0.78, h * 0.16, 0, Math.PI * 2);
  ctx.fill();
  for (const [color, base, amp, freq] of [
    [HILL_BACK, 0.82, 0.05, 2.3],
    [HILL_FRONT, 0.9, 0.04, 3.7],
  ] as const) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += w / 40) ctx.lineTo(x, h * (base - amp * Math.sin((x / w) * Math.PI * freq + base * 10)));
    ctx.lineTo(w, h);
    ctx.fill();
  }
}

function target(ctx: CanvasRenderingContext2D, t: TargetView, w: number, h: number, now: number) {
  const x = t.x * w;
  const y = t.y * h;
  const r = t.r * h;
  ctx.save();
  ctx.translate(x, y);
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
  ctx.restore();
}

function crosshair(ctx: CanvasRenderingContext2D, g: GunView, w: number, h: number, overlay: boolean) {
  const color = GUN_COLORS[g.c % GUN_COLORS.length]!;
  const s = Math.max(14, h * 0.03);
  if (overlay) {
    // The raw crosshair (no smoothing or prediction), for tuning.
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(g.rx * w, g.ry * h, s * 0.7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const x = g.x * w;
  const y = g.y * h;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, s, 0, Math.PI * 2);
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    ctx.moveTo(x + dx! * s * 0.45, y + dy! * s * 0.45);
    ctx.lineTo(x + dx! * s * 1.5, y + dy! * s * 1.5);
  }
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

function effect(ctx: CanvasRenderingContext2D, e: Effect, w: number, h: number, now: number) {
  const k = (now - e.at) / EFFECT_MS;
  if (k < 0 || k > 1) return;
  const x = e.x * w;
  const y = e.y * h;
  ctx.save();
  ctx.globalAlpha = 1 - k;
  if (e.kind === 'pop') {
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
  } else if (e.kind === 'flash') {
    ctx.fillStyle = GUN_COLORS[e.c % GUN_COLORS.length]!;
    ctx.beginPath();
    ctx.arc(x, y, h * 0.015 + k * h * 0.03, 0, Math.PI * 2);
    ctx.fill();
  } else if (e.text) {
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${Math.round(h * 0.035)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(e.text, x, y - h * 0.04 - k * h * 0.05);
  }
  ctx.restore();
}

/** Draw one frame. `calibrate`: show the centre dot to point the phone at. */
export function drawFrame(ctx: CanvasRenderingContext2D, w: number, h: number, snap: Snapshot | undefined, effects: Effect[], opts: { now: number; overlay: boolean; calibrate: boolean }) {
  sky(ctx, w, h);
  if (opts.calibrate) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, Math.max(8, h * 0.015), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, h * 0.05 + (Math.sin(opts.now / 300) + 1) * h * 0.01, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (!snap) return;
  for (const t of snap.tg) target(ctx, t, w, h, opts.now);
  for (const e of effects) effect(ctx, e, w, h, opts.now);
  for (const g of snap.g) crosshair(ctx, g, w, h, opts.overlay);
}
