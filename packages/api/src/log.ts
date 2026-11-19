/**
 * Structured logs: one JSON object per line, stamped with the current request's context, so a
 * user's error ref leads to the exact request and stack trace in CloudWatch (docs/PLATFORM_SPEC.md,
 * "Monitoring").
 *
 *   log.info('Reminder sent', { listId });
 *   log.error('Could not notify', err);
 *
 * A line may hold ids, counts and names of things. Never an email, a display name, a request or
 * response body, cookies, headers or a query string.
 */

/** `request`: one per API request. `error`: an unhandled error (a 500). `client-error`: reported by a browser. `app`: everything else. */
export type LogType = 'request' | 'error' | 'client-error' | 'app';
export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogLine = LogFields & { type: LogType; level: LogLevel; message: string; app: string; env: string; build: string };

/** What every line written during one request carries. The router fills it in as it learns more. */
export interface LogScope {
  app?: string;
  requestId: string;
  /** The short id shown to the person on a 500: the first 8 characters of the request id. */
  ref: string;
  /** The matched pattern (`/api/books/:id`), never the raw path. */
  route?: string;
  userId?: string;
}

interface ScopeStore {
  run<T>(scope: LogScope, fn: () => T): T;
  get(): LogScope | undefined;
}

/**
 * In Node the scope follows the request through every `await` (AsyncLocalStorage). This file also
 * runs in the browser (the demo runs the real API there), so `node:async_hooks` is looked up at
 * run time, never imported.
 */
function nodeStore(): ScopeStore | undefined {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const hooks = proc?.getBuiltinModule?.('node:async_hooks') as { AsyncLocalStorage: new () => { run<T>(s: LogScope, fn: () => T): T; getStore(): LogScope | undefined } } | undefined;
    if (!hooks) return undefined;
    const als = new hooks.AsyncLocalStorage();
    return { run: (scope, fn) => als.run(scope, fn), get: () => als.getStore() };
  } catch {
    return undefined;
  }
}

/** The browser stand-in: the scope of the request that started last. Good enough for a one-person demo. */
function simpleStore(): ScopeStore {
  let current: LogScope | undefined;
  return {
    get: () => current,
    run(scope, fn) {
      const before = current;
      const restore = () => {
        if (current === scope) current = before;
      };
      current = scope;
      try {
        const result = fn();
        if (result instanceof Promise) return result.finally(restore) as typeof result;
        restore();
        return result;
      } catch (err) {
        restore();
        throw err;
      }
    },
  };
}

const store: ScopeStore = nodeStore() ?? simpleStore();

const envVar = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];

// STACKS_APP_SLUG: for functions with no `createStacksApp` (the realtime authorizer).
/** The commit this Lambda runs (`STACKS_BUILD_SHA`, set at deploy), `dev` when unset. On every log line and in `/api/health` (#105). */
export const buildSha = (): string => envVar('STACKS_BUILD_SHA') || 'dev';
let defaultApp = envVar('STACKS_APP_SLUG') ?? 'unknown';
/** The slug for lines written outside a request (`createStacksApp` and the platform set it). */
export function setLogApp(app: string): void {
  defaultApp = app;
}

/** Where lines go: `(level, line)`. */
export type LogSink = (level: LogLevel, line: LogLine) => void;

/**
 * In Lambda every line goes to the console as an object, which Lambda's JSON log format nests under
 * `message`. Anywhere else (tests, the in-browser demo) info lines are dropped so they don't flood
 * the output; warnings and errors still print.
 */
const consoleSink: LogSink = (level, line) => {
  if (level === 'info' && !envVar('AWS_LAMBDA_FUNCTION_NAME')) return;
  // console.log, console.warn or console[error]: Lambda maps each to the line's level.
  console[level === 'info' ? 'log' : level](line);
};
let sink = consoleSink;

/** Send lines somewhere else (tests collect them). Returns a function that puts the previous sink back. */
export function setLogSink(next: LogSink): () => void {
  const before = sink;
  sink = next;
  return () => {
    sink = before;
  };
}

