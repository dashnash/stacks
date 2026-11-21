/**
 * Every knob of the aim mapping and the trigger, with defaults and ranges. The screen's tuning panel
 * edits these live (`{ tune: Partial<Tuning> }`); the game server clamps whatever arrives. A
 * config's id is a short hash of the whole object, so shots and accuracy stats group by it.
 */

export type AimMode = 'absolute' | 'relative' | 'hybrid';
export type TriggerMode = 'tap' | 'flick';
export type FlickAxis = 'any' | 'y' | 'z';
export type HoldOrientation = 'portrait' | 'landscape';

export interface Tuning {
  mode: AimMode;
  trigger: TriggerMode;
  /** Absolute and hybrid: screen widths per radian of turn. */
  fovGain: number;
  /** Added to the crosshair after mapping, in screen widths / heights. */
  offsetX: number;
  offsetY: number;
  /** Relative: screen widths per radian of rotation. */
  sensitivity: number;
  /** Relative: speed exponent (1 = linear; above 1, fast turns travel further). */
  accelCurve: number;
  /** Vertical gain as a multiple of the horizontal (people rarely raise the wrist as far as they turn it). */
  ratioY: number;
  /** Hybrid: how fast (per second) the reference drifts to the current pose while the gun is still. */
  recentreRate: number;
  /** Hybrid: extra relative gain for small motions. */
  fineGain: number;
  /** Rotation below this (rad/s) is treated as no movement (hand tremor). */
  deadzone: number;
  /** One-euro filter: cutoff at rest (Hz) and how fast it opens up with speed. */
  minCutoff: number;
  beta: number;
  /** Milliseconds of extrapolation to hide latency. */
  prediction: number;
  invertX: boolean;
  invertY: boolean;
  /** Flick: acceleration spike (g) that fires. */
  flickThreshold: number;
  flickAxis: FlickAxis;
  /** Flick: no second shot for this long (ms). */
  flickCooldown: number;
  /** Flick: aim with the crosshair from this long before the spike (the jerk throws the aim off). */
  flickLookbackMs: number;
  /** Lag compensation never rewinds further than this (ms). */
  maxRewindMs: number;
  /** Hitbox radius as a multiple of the drawn target. */
  hitboxScale: number;
  /** How the phone is held: upright (top edge at the screen) or sideways (right edge). */
  orientation: HoldOrientation;
}

export const DEFAULT_TUNING: Tuning = {
  mode: 'absolute',
  trigger: 'tap',
  fovGain: 1.6,
  offsetX: 0,
  offsetY: 0,
  sensitivity: 1.2,
  accelCurve: 1.3,
  ratioY: 1,
  recentreRate: 0.05,
  fineGain: 0.3,
  deadzone: 0.02,
  minCutoff: 1.5,
  beta: 0.3,
  prediction: 30,
  invertX: false,
  invertY: false,
  flickThreshold: 1.6,
  flickAxis: 'any',
  flickCooldown: 350,
  flickLookbackMs: 80,
  maxRewindMs: 250,
  hitboxScale: 1.1,
  orientation: 'portrait',
};

export interface NumberKnob {
  kind: 'number';
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  /** Which modes use it (all when absent): the panel greys the rest out. */
  modes?: AimMode[];
  trigger?: TriggerMode;
}
export interface ChoiceKnob {
  kind: 'choice';
  label: string;
  options: readonly string[];
  trigger?: TriggerMode;
}
export interface FlagKnob {
  kind: 'flag';
  label: string;
}
export type Knob = NumberKnob | ChoiceKnob | FlagKnob;

