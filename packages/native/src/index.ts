/**
 * @stacks/native: what a page can ask of the Stacks iOS app (DashyHQ), with web fallbacks so the
 * same code works in Safari, in tests and in demo mode. The wire format is native/protocol/v1.json.
 */

import {
  clampHz,
  hasWebMotion,
  MOTION_SENSORS,
  requestWebMotionPermission,
  startWebMotion,
  type MotionBatch,
  type MotionGlobal,
  type MotionSensor,
} from './motion';

export * from './motion';

/** The protocol this package speaks (native/protocol/v1.json). */
export const PROTOCOL = 1;

export type NativeErrorCode = 'unsupported' | 'forbidden' | 'cancelled' | 'failed';

export type Reply<T> = { ok: true; result: T } | { ok: false; error: { code: NativeErrorCode; message: string } };

/** What the app injects as `window.stacksNative` at document start. */
export interface NativeHost {
  protocol: number;
  platform: string;
  /** The app's version, e.g. "1.0.0". */
  version: string;
  /** The calls this app version understands. */
  calls: string[];
  call(name: string, args: Record<string, unknown>): Promise<Reply<unknown>>;
  /** Streams (motion batches): subscribe to a channel a call returned; returns an unsubscribe. */
  listen?(channel: string, fn: (payload: unknown) => void): () => void;
}

export class NativeError extends Error {
  constructor(
    public readonly code: NativeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NativeError';
  }
}

/** The calls and their shapes (see native/protocol/v1.json). */
export interface Calls {
  /** `commit`: the git commit CI built the app from ("" for a local build; absent in older apps). */
  'app.info': { args: Record<string, never>; result: { version: string; build: string; commit?: string; platform: string; protocol: number } };
  'auth.google': { args: Record<string, never>; result: { credential: string } };
  /** Portal only: Apple's identity token, and the name Apple shared (first sign-in only, else ""). */
  'auth.apple': { args: Record<string, never>; result: { credential: string; name: string } };
  'auth.signedOut': { args: Record<string, never>; result: Record<string, never> };
  share: { args: ShareData; result: { completed: boolean } };
  /** Portal only: may this device show notifications, and its platform device id (null until registered). */
  'push.status': { args: Record<string, never>; result: { permission: PushPermission; deviceId: string | null } };
  /** Portal only: asks for permission (once) and returns the APNs token to register with `POST /devices`. */
  'push.register': { args: Record<string, never>; result: PushRegistration };
  /** Portal only: the app keeps the device id and secret `POST /devices` returned (Keychain). */
  'push.saveDevice': { args: { id: string; secret: string }; result: Record<string, never> };
  /** Portal only: the app icon's number. */
  'badge.set': { args: { count: number }; result: Record<string, never> };
  /** Apps that declare `motion`: CoreMotion batches on `channel` (use `native.motion.start`). */
  'motion.start': { args: { hz: number; sensors?: MotionSensor[] }; result: { channel: string; hz: number } };
  'motion.stop': { args: { channel: string }; result: Record<string, never> };
  /** Apps that declare `haptics`. */
  'haptics.impact': { args: { style: ImpactStyle }; result: Record<string, never> };
  'haptics.notification': { args: { type: NotificationType }; result: Record<string, never> };
  'haptics.pattern': { args: { events: HapticEvent[] }; result: Record<string, never> };
  /** Apps that declare `screen`. All undone when the page goes away. */
  'screen.lockOrientation': { args: { orientation: Orientation }; result: Record<string, never> };
  'screen.immersive': { args: { on: boolean }; result: Record<string, never> };
  'screen.keepAwake': { args: { on: boolean }; result: Record<string, never> };
}

export type ImpactStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid';
export type NotificationType = 'success' | 'warning' | 'error';
export type Orientation = 'portrait' | 'landscape' | 'any';
/** Seconds and 0-1. With `duration` it's a continuous buzz, without it a tap. */
export interface HapticEvent {
  t: number;
  intensity: number;
  sharpness: number;
  duration?: number;
}
export const MAX_PATTERN_EVENTS = 32;
export const MAX_PATTERN_SECONDS = 5;

