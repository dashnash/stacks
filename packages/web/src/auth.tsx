import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, createClient, type Client, type Session } from './client';

export type AuthStatus = 'loading' | 'signedIn' | 'signedOut';

/**
 * Why there is no app session although the person may be signed in to the platform:
 * `access_required` (signed in, no role in this private app: offer "Request access"),
 * `access_pending` (they asked; waiting for approval) or `access_denied` (blocked from this app).
 */
export type AccessNotice = 'access_required' | 'access_pending' | 'access_denied' | string | null;

export interface StacksContextValue {
  status: AuthStatus;
  session: Session | null;
  api: Client;
  accessNotice: AccessNotice;
  /** Go through the platform sign-in and come back to `returnTo` (default: the current page). */
  signIn(returnTo?: string): void;
  /** End this app's session and the platform's (every app), then come back to this page, signed out. */
  signOut(): Promise<void>;
  /** Re-read the session (e.g. after the role may have changed); `silent: false` skips asking the platform. */
  refresh(opts?: { silent?: boolean }): Promise<void>;
}

const StacksContext = createContext<StacksContextValue | null>(null);

/** Indirection so tests and the demo can watch navigation instead of leaving the page. */
export interface Navigator {
  assign(url: string): void;
  /** The current page, as a path (`/x?y#z`). */
  current(): string;
  /** The current page, as an absolute URL (for the platform to send people back to). */
  href?(): string;
}
const browserNavigator: Navigator = {
  assign: (url) => window.location.assign(url),
  current: () => window.location.pathname + window.location.search + window.location.hash,
  href: () => window.location.href,
};

/** How often a signed-out page re-asks the platform (e.g. when you come back to the tab). */
const SILENT_RETRY_MS = 30_000;
const SILENT_KEY = 'stacks.silent.at';
function lastSilent(): number {
  try {
    return Number(sessionStorage.getItem(SILENT_KEY) ?? 0);
  } catch {
    return 0;
  }
}
function markSilent(): void {
  try {
    sessionStorage.setItem(SILENT_KEY, String(Date.now()));
  } catch {
    // no storage: we may ask a little more often
  }
}

function readAccessNotice(): AccessNotice {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const notice = params.get('stacks_access');
  if (notice) {
    params.delete('stacks_access');
    const query = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
  }
  return notice;
}

export function StacksProvider({
  children,
  client,
  navigator = browserNavigator,
  silentSignIn = true,
  platformFetch,
}: {
  children: ReactNode;
  /** Defaults to `createClient()`; the demo passes one backed by the in-browser API. */
  client?: Client;
  navigator?: Navigator;
  /**
   * Sign in without a click when the person is already signed in to the platform (default true).
   * The page asks the platform in the background; nothing redirects. The demo turns it off.
   */
  silentSignIn?: boolean;
  /** How the page reaches the platform for silent sign-in (tests replace it). */
  platformFetch?: typeof fetch;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [accessNotice, setAccessNotice] = useState<AccessNotice>(readAccessNotice);
  const [maintenance, setMaintenance] = useState(false);
  // A ref, so a new function each render doesn't re-run the session effect.
  const platformFetchRef = useRef(platformFetch);
  platformFetchRef.current = platformFetch;

  const api = useMemo(
    () =>
      client ??
      createClient({
        onUnauthorized: () => {
          setSession(null);
          setStatus('signedOut');
        },
      }),
    [client],
  );

  /** Ask the platform whether the person is signed in there; if so, start an app session. */
  const trySilent = useCallback(async (): Promise<Session | null> => {
    markSilent();
    try {
      const { url, state } = await api.get<{ url: string; state: string }>('/auth/silent-start');
      const res = await (platformFetchRef.current ?? fetch)(url, { credentials: 'include' });
      const answer = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      if (answer.code) {
        setAccessNotice(null);
        return await api.post<Session>('/auth/silent-finish', { code: answer.code, state });
      }
      if (answer.error === 'access_required' || answer.error === 'access_pending' || answer.error === 'access_denied') setAccessNotice(answer.error);
    } catch {
      // Platform unreachable or no session there: stay signed out quietly.
    }
    return null;
  }, [api]);

  const refresh = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      try {
        const s = await api.session();
        setMaintenance(false);
        setSession(s);
        setStatus('signedIn');
        return;
      } catch (err) {
        if (isMaintenance(err)) {
          setMaintenance(true);
          return;
        }
        setMaintenance(false);
        if (!(err instanceof ApiError) || err.status !== 401) console.error('Could not load the session', err);
      }
      const silent = opts.silent ?? silentSignIn;
      const s = silent && Date.now() - lastSilent() > SILENT_RETRY_MS ? await trySilent() : null;
      setSession(s);
      setStatus(s ? 'signedIn' : 'signedOut');
    },
    [api, silentSignIn, trySilent],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Signed in on the portal (or another app) since this tab loaded? Pick it up when they come back.
  useEffect(() => {
    if (!silentSignIn || status !== 'signedOut' || typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [silentSignIn, status, refresh]);

  const value = useMemo<StacksContextValue>(
    () => ({
      status,
      session,
      api,
      accessNotice,
      refresh,
      signIn: (returnTo) => navigator.assign(`/api/auth/login?return=${encodeURIComponent(returnTo ?? navigator.current())}`),
      signOut: async () => {
        const { platformLogoutUrl } = await api.logout();
        setSession(null);
        setStatus('signedOut');
        // The platform ends every session, then sends them back here (it only accepts its own apps).
        markSilent();
        const back = navigator.href?.();
        navigator.assign(back ? `${platformLogoutUrl}?return=${encodeURIComponent(back)}` : platformLogoutUrl);
      },
    }),
    [status, session, api, accessNotice, refresh, navigator],
  );

  return <StacksContext.Provider value={value}>{maintenance ? <MaintenanceNotice onRetry={() => void refresh()} /> : children}</StacksContext.Provider>;
}

/** True for the API's 503 while the platform is in maintenance. */
export const isMaintenance = (err: unknown) => err instanceof ApiError && err.status === 503 && err.code === 'MAINTENANCE';

/** Shown instead of the app (or portal) while the platform is in maintenance (the user-id cut-over). */
export function MaintenanceNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <main role="main" style={{ maxWidth: '32rem', margin: '20vh auto', padding: '0 16px', fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}>
      <h1 style={{ fontSize: '1.5rem' }}>Back in a few minutes</h1>
      <p>Stacks is being upgraded. Nothing you saved is lost.</p>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </main>
  );
}

export function useStacks(): StacksContextValue {
  const ctx = useContext(StacksContext);
  if (!ctx) throw new Error('useStacks must be used inside <StacksProvider>');
  return ctx;
}

/** Like useStacks, but null outside a <StacksProvider> (for components tested with fakes). */
export function useOptionalStacks(): StacksContextValue | null {
  return useContext(StacksContext);
}

/** The API client for the app's own `/api`. */
export function useApi(): Client {
  return useStacks().api;
}
