/**
 * @stacks/native: what a page can ask of the Stacks iOS app (DashyHQ), with web fallbacks so the
 * same code works in Safari, in tests and in demo mode. The wire format is native/protocol/v1.json.
 */

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
  'app.info': { args: Record<string, never>; result: { version: string; build: string; platform: string; protocol: number } };
  'auth.google': { args: Record<string, never>; result: { credential: string } };
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

type Global = { stacksNative?: NativeHost; navigator?: Navigator };

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
}

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
  };
  return native;
}

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

export type FakeHandlers = { [K in keyof Calls]?: (args: Calls[K]['args']) => Calls[K]['result'] | Promise<Calls[K]['result']> };

/**
 * A pretend app, for tests and demos: installs `stacksNative` on `g` (default the page), answering
 * with `handlers`. A handler that throws a `NativeError` answers with that error. Returns the host
 * and a log of calls; `remove()` takes it away again.
 */
export function installFakeNative(handlers: FakeHandlers, g: Global = globalThis as Global, opts: { version?: string } = {}) {
  const log: { name: string; args: unknown }[] = [];
  const fake: NativeHost = {
    protocol: PROTOCOL,
    platform: 'fake',
    version: opts.version ?? '1.0.0',
    calls: Object.keys(handlers),
    async call(name, args) {
      log.push({ name, args });
      const handler = (handlers as Record<string, ((a: unknown) => unknown) | undefined>)[name];
      if (!handler) return { ok: false, error: { code: 'unsupported', message: `No ${name}` } };
      try {
        return { ok: true, result: await handler(args) };
      } catch (err) {
        if (err instanceof NativeError) return { ok: false, error: { code: err.code, message: err.message } };
        return { ok: false, error: { code: 'failed', message: (err as Error)?.message ?? String(err) } };
      }
    },
  };
  g.stacksNative = fake;
  return { host: fake, log, remove: () => void delete g.stacksNative };
}
