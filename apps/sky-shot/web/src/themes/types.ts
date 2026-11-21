/**
 * What a look supplies: its palettes and how it draws each part of a frame. A theme only draws; the
 * game (targets, paths, hitboxes, scoring) is the same in every theme. Spec: docs/specs/144-sky-shot-themes.md.
 *
 * Every drawing method works in CSS pixels (`w`, `h`: the play area's size) with times in ms
 * (`performance.now()`). Snapshot positions are 0-1 of the play area; radii are in screen heights.
 */
import type { CalibrationView, GunView, TargetView } from '../../../game/protocol';
import type { ThemeId } from '../../../game/themes';

export type Ctx = CanvasRenderingContext2D;

export interface Palette {
  /** Shown in the picker. */
  name: string;
  /** One colour per gun seat (crosshair, gun chip, hit text). */
  seats: readonly [string, string, string];
  /** The colour most of the play area is: every seat colour has at least 3:1 contrast against it. */
  ground: string;
  /** CSS custom properties for the HUD, banners and the phone (see styles.css). */
  css: Record<`--${string}`, string>;
}

/** A short-lived effect at a shot: a hit (with its points and the target's radius) or a miss. */
export interface Effect {
  kind: 'hit' | 'miss';
  /** Increasing per effect, so a theme can seed per-effect randomness. */
  id: number;
  x: number;
  y: number;
  /** Seat colour index. */
  c: number;
  at: number;
  pts?: number;
  /** Radius of the target that was hit, screen heights. */
  r?: number;
}

/** A target as it was when it was hit: themes that don't let hit targets fall draw this instead. */
export interface HitCopy {
  id: number;
  k: number;
  x: number;
  y: number;
  r: number;
  h: number;
  at: number;
}

export interface Theme<P extends Palette = Palette> {
  id: ThemeId;
  name: string;
  palettes: Record<string, P>;
  /**
   * What a hit target does. `fall`: as the server moves it (down). `sink` and `hold`: the screen draws
   * a copy where it was hit for `hitMs`, and hides the falling one. Purely visual: hit targets can't
   * be hit again.
   */
  hitMotion: 'fall' | 'sink' | 'hold';
  hitMs: number;
  /** The phone's trigger label. */
  verb: { tap: string; flick: string };
  /** Shots-left glyphs on the phone: a live one and a spent one. */
  shells: [string, string];
  /** CSS font shorthands to load before drawing (`'400 1em "Yuji Syuku"'`); empty for system fonts. */
  fonts: string[];

  /** The still background, drawn once per size and palette into a cached layer. */
  background(ctx: Ctx, w: number, h: number, p: P): void;
  /** Cheap motion behind the targets, every frame; skipped under prefers-reduced-motion. */
  ambient?(ctx: Ctx, w: number, h: number, now: number, p: P): void;
  /** Drawn over everything, once per size and palette into a cached layer. */
  overlay?(ctx: Ctx, w: number, h: number, p: P): void;
  /** `ctx` is translated to the target's centre; `r` in px. `hitAge`: ms since it was hit, or -1. */
  target(ctx: Ctx, t: TargetView, r: number, now: number, p: P, hitAge: number): void;
  effect(ctx: Ctx, e: Effect, w: number, h: number, now: number, p: P): void;
  /**
   * A gun's crosshair at `at` (px). With `at.raw` (the tuning overlay), also mark the raw crosshair
   * (no smoothing or prediction). `trail`: its last positions in px, oldest first.
   */
  crosshair(ctx: Ctx, g: GunView, at: { x: number; y: number; raw?: [number, number] }, h: number, now: number, p: P, trail: [number, number][]): void;
  /** The calibration dots: the centre dot (`centre`) or the 5-point walk (`cal`). Defaults to Dusk's. */
  calibration?(ctx: Ctx, w: number, h: number, now: number, p: P, at: { centre: boolean; cal?: CalibrationView }): void;
}
