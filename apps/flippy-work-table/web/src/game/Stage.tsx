import { useEffect, useRef, type PointerEvent } from 'react';
import { ITEMS, PIVOT, TABLE, WORLD, type Frame } from './sim';

interface Props {
  frame: Frame;
  idle: boolean;
  toolEmoji: string;
  onSwipe: (dyUp: number, ms: number) => void;
}

/** Canvas 2D can be missing (jsdom in tests, very old browsers); the game still runs, just unseen. */
function context(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
  try {
    return canvas?.getContext('2d') ?? null;
  } catch {
    return null;
  }
}

function draw(ctx: CanvasRenderingContext2D, frame: Frame, idle: boolean, toolEmoji: string, cssW: number, dpr: number) {
  const scale = cssW / WORLD.w;
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Wallpaper: cheap stripes plus a watermark nobody removed.
  ctx.fillStyle = '#fff3a8';
  ctx.fillRect(0, 0, WORLD.w, WORLD.floor);
  ctx.fillStyle = '#ffe97a';
  for (let x = 0; x < WORLD.w; x += 40) ctx.fillRect(x, 0, 18, WORLD.floor);
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = '#000';
  ctx.font = 'bold 26px Impact, sans-serif';
  ctx.rotate(-0.25);
  for (let y = 40; y < 600; y += 90) ctx.fillText('FLIPPYWORKTABLE.RU.COM — DEMO — НЕ КОПИРОВАТЬ', -120, y);
  ctx.restore();

  // Linoleum floor.
  for (let x = 0; x < WORLD.w; x += 25) {
    for (let y = WORLD.floor; y < WORLD.h; y += 25) {
      ctx.fillStyle = (x + y) % 50 === 0 ? '#5b6bd6' : '#e8e8e8';
      ctx.fillRect(x, y, 25, 25);
    }
  }
  ctx.fillStyle = '#222';
  ctx.fillRect(0, WORLD.floor - 2, WORLD.w, 3);

  // The table, rotating about its far foot (and sliding up so it lands on its top, approximately).
  const lift = ((1 - Math.cos(frame.table)) / 2) * (PIVOT.y - TABLE.top);
  ctx.save();
  ctx.translate(PIVOT.x, PIVOT.y - lift);
  ctx.rotate(-frame.table);
  const topY = TABLE.top - PIVOT.y;
  ctx.fillStyle = '#9a5b2e';
  ctx.strokeStyle = '#3d220f';
  ctx.lineWidth = 2;
  ctx.fillRect(TABLE.x0 - PIVOT.x, topY, TABLE.x1 - TABLE.x0, TABLE.thick);
  ctx.strokeRect(TABLE.x0 - PIVOT.x, topY, TABLE.x1 - TABLE.x0, TABLE.thick);
  ctx.fillStyle = '#7a4520';
  ctx.fillRect(TABLE.x0 + TABLE.legInset - PIVOT.x - 6, topY + TABLE.thick, 12, -topY - TABLE.thick);
  ctx.fillRect(-6, topY + TABLE.thick, 12, -topY - TABLE.thick);
  ctx.fillStyle = '#f5e6c8';
  ctx.font = '9px "Times New Roman", serif';
  ctx.fillText('model ВТ-3000 WORKTABLE (original)', TABLE.x0 - PIVOT.x + 8, topY + 11);
  ctx.restore();

  // The stuff.
  frame.items.forEach((it, i) => {
    const d = ITEMS[i]!;
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.rotate(it.a);
    ctx.fillStyle = it.broken ? '#777' : d.color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(-d.w, -d.h, d.w * 2, d.h * 2);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-d.w, -d.h, d.w * 2, d.h * 2);
    ctx.font = `${Math.max(12, Math.min(d.w, d.h) * 1.7)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(d.emoji, 0, 1);
    if (it.broken) {
      ctx.strokeStyle = '#f00';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-d.w, -d.h);
      ctx.lineTo(d.w * 0.2, 0);
      ctx.lineTo(-d.w * 0.3, d.h * 0.4);
      ctx.lineTo(d.w, d.h);
      ctx.stroke();
    }
    ctx.restore();
  });

  if (idle) {
    ctx.font = 'bold 30px "Comic Sans MS", "Comic Neue", cursive';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#d00';
    ctx.fillText('↑ PULL UP ON TABLE FOR FLIP IT ↑', WORLD.w / 2, 60);
    ctx.font = '34px sans-serif';
    ctx.fillText(toolEmoji, TABLE.x0 - 30, TABLE.top + 40);
  }
  ctx.textAlign = 'right';
  ctx.font = '11px monospace';
  ctx.fillStyle = '#000';
  ctx.fillText(`dmg=${frame.damage} t=${frame.t.toFixed(2)} fps=60(?)`, WORLD.w - 8, WORLD.h - 8);
}

export function Stage({ frame, idle, toolEmoji, onSwipe }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const start = useRef<{ y: number; at: number; scale: number } | null>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = context(el);
    if (!el || !ctx) return;
    const cssW = el.clientWidth || WORLD.w;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cssW * dpr);
    const h = Math.round(((cssW * WORLD.h) / WORLD.w) * dpr);
    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
    }
    draw(ctx, frame, idle, toolEmoji, cssW, dpr);
  });

  function down(e: PointerEvent<HTMLCanvasElement>) {
    if (!idle) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    start.current = { y: e.clientY, at: performance.now(), scale: (e.currentTarget.clientWidth || WORLD.w) / WORLD.w };
  }
  function up(e: PointerEvent<HTMLCanvasElement>) {
    const s = start.current;
    start.current = null;
    if (!s || !idle) return;
    onSwipe((s.y - e.clientY) / s.scale, performance.now() - s.at);
  }

  return (
    <canvas
      ref={canvas}
      className="stage"
      aria-label="A work table covered in office stuff. Pull up on it (swipe upwards) to flip it."
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={() => (start.current = null)}
    />
  );
}