export type MotionSource = 'native' | 'web' | 'none';

export interface MotionOptions {
  /** Samples a second, 10-100 (default 60). The web gives what the browser gives, up to this. */
  hz?: number;
  sensors?: MotionSensor[];
  /** `auto` (default): the app's CoreMotion when it has it, else the browser's motion events. */
  source?: 'auto' | 'native' | 'web';
  /** The stream couldn't start (`unsupported`, `forbidden`, ...). */
  onError?: (err: NativeError) => void;
}

/** Stops the stream; also says where it comes from and, once started, at what rate. */
export interface MotionStop {
  (): void;
  readonly source: MotionSource;
  /** Resolves with the rate the source runs at; rejects (and calls `onError`) when it can't start. */
  readonly ready: Promise<{ hz: number }>;
}

export type PushPermission = 'granted' | 'denied' | 'notDetermined';

export interface PushRegistration {
  /** APNs device token, hex. */
  token: string;
  /** `sandbox` for builds run from Xcode, `production` for TestFlight and the App Store. */
  env: 'sandbox' | 'production';
  bundleId: string;
  deviceName: string;
}

export interface ShareData {
  url?: string;
  text?: string;
  title?: string;
}

type Global = MotionGlobal & {
  stacksNative?: NativeHost;
  navigator?: Navigator & { vibrate?: (p: number | number[]) => boolean; wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
  screen?: { orientation?: { lock?: (o: string) => Promise<void>; unlock?: () => void } };
};

export interface Native {
  /** True inside the app (any version that speaks this protocol). */
  readonly available: boolean;
  readonly platform: string | null;
  readonly version: string | null;
  /** Does this app version understand `name`? (The app may still refuse it here: `forbidden`.) */
  has(name: keyof Calls | string): boolean;
  call<K extends keyof Calls>(name: K, args?: Calls[K]['args']): Promise<Calls[K]['result']>;
  /** The system share sheet; in a browser, `navigator.share`. */
  share(data: ShareData): Promise<{ completed: boolean }>;
  motion: {
    /** Where `start` would read from: the app (`native`), the browser (`web`) or nowhere. */
    readonly source: MotionSource;
    start(opts: MotionOptions, onBatch: (batch: MotionBatch) => void): MotionStop;
    /** Browser motion only: iOS Safari asks first (call it from a tap). In the app, `granted`. */
    requestPermission(): Promise<'granted' | 'denied' | 'unsupported'>;
  };
  /** Felt in the app; `navigator.vibrate` where the browser has it; otherwise nothing (never throws for lack of support). */
  haptics: {
    impact(style?: ImpactStyle): Promise<void>;
    notification(type: NotificationType): Promise<void>;
    pattern(events: HapticEvent[]): Promise<void>;
  };
  screen: {
    /** In a browser, `screen.orientation.lock` (most phones' browsers refuse: `unsupported`). */
    lockOrientation(orientation: Orientation): Promise<void>;
    /** App only (`unsupported` in a browser). */
    immersive(on: boolean): Promise<void>;
    /** In a browser, the Screen Wake Lock API. */
    keepAwake(on: boolean): Promise<void>;
  };
}

const asNativeError = (err: unknown) => (err instanceof NativeError ? err : new NativeError('failed', (err as Error)?.message ?? String(err)));

const host = (g: Global): NativeHost | null => {
  const h = g.stacksNative;
  return h && typeof h.call === 'function' && h.protocol === PROTOCOL ? h : null;
};

/** The bridge for this page (or for a given global, in tests). */
export function getNative(g: Global = globalThis as Global): Native {
  const h = () => host(g);
  const native: Native = {
    get available() {
      return !!h();
    },
    get platform() {
      return h()?.platform ?? null;
    },
    get version() {
      return h()?.version ?? null;
    },
    has: (name) => !!h()?.calls.includes(name),
    async call(name, args) {
      const bridge = h();
      if (!bridge || !bridge.calls.includes(name)) throw new NativeError('unsupported', `"${name}" needs the Stacks app`);
      let reply: Reply<unknown>;
      try {
        reply = await bridge.call(name, (args ?? {}) as Record<string, unknown>);
      } catch (err) {
        throw new NativeError('failed', (err as Error)?.message ?? String(err));
      }
      if (!reply || typeof reply !== 'object' || !('ok' in reply)) throw new NativeError('failed', `"${name}" gave no answer`);
      if (!reply.ok) throw new NativeError(reply.error.code, reply.error.message);
      return reply.result as never;
    },
    async share(data) {
      if (native.has('share')) return native.call('share', data);
      const nav = g.navigator;
      if (!nav?.share) throw new NativeError('unsupported', 'Sharing is not available here');
      try {
        await nav.share(data);
        return { completed: true };
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return { completed: false };
        throw new NativeError('failed', (err as Error)?.message ?? String(err));
      }
    },
    motion: {
      get source(): MotionSource {
        const b = h();
        if (b && b.calls.includes('motion.start') && typeof b.listen === 'function') return 'native';
        return hasWebMotion(g) ? 'web' : 'none';
      },
      start(opts, onBatch) {
        const hz = clampHz(opts.hz);
        const sensors = opts.sensors?.length ? opts.sensors : [...MOTION_SENSORS];
        const want = opts.source ?? 'auto';
        const auto = native.motion.source;
        const source: MotionSource = want === 'auto' ? auto : want === 'native' ? (auto === 'native' ? 'native' : 'none') : hasWebMotion(g) ? 'web' : 'none';
        let stopped = false;
        let undo = () => {};
        let ready: Promise<{ hz: number }>;
        if (source === 'web') {
          undo = startWebMotion(g, hz, sensors, onBatch);
          ready = Promise.resolve({ hz });
        } else if (source === 'native') {
          ready = (async () => {
            const started = await native.call('motion.start', { hz, sensors });
            if (stopped) {
              void native.call('motion.stop', { channel: started.channel }).catch(() => {});
              return { hz: started.hz };
            }
            const unlisten = h()!.listen!(started.channel, (p) => onBatch(p as MotionBatch));
            undo = () => {
              unlisten();
              void native.call('motion.stop', { channel: started.channel }).catch(() => {});
            };
            return { hz: started.hz };
          })();
        } else {
          ready = Promise.reject(new NativeError('unsupported', 'No motion sensors here'));
        }
        ready = ready.catch((err) => {
          const e = asNativeError(err);
          opts.onError?.(e);
          throw e;
        });
        ready.catch(() => {}); // the caller may never look
        const stop = () => {
          if (stopped) return;
          stopped = true;
          undo();
        };
        return Object.assign(stop, { source, ready }) as MotionStop;
      },
      async requestPermission() {
        if (native.motion.source === 'native') return 'granted';
        return requestWebMotionPermission(g);
      },
    },
    haptics: {
      async impact(style = 'medium') {
        if (native.has('haptics.impact')) return void (await native.call('haptics.impact', { style }));
        g.navigator?.vibrate?.(style === 'light' || style === 'soft' ? 10 : style === 'heavy' || style === 'rigid' ? 40 : 20);
      },
      async notification(type) {
        if (native.has('haptics.notification')) return void (await native.call('haptics.notification', { type }));
        g.navigator?.vibrate?.(type === 'success' ? [20, 60, 20] : type === 'warning' ? [40, 80, 40] : [60, 60, 60, 60, 60]);
      },
      async pattern(events) {
        if (events.length > MAX_PATTERN_EVENTS) throw new NativeError('failed', `At most ${MAX_PATTERN_EVENTS} events in a pattern`);
        if (events.some((e) => e.t + (e.duration ?? 0) > MAX_PATTERN_SECONDS)) throw new NativeError('failed', `A pattern lasts at most ${MAX_PATTERN_SECONDS} s`);
        if (native.has('haptics.pattern')) return void (await native.call('haptics.pattern', { events }));
        const vibrate = g.navigator?.vibrate;
        if (!vibrate || !events.length) return;
        // On and off times, in ms, from the events' starts and lengths.
        const steps: number[] = [];
        let at = 0;
        for (const e of [...events].sort((a, b) => a.t - b.t)) {
          const start = Math.round(e.t * 1000);
          if (steps.length) steps.push(Math.max(0, start - at));
          const len = Math.max(10, Math.round((e.duration ?? 0.02) * 1000 * Math.max(0.2, e.intensity)));
          steps.push(len);
          at = start + len;
        }
        vibrate.call(g.navigator, steps);
      },
    },
    screen: {
      async lockOrientation(orientation) {
        if (native.has('screen.lockOrientation')) return void (await native.call('screen.lockOrientation', { orientation }));
        const o = g.screen?.orientation;
        try {
          if (orientation === 'any') return void o?.unlock?.();
          if (!o?.lock) throw new Error('no lock');
          await o.lock(orientation);
        } catch {
          throw new NativeError('unsupported', 'This browser cannot lock the orientation');
        }
      },
      async immersive(on) {
        if (native.has('screen.immersive')) return void (await native.call('screen.immersive', { on }));
        throw new NativeError('unsupported', 'Immersive mode needs the Stacks app');
      },
      async keepAwake(on) {
        if (native.has('screen.keepAwake')) return void (await native.call('screen.keepAwake', { on }));
        if (!on) {
          await wakeLocks.get(g)?.release().catch(() => {});
          wakeLocks.delete(g);
          return;
        }
        const wl = g.navigator?.wakeLock;
        if (!wl) throw new NativeError('unsupported', 'This browser cannot keep the screen awake');
        try {
          wakeLocks.set(g, await wl.request('screen'));
        } catch (err) {
          throw new NativeError('failed', (err as Error)?.message ?? String(err));
        }
      },
    },
  };
  return native;
}

const wakeLocks = new WeakMap<object, { release(): Promise<void> }>();

/** The bridge for this page. */
export const native: Native = getNative();

/** Is version `a` at least `b`? ("1.2.0" vs "1.10.0" compare as numbers.) */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}

