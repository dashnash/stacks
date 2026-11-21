/**
 * The screen's canvas: one frame from a snapshot (interpolated by `createStateBuffer`) plus
 * short-lived effects, drawn by the chosen theme (`themes/`). The theme's still background and its
 * overlay are cached as layers per size and palette; the rest is drawn every frame.
 */
import type { CalibrationView, GunView, Snapshot, TargetView } from '../../game/protocol';
import type { ThemeChoice } from '../../game/themes';
import { duskCalibration } from './themes/dusk';
import { themeOf, type Effect, type HitCopy, type Palette, type Theme } from './themes';

export type { Effect, HitCopy } from './themes';

/** Effects older than this are dropped (each theme stops drawing its own sooner). */
export const EFFECT_MS = 1500;
/** Hit copies older than this are dropped. */
export const HIT_COPY_MS = 2000;

/** An offscreen canvas `w` × `h` device pixels, or null where there is none (tests, old browsers). */
export type MakeLayer = (w: number, h: number) => { image: CanvasImageSource; ctx: CanvasRenderingContext2D } | null;

const canvasLayer: MakeLayer = (w, h) => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext?.('2d');
  return ctx ? { image: c, ctx } : null;
};

/** The cached background and overlay of the theme being drawn. */
export class Layers {
  private key = '';
  private bg: CanvasImageSource | null = null;
  private ov: CanvasImageSource | null = null;
  /** How many times the layers were drawn (for tests). */
  builds = 0;
  constructor(private readonly make: MakeLayer = canvasLayer) {}

  /** Forget the layers (e.g. once a theme's fonts have loaded). */
  clear(): void {
    this.key = '';
  }

  /** The layers for this theme, palette and size; drawn now if anything changed. Null: draw directly. */
  get(theme: Theme, palette: Palette, w: number, h: number, dpr: number): { bg: CanvasImageSource | null; ov: CanvasImageSource | null } | null {
    const key = `${theme.id}/${palette.name}/${w}x${h}@${dpr}`;
    if (key === this.key) return { bg: this.bg, ov: this.ov };
    const draw = (fn: (ctx: CanvasRenderingContext2D) => void) => {
      const layer = this.make(Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr)));
      if (!layer) return undefined;
      layer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fn(layer.ctx);
      return layer.image;
    };
    const bg = draw((ctx) => theme.background(ctx, w, h, palette));
    if (bg === undefined) return null;
    this.bg = bg;
    this.ov = theme.overlay ? (draw((ctx) => theme.overlay!(ctx, w, h, palette)) ?? null) : null;
    this.key = key;
    this.builds++;
    return { bg: this.bg, ov: this.ov };
  }
}

export interface FrameOpts {
  now: number;
  theme: ThemeChoice;
  /** Show the raw crosshairs (tuning). */
  overlay: boolean;
  /** Show the centre calibration dot. */
  calibrate: boolean;
  /** The crosshairs to draw (the newest state; the targets are interpolated about 100 ms back). */
  guns?: GunView[];
  cal?: CalibrationView;
  /** Targets as they were when hit (for themes whose hit targets don't fall). */
  hits?: HitCopy[];
  /** Draw each live target's hitbox: its radius times this (the tuning's `hitboxScale`). */
  hitboxes?: number;
  /** Skip the theme's ambient motion. */
  reducedMotion?: boolean;
  /** Recent crosshair positions per gun id (0-1), oldest first. */
  trails?: Map<string, [number, number][]>;
  dpr?: number;
}

function hitbox(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineDashOffset = 4.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.stroke();
  ctx.restore();
}

/** Draw one frame, `w` × `h` CSS pixels. */
export function drawFrame(ctx: CanvasRenderingContext2D, w: number, h: number, snap: Snapshot | undefined, effects: Effect[], opts: FrameOpts, layers?: Layers) {
  const { theme, palette: p } = themeOf(opts.theme);
  const { now } = opts;
  const cached = layers?.get(theme, p, w, h, opts.dpr ?? 1) ?? null;
  const layer = (image: CanvasImageSource | null | undefined, direct: () => void) => {
    if (cached) {
      if (image) ctx.drawImage(image, 0, 0, w, h);
    } else direct();
  };
  const step = (fn: () => void) => {
    ctx.save();
    fn();
    ctx.restore();
  };

  layer(cached?.bg, () => step(() => theme.background(ctx, w, h, p)));
  if (theme.ambient && !opts.reducedMotion) step(() => theme.ambient!(ctx, w, h, now, p));
  step(() => (theme.calibration ?? duskCalibration)(ctx, w, h, now, p, { centre: opts.calibrate, cal: opts.cal }));

  if (snap) {
    // A theme whose hit targets don't fall draws its copy where each was hit, not the falling one.
    const copies = theme.hitMotion === 'fall' ? [] : (opts.hits ?? []);
    const copied = new Set(copies.map((c) => c.id));
    const hitAt = new Map((opts.hits ?? []).map((c) => [c.id, c.at]));
    const drawTarget = (t: TargetView, hitAge: number) =>
      step(() => {
        ctx.translate(t.x * w, t.y * h);
        theme.target(ctx, t, t.r * h, now, p, hitAge);
      });
    for (const t of snap.tg) {
      if (t.s === 1 && copied.has(t.id)) continue;
      drawTarget(t, t.s === 1 ? now - (hitAt.get(t.id) ?? now) : -1);
    }
    for (const c of copies) if (now - c.at < theme.hitMs) drawTarget({ id: c.id, k: c.k, x: c.x, y: c.y, r: c.r, s: 1, h: c.h }, now - c.at);
    if (opts.hitboxes) for (const t of snap.tg) if (t.s === 0) hitbox(ctx, t.x * w, t.y * h, t.r * h * opts.hitboxes);
    for (const e of effects) step(() => theme.effect(ctx, e, w, h, now, p));
    for (const g of opts.guns ?? snap.g) {
      const trail = (opts.trails?.get(g.id) ?? []).map(([x, y]) => [x * w, y * h] as [number, number]);
      step(() => theme.crosshair(ctx, g, { x: g.x * w, y: g.y * h, raw: opts.overlay ? [g.rx * w, g.ry * h] : undefined }, h, now, p, trail));
    }
  }
  if (theme.overlay) layer(cached?.ov, () => step(() => theme.overlay!(ctx, w, h, p)));
}

/** A small still of a theme (the picker): its background and one of each target. */
export function drawThumb(ctx: CanvasRenderingContext2D, w: number, h: number, choice: ThemeChoice, now = 0) {
  const { theme, palette: p } = themeOf(choice);
  ctx.save();
  theme.background(ctx, w, h, p);
  const kinds: [number, number, number, number][] = [
    [0, 0.3, 0.42, 0.13],
    [1, 0.55, 0.62, 0.1],
    [2, 0.78, 0.38, 0.14],
  ];
  for (const [k, x, y, r] of kinds) {
    ctx.save();
    ctx.translate(x * w, y * h);
    theme.target(ctx, { id: k + 1, k, x, y, r, s: 0, h: 0 }, r * h, now, p, -1);
    ctx.restore();
  }
  if (theme.overlay) theme.overlay(ctx, w, h, p);
  ctx.restore();
}
