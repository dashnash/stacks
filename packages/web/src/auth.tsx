import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, createClient, type Client, type Session } from './client';
import { PortalBar, type PortalBarMode } from './PortalBar';

export type AuthStatus = 'loading' | 'signedIn' | 'signedOut';

/**
 * Why the platform sent the user back without a session, from `?stacks_access=` after a
 * sign-in attempt: `access_pending` (they asked for access to a private app) or `access_denied`.
 */
export type AccessNotice = 'access_pending' | 'access_denied' | string | null;

export interface StacksContextValue {
  status: AuthStatus;
  session: Session | null;
  api: Client;
  accessNotice: AccessNotice;
  /** Go through the platform sign-in and come back to `returnTo` (default: the current page). */
  signIn(returnTo?: string): void;
  /** End this app's session and the platform's, signing out of every app. */
  signOut(): Promise<void>;
  /** Re-read the session (e.g. after the role may have changed). */
  refresh(): Promise<void>;
}

const StacksContext = createContext<StacksContextValue | null>(null);

/** Indirection so tests and the demo can watch navigation instead of leaving the page. */
export interface Navigator {
  assign(url: string): void;
  current(): string;
}
const browserNavigator: Navigator = {
  assign: (url) => window.location.assign(url),
  current: () => window.location.pathname + window.location.search + window.location.hash,
};

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
  portalBar = 'minimized',
}: {
  children: ReactNode;
  /** The platform overlay for signed-in users (usually the manifest's `portalBar`). */
  portalBar?: PortalBarMode;
  /** Defaults to `createClient()`; the demo passes one backed by the in-browser API. */
  client?: Client;
  navigator?: Navigator;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [accessNotice] = useState<AccessNotice>(readAccessNotice);

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

  const refresh = useCallback(async () => {
    try {
      const s = await api.session();
      setSession(s);
      setStatus('signedIn');
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) console.error('Could not load the session', err);
      setSession(null);
      setStatus('signedOut');
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        navigator.assign(platformLogoutUrl);
      },
    }),
    [status, session, api, accessNotice, refresh, navigator],
  );

  return (
    <StacksContext.Provider value={value}>
      {children}
      <PortalBar mode={portalBar} />
    </StacksContext.Provider>
  );
}

export function useStacks(): StacksContextValue {
  const ctx = useContext(StacksContext);
  if (!ctx) throw new Error('useStacks must be used inside <StacksProvider>');
  return ctx;
}

/** The API client for the app's own `/api`. */
export function useApi(): Client {
  return useStacks().api;
}
