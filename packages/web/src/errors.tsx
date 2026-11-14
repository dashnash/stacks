/// <reference path="./env.d.ts" />
import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';

/*
 * Browser error capture, on for every app with no app code: `<StacksProvider>` renders
 * `<ErrorReporting>`, which listens for window errors and unhandled rejections and catches React
 * render crashes. Each is posted to the app's own API (`POST /api/stacks/client-error`), which
 * writes it to the app's log with the build it came from (docs/DEBUGGING.md).
 */

export type ErrorSource = 'error' | 'unhandledrejection' | 'render';

/** What the browser sends. The stack is as the browser has it (minified); the build says which code. */
export interface ErrorReport {
  message: string;
  stack?: string;
  source: ErrorSource;
  /** The page's path and hash route, without any query string. */
  path: string;
  build: string;
}

/** Sends one report; a rejection or throw is swallowed. */
export type PostError = (report: ErrorReport) => unknown;

/** At most this many reports per page load: a crash loop must not flood the API. */
export const MAX_ERROR_REPORTS = 5;
const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
/** Browser noise that is not a bug in the app. */
const IGNORED = /^ResizeObserver loop/;

function buildSha(): string {
  try {
    return import.meta.env.VITE_STACKS_BUILD_SHA || 'dev';
  } catch {
    return 'dev';
  }
}

function pagePath(): string {
  try {
    return (window.location.pathname + window.location.hash).split('?')[0]!.slice(0, 300);
  } catch {
    return '';
  }
}

function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message || err.name, ...(err.stack ? { stack: err.stack } : {}) };
  if (typeof err === 'string') return { message: err };
  try {
    return { message: JSON.stringify(err) ?? String(err) };
  } catch {
    return { message: String(err) };
  }
}

interface Reporter {
  report(err: unknown, source: ErrorSource): void;
}

function createReporter(post: PostError | 'console'): Reporter {
  const seen = new Set<string>();
  let sent = 0;
  return {
    report(err, source) {
      try {
        const { message, stack } = describe(err);
        if (!message || IGNORED.test(message) || seen.has(message) || sent >= MAX_ERROR_REPORTS) return;
        seen.add(message);
        sent++;
        const report: ErrorReport = { message: message.slice(0, MAX_MESSAGE), ...(stack ? { stack: stack.slice(0, MAX_STACK) } : {}), source, path: pagePath(), build: buildSha() };
        if (post === 'console') {
          // The demo has no server to tell.
          console.warn('[stacks demo] error (not reported):', report.message);
          return;
        }
        // A failed post is dropped: reporting it would loop.
        void Promise.resolve(post(report)).catch(() => undefined);
      } catch {
        // Reporting never throws into the page.
      }
    },
  };
}

let active: Reporter | null = null;

/**
 * Start capturing: window `error` events and unhandled promise rejections are sent with `post`
 * (or, with `'console'`, only logged: the demo). At most {@link MAX_ERROR_REPORTS} per page load,
 * each message once. Returns a function that stops it. `<StacksProvider>` calls this for you.
 */
export function installErrorReporting(post: PostError | 'console'): () => void {
  const reporter = createReporter(post);
  active = reporter;
  if (typeof window === 'undefined') return () => undefined;
  const onError = (e: ErrorEvent) => reporter.report(e.error ?? e.message, 'error');
  const onRejection = (e: PromiseRejectionEvent) => reporter.report(e.reason, 'unhandledrejection');
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    if (active === reporter) active = null;
  };
}

/** Report an error by hand (something caught that the owner should still see). Does nothing before `installErrorReporting`. */
export function reportError(err: unknown, source: ErrorSource = 'error'): void {
  active?.report(err, source);
}

interface BoundaryProps {
  children: ReactNode;
  /** What to show instead of the crashed part. Default: a short note with a reload button. */
  fallback?: ReactNode | ((reload: () => void) => ReactNode);
}

/**
 * Catches a crash while rendering what is inside, reports it (`source: "render"`) and shows a
 * fallback with a reload button instead of a blank page. `<StacksProvider>` already wraps the
 * whole app in one; add your own around a part that may fail on its own.
 */
export class ErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    reportError(error, 'render');
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const reload = () => window.location.reload();
    const { fallback } = this.props;
    if (typeof fallback === 'function') return fallback(reload);
    if (fallback !== undefined) return fallback;
    return (
      <main role="alert" style={{ maxWidth: '32rem', margin: '20vh auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.5rem' }}>Something went wrong</h1>
        <p>The page hit a problem. Reloading usually fixes it.</p>
        <button type="button" onClick={reload}>
          Reload
        </button>
      </main>
    );
  }
}

/**
 * Error capture for everything inside: installs the listeners and an {@link ErrorBoundary}.
 * `post` sends a report to the API; `'console'` (the demo) only logs it.
 */
export function ErrorReporting({ post, children }: { post: PostError | 'console'; children: ReactNode }) {
  useEffect(() => installErrorReporting(post), [post]);
  return <ErrorBoundary>{children}</ErrorBoundary>;
}