/** The panel's layout and the server's clamps, in one place. */
export const KNOBS: { [K in keyof Tuning]: Knob } = {
  mode: { kind: 'choice', label: 'Aim mapping', options: ['absolute', 'relative', 'hybrid'] },
  trigger: { kind: 'choice', label: 'Trigger', options: ['tap', 'flick'] },
  fovGain: { kind: 'number', label: 'Turn gain', min: 0.3, max: 5, step: 0.05, unit: 'widths/rad', modes: ['absolute', 'hybrid'] },
  offsetX: { kind: 'number', label: 'Offset X', min: -0.5, max: 0.5, step: 0.01 },
  offsetY: { kind: 'number', label: 'Offset Y', min: -0.5, max: 0.5, step: 0.01 },
  sensitivity: { kind: 'number', label: 'Sensitivity', min: 0.1, max: 5, step: 0.05, unit: 'widths/rad', modes: ['relative'] },
  accelCurve: { kind: 'number', label: 'Accel curve', min: 1, max: 2.5, step: 0.05, modes: ['relative'] },
  ratioY: { kind: 'number', label: 'Vertical gain', min: 0.5, max: 2, step: 0.05, unit: '× horizontal' },
  recentreRate: { kind: 'number', label: 'Recentre rate', min: 0, max: 1, step: 0.01, unit: '/s', modes: ['hybrid'] },
  fineGain: { kind: 'number', label: 'Fine-aim gain', min: 0, max: 1.5, step: 0.05, modes: ['hybrid'] },
  deadzone: { kind: 'number', label: 'Deadzone', min: 0, max: 0.3, step: 0.005, unit: 'rad/s' },
  minCutoff: { kind: 'number', label: 'Smoothing cutoff', min: 0.1, max: 10, step: 0.1, unit: 'Hz' },
  beta: { kind: 'number', label: 'Smoothing speed (β)', min: 0, max: 10, step: 0.1 },
  prediction: { kind: 'number', label: 'Prediction', min: 0, max: 150, step: 5, unit: 'ms' },
  invertX: { kind: 'flag', label: 'Invert X' },
  invertY: { kind: 'flag', label: 'Invert Y' },
  flickThreshold: { kind: 'number', label: 'Flick threshold', min: 0.3, max: 5, step: 0.05, unit: 'g', trigger: 'flick' },
  flickAxis: { kind: 'choice', label: 'Flick axis', options: ['any', 'y', 'z'], trigger: 'flick' },
  flickCooldown: { kind: 'number', label: 'Flick cooldown', min: 100, max: 1500, step: 10, unit: 'ms', trigger: 'flick' },
  flickLookbackMs: { kind: 'number', label: 'Flick look-back', min: 0, max: 250, step: 5, unit: 'ms', trigger: 'flick' },
  maxRewindMs: { kind: 'number', label: 'Max rewind', min: 0, max: 500, step: 10, unit: 'ms' },
  hitboxScale: { kind: 'number', label: 'Hitbox scale', min: 0.5, max: 2.5, step: 0.05 },
  orientation: { kind: 'choice', label: 'Hold the phone', options: ['portrait', 'landscape'] },
};

/** Apply a change from a browser: unknown keys and wrong types are dropped, numbers clamped. */
export function applyTune(current: Tuning, change: unknown): Tuning {
  if (!change || typeof change !== 'object') return current;
  const next: Tuning = { ...current };
  for (const [key, value] of Object.entries(change as Record<string, unknown>)) {
    const knob = (KNOBS as Record<string, Knob | undefined>)[key];
    if (!knob) continue;
    const k = key as keyof Tuning;
    if (knob.kind === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      (next as unknown as Record<string, unknown>)[k] = Math.min(knob.max, Math.max(knob.min, value));
    } else if (knob.kind === 'choice' && typeof value === 'string' && knob.options.includes(value)) {
      (next as unknown as Record<string, unknown>)[k] = value;
    } else if (knob.kind === 'flag' && typeof value === 'boolean') {
      (next as unknown as Record<string, unknown>)[k] = value;
    }
  }
  return next;
}

/** A short, stable id for a config: FNV-1a over its JSON with sorted keys, base 36. */
export function configId(t: Tuning): string {
  const json = JSON.stringify(Object.keys(t).sort().map((k) => [k, t[k as keyof Tuning]]));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0');
}
