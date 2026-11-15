/**
 * Motion for @stacks/native: the sample shape both sources produce, the web fallback
 * (DeviceMotionEvent / DeviceOrientationEvent mapped to CoreMotion's units and axes), and the fake
 * the demos and tests drive.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Radians. `pitch`: top edge up is positive; `roll`: right edge down is positive; `yaw`: around the screen. */
export interface Attitude {
  roll: number;
  pitch: number;
  yaw: number;
}

export const MOTION_SENSORS = ['userAcceleration', 'rotationRate', 'gravity', 'attitude'] as const;
export type MotionSensor = (typeof MOTION_SENSORS)[number];

/** One reading. Acceleration and gravity in g, rotationRate in rad/s, attitude in rad; `t` in seconds since start. */
export interface MotionSample {
  t: number;
  userAcceleration?: Vec3;
  rotationRate?: Vec3;
  gravity?: Vec3;
  attitude?: Attitude;
}

/** Every sample since the last frame. */
export interface MotionBatch {
  samples: MotionSample[];
}

export const MIN_HZ = 10;
export const MAX_HZ = 100;
export const clampHz = (hz: number | undefined) => Math.round(Math.min(MAX_HZ, Math.max(MIN_HZ, Number.isFinite(hz) ? (hz as number) : 60)));

const G = 9.80665;
const RAD = Math.PI / 180;

/** Gravity in the phone's frame (CoreMotion axes) for an attitude: flat, face up, is { 0, 0, -1 }. */
export function gravityFor(a: Pick<Attitude, 'roll' | 'pitch'>): Vec3 {
  return { x: Math.sin(a.roll) * Math.cos(a.pitch), y: -Math.sin(a.pitch), z: -Math.cos(a.roll) * Math.cos(a.pitch) };
}

/** Keep only the asked-for sensors of a sample. */
export function pick(sample: MotionSample, sensors: readonly MotionSensor[]): MotionSample {
  const out: MotionSample = { t: sample.t };
  for (const s of sensors) if (sample[s]) (out as unknown as Record<string, unknown>)[s] = sample[s];
  return out;
}

type Xyz = { x?: number | null; y?: number | null; z?: number | null } | null | undefined;
type Abg = { alpha?: number | null; beta?: number | null; gamma?: number | null } | null | undefined;
export interface WebMotionEvent {
  timeStamp: number;
  acceleration?: Xyz;
  accelerationIncludingGravity?: Xyz;
  rotationRate?: Abg;
}
export interface WebOrientationEvent {
  alpha?: number | null;
  beta?: number | null;
  gamma?: number | null;
}

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * A DeviceMotionEvent (and the latest DeviceOrientationEvent) as a sample. The web reports m/s²
 * with the opposite sign to CoreMotion's gravity, and deg/s; this turns both into CoreMotion's.
 */