/** What a fake handler can do besides answering: push events to a channel (like the app's motion batches). */
export interface FakeContext {
  emit(channel: string, payload: unknown): void;
}

export type FakeHandlers = { [K in keyof Calls]?: (args: Calls[K]['args'], ctx: FakeContext) => Calls[K]['result'] | Promise<Calls[K]['result']> };

/** Handlers that say yes to every haptics and screen call (for demos), recording nothing. */
export const fakeGameKit = (): FakeHandlers => ({
  'haptics.impact': () => ({}),
  'haptics.notification': () => ({}),
  'haptics.pattern': () => ({}),
  'screen.lockOrientation': () => ({}),
  'screen.immersive': () => ({}),
  'screen.keepAwake': () => ({}),
});

/**
 * A pretend app, for tests and demos: installs `stacksNative` on `g` (default the page), answering
 * with `handlers`. A handler that throws a `NativeError` answers with that error. Returns the host
 * and a log of calls; `remove()` takes it away again.
 */
export function installFakeNative(handlers: FakeHandlers, g: Global = globalThis as Global, opts: { version?: string } = {}) {
  const log: { name: string; args: unknown }[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const ctx: FakeContext = {
    emit(channel, payload) {
      for (const fn of [...(listeners.get(channel) ?? [])]) fn(payload);
    },
  };
  const fake: NativeHost = {
    protocol: PROTOCOL,
    platform: 'fake',
    version: opts.version ?? '1.0.0',
    calls: Object.keys(handlers),
    async call(name, args) {
      log.push({ name, args });
      const handler = (handlers as Record<string, ((a: unknown, c: FakeContext) => unknown) | undefined>)[name];
      if (!handler) return { ok: false, error: { code: 'unsupported', message: `No ${name}` } };
      try {
        return { ok: true, result: await handler(args, ctx) };
      } catch (err) {
        if (err instanceof NativeError) return { ok: false, error: { code: err.code, message: err.message } };
        return { ok: false, error: { code: 'failed', message: (err as Error)?.message ?? String(err) } };
      }
    },
  };
  fake.listen = (channel, fn) => {
    const set = listeners.get(channel) ?? new Set();
    set.add(fn);
    listeners.set(channel, set);
    return () => void set.delete(fn);
  };
  g.stacksNative = fake;
  return { host: fake, log, emit: ctx.emit, remove: () => void delete g.stacksNative };
}