/** An error as it is logged: `{ name, message, stack }`. */
export function serializeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  let message: string;
  try {
    message = typeof err === 'string' ? err : JSON.stringify(err);
  } catch {
    message = String(err);
  }
  return { name: 'NonError', message: String(message).slice(0, 2000) };
}

const RESERVED = new Set(['type', 'level', 'message', 'app', 'env', 'build', 'requestId', 'ref', 'route', 'userId']);

/** Write one line. The SDK's own lines (`request`, `error`, `client-error`) come through here; app code uses {@link log}. */
export function writeLog(type: LogType, level: LogLevel, message: string, fields?: LogFields | unknown): void {
  try {
    const scope = store.get();
    const extra: LogFields = {};
    if (fields instanceof Error || (fields !== undefined && (fields === null || typeof fields !== 'object' || Array.isArray(fields)))) {
      extra.error = serializeError(fields);
    } else if (fields) {
      for (const [k, v] of Object.entries(fields as LogFields)) {
        if (RESERVED.has(k) || v === undefined) continue;
        extra[k] = v instanceof Error ? serializeError(v) : v;
      }
    }
    const line: LogLine = {
      type,
      level,
      message,
      app: scope?.app ?? defaultApp,
      env: envVar('STACKS_ENV_TAG') ?? 'dev',
      build: buildSha(),
      ...(scope ? { requestId: scope.requestId, ref: scope.ref, ...(scope.route ? { route: scope.route } : {}), ...(scope.userId ? { userId: scope.userId } : {}) } : {}),
      ...extra,
    };
    sink(level, line);
  } catch {
    // Logging never breaks the request it describes.
  }
}

/**
 * Write a line from app code. `fields` are extra facts (ids, counts); pass an `Error` instead (or
 * as a field) and it is logged as `{ name, message, stack }`.
 */
export const log = {
  info: (message: string, fields?: LogFields | Error | unknown) => writeLog('app', 'info', message, fields),
  warn: (message: string, fields?: LogFields | Error | unknown) => writeLog('app', 'warn', message, fields),
  error: (message: string, fields?: LogFields | Error | unknown) => writeLog('app', 'error', message, fields),
};

/** Run `fn` as one request: every line written inside carries `scope`. */
export function runInLogScope<T>(scope: LogScope, fn: () => T): T {
  return store.run(scope, fn);
}

/** The current request's scope, if any. */
export function currentLogScope(): LogScope | undefined {
  return store.get();
}

/** Name the signed-in person (their `u_…` id) on the rest of this request's lines. */
export function setLogUser(userId: string | undefined): void {
  const scope = store.get();
  if (scope && userId) scope.userId = userId;
}

const MAX_CLIENT_ERROR_BYTES = 8 * 1024;
const SOURCES = new Set(['error', 'unhandledrejection', 'render']);
const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value ? value.slice(0, max) : undefined);

/**
 * The body of `POST /api/stacks/client-error` (sent by `@stacks/web`), written as one
 * `client-error` line. Only the known fields are kept, shortened; returns false when the body is
 * too large (answer 400).
 */
export function logClientError(body: Record<string, unknown>): boolean {
  let size: number;
  try {
    size = JSON.stringify(body).length;
  } catch {
    return false;
  }
  if (size > MAX_CLIENT_ERROR_BYTES) return false;
  const source = typeof body.source === 'string' && SOURCES.has(body.source) ? body.source : 'error';
  // The page's path only: a query string can hold anything.
  const path = text(body.path, 300)?.split('?')[0];
  writeLog('client-error', 'error', text(body.message, 500) ?? 'Unknown error', {
    source,
    ...(text(body.stack, 4000) ? { stack: text(body.stack, 4000) } : {}),
    ...(path ? { path } : {}),
    clientBuild: text(body.build, 64) ?? 'dev',
  });
  return true;
}