export function sampleFromWeb(e: WebMotionEvent, orientation: WebOrientationEvent | null, t0: number): MotionSample {
  const acc = e.acceleration;
  const incl = e.accelerationIncludingGravity;
  const sample: MotionSample = { t: Math.max(0, (e.timeStamp - t0) / 1000) };
  sample.userAcceleration = { x: -n(acc?.x) / G, y: -n(acc?.y) / G, z: -n(acc?.z) / G };
  if (incl) sample.gravity = { x: -(n(incl.x) - n(acc?.x)) / G, y: -(n(incl.y) - n(acc?.y)) / G, z: -(n(incl.z) - n(acc?.z)) / G };
  const r = e.rotationRate;
  sample.rotationRate = { x: n(r?.beta) * RAD, y: n(r?.gamma) * RAD, z: n(r?.alpha) * RAD };
  if (orientation) sample.attitude = { roll: n(orientation.gamma) * RAD, pitch: n(orientation.beta) * RAD, yaw: n(orientation.alpha) * RAD };
  else if (sample.gravity) {
    const g = sample.gravity;
    sample.attitude = { roll: Math.atan2(g.x, -g.z), pitch: Math.asin(Math.max(-1, Math.min(1, -g.y))), yaw: 0 };
  }
  return sample;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (e: any) => void;
export interface MotionGlobal {
  addEventListener?: (type: string, fn: Listener) => void;
  removeEventListener?: (type: string, fn: Listener) => void;
  requestAnimationFrame?: (fn: () => void) => number;
  cancelAnimationFrame?: (id: number) => void;
  DeviceMotionEvent?: { requestPermission?: () => Promise<string> };
  DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
}

/** Does this browser have motion events at all? */
export const hasWebMotion = (g: MotionGlobal) => typeof g.DeviceMotionEvent !== 'undefined' && typeof g.addEventListener === 'function';

/**
 * Streams DeviceMotionEvent samples, at most `hz` of them a second, batched per animation frame.
 * Returns a function that stops it.
 */
export function startWebMotion(g: MotionGlobal, hz: number, sensors: readonly MotionSensor[], onBatch: (b: MotionBatch) => void): () => void {
  let orientation: WebOrientationEvent | null = null;
  let t0: number | null = null;
  let last = -Infinity;
  let pending: MotionSample[] = [];
  let frame: number | null = null;
  const minGap = 1000 / hz - 0.5;
  const raf = g.requestAnimationFrame?.bind(g) ?? ((fn: () => void) => setTimeout(fn, 16) as unknown as number);
  const caf = g.cancelAnimationFrame?.bind(g) ?? ((id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
  const flush = () => {
    frame = null;
    if (!pending.length) return;
    const samples = pending;
    pending = [];
    onBatch({ samples });
  };
  const onOrientation = (e: WebOrientationEvent) => {
    orientation = e;
  };
  const onMotion = (e: WebMotionEvent) => {
    if (t0 === null) t0 = e.timeStamp;
    if (e.timeStamp - last < minGap) return;
    last = e.timeStamp;
    pending.push(pick(sampleFromWeb(e, orientation, t0), sensors));
    if (frame === null) frame = raf(flush);
  };
  g.addEventListener?.('deviceorientation', onOrientation as Listener);
  g.addEventListener?.('devicemotion', onMotion as Listener);
  return () => {
    g.removeEventListener?.('deviceorientation', onOrientation as Listener);
    g.removeEventListener?.('devicemotion', onMotion as Listener);
    if (frame !== null) caf(frame);
    frame = null;
    pending = [];
  };
}

/** iOS Safari asks before a page gets motion events; call it from a tap. Elsewhere it's just granted. */
export async function requestWebMotionPermission(g: MotionGlobal): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!hasWebMotion(g)) return 'unsupported';
  const ask = [g.DeviceMotionEvent?.requestPermission, g.DeviceOrientationEvent?.requestPermission];
  try {
    for (const [i, fn] of ask.entries()) {
      if (typeof fn !== 'function') continue;
      const owner = i === 0 ? g.DeviceMotionEvent : g.DeviceOrientationEvent;
      if ((await fn.call(owner)) !== 'granted') return 'denied';
    }
    return 'granted';
  } catch {
    return 'denied';
  }
}

export interface FakeMotionOptions {
  /** Sway gently on its own (for demos and screenshots) whenever nobody has `set` it for 2 s. */
  wobble?: boolean;
  /** Clock and timers, for tests. */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

/**
 * A pretend CoreMotion for `installFakeNative`: `{ ...fake.handlers }` answers `motion.start` and
 * `motion.stop`; `set({ roll, pitch })` tilts it (keyboard or drag in a demo). Emits ~60 batches a
 * second holding `hz` samples a second between them, like the app.
 */
export function fakeMotion(opts: FakeMotionOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const every = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear = opts.clearInterval ?? ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));
  let attitude: Attitude = { roll: 0, pitch: 0, yaw: 0 };
  let setAt = -Infinity;
  let timer: unknown = null;
  let channel: string | null = null;
  let count = 0;

  const current = (tMs: number): Attitude => {
    if (!opts.wobble || tMs - setAt < 2000) return attitude;
    const s = tMs / 1000;
    return { roll: 0.35 * Math.sin(s * 0.9), pitch: 0.25 * Math.sin(s * 0.6 + 1), yaw: 0.2 * Math.sin(s * 0.3) };
  };
  const stop = () => {
    if (timer !== null) clear(timer);
    timer = null;
    channel = null;
  };

  const handlers = {
    'motion.start': (args: { hz: number; sensors?: MotionSensor[] }, ctx: { emit: (channel: string, payload: unknown) => void }) => {
      stop();
      const hz = clampHz(args.hz);
      const sensors = args.sensors?.length ? args.sensors : MOTION_SENSORS;
      const id = `fake-motion-${++count}`;
      channel = id;
      const t0 = now();
      let sent = 0;
      let prev = current(t0);
      timer = every(() => {
        const t = now();
        const due = Math.floor(((t - t0) / 1000) * hz) - sent;
        if (due <= 0 || channel !== id) return;
        const samples: MotionSample[] = [];
        for (let i = 1; i <= due; i++) {
          const ts = t0 + ((sent + i) / hz) * 1000;
          const a = current(ts);
          const dt = 1 / hz;
          const rate = { x: (a.pitch - prev.pitch) / dt, y: (a.roll - prev.roll) / dt, z: (a.yaw - prev.yaw) / dt };
          prev = a;
          samples.push(pick({ t: (ts - t0) / 1000, userAcceleration: { x: 0, y: 0, z: 0 }, rotationRate: rate, gravity: gravityFor(a), attitude: { ...a } }, sensors));
        }
        sent += due;
        ctx.emit(id, { samples });
      }, 1000 / 60);
      return { channel: id, hz };
    },
    'motion.stop': (args: { channel: string }) => {
      if (args.channel === channel) stop();
      return {};
    },
  };

  return {
    handlers,
    /** Tilt the pretend phone (radians); it holds there (and stops wobbling for 2 s). */
    set(a: Partial<Attitude>) {
      attitude = { ...attitude, ...a };
      setAt = now();
    },
    get attitude() {
      return current(now());
    },
    get running() {
      return channel !== null;
    },
    stop,
  };
}
