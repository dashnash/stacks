import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getNative } from '@stacks/native';
import { ApiError, isMaintenance, MaintenanceNotice } from '@stacks/web';
import type { Me, PortalApi } from './api';
import { syncWithApp } from './push';

/** How people sign in: Google in production; named personas in the demo. */
export type SignInMethod = { kind: 'google' } | { kind: 'personas'; personas: { email: string; name: string; blurb?: string }[] };

interface PortalContextValue {
  api: PortalApi;
  me: Me | null;
  status: 'loading' | 'signedIn' | 'signedOut';
  signInMethod: SignInMethod;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
}

const PortalContext = createContext<PortalContextValue | null>(null);

export function PortalProvider({ api, signInMethod, children }: { api: PortalApi; signInMethod: SignInMethod; children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<PortalContextValue['status']>('loading');
  const [maintenance, setMaintenance] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.me());
      setMaintenance(false);
      setStatus('signedIn');
    } catch (err) {
      setMaintenance(isMaintenance(err));
      if (isMaintenance(err)) return;
      if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      setMe(null);
      setStatus('signedOut');
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // In the iOS app: the icon's number follows the counts, and a device that already allows
  // notifications re-registers once per load (tokens change). Never prompts.
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    if (!me) return;
    const app = getNative();
    if (!synced) {
      setSynced(true);
      void syncWithApp(api, me);
    } else if (app.has('badge.set')) void app.call('badge.set', { count: me.unread + me.pendingRequests }).catch(() => undefined);
  }, [api, me, synced]);

  const value = useMemo<PortalContextValue>(
    () => ({
      api,
      me,
      status,
      signInMethod,
      refresh,
      signOut: async () => {
        await api.signOut();
        // In the iOS app, it forgets its Google session and this device's push registration too.
        const app = getNative();
        if (app.has('auth.signedOut')) await app.call('auth.signedOut').catch(() => undefined);
        setMe(null);
        setSynced(false);
        setStatus('signedOut');
        window.location.hash = '#/?signedOut=1';
      },
    }),
    [api, me, status, signInMethod, refresh],
  );
  return <PortalContext.Provider value={value}>{maintenance ? <MaintenanceNotice onRetry={() => void refresh()} /> : children}</PortalContext.Provider>;
}

export function usePortal(): PortalContextValue {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error('usePortal must be used inside <PortalProvider>');
  return ctx;
}

/** `#/admin/access?app=club` -> { path: '/admin/access', query: { app: 'club' } } */
export function parseHash(hash: string): { path: string; query: Record<string, string> } {
  const raw = hash.replace(/^#/, '') || '/';
  const i = raw.indexOf('?');
  const path = (i === -1 ? raw : raw.slice(0, i)) || '/';
  const query = i === -1 ? {} : Object.fromEntries(new URLSearchParams(raw.slice(i + 1)));
  return { path, query };
}

/** Only continue to the handshake after sign-in, never to an arbitrary URL. */
export function safeNext(next: string | undefined): string | null {
  return next && next.startsWith('/authorize?') ? next : null;
}

/** Google Identity Services, loaded on demand (from Book Club). */
interface GoogleAccountsId {
  initialize(opts: { client_id: string; callback: (res: { credential: string }) => void; auto_select?: boolean; use_fedcm_for_prompt?: boolean }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
  prompt(): void;
  disableAutoSelect(): void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}
let gsi: Promise<void> | null = null;
export function loadGoogle(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  gsi ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gsi = null;
      reject(new Error('Could not load Google sign-in'));
    };
    document.head.appendChild(s);
  });
  return gsi;
}

export function Badge({ count, label }: { count: number; label: string }) {
  if (!count) return null;
  return (
    <span className="badge" aria-label={`${count} ${label}`}>
      {count}
    </span>
  );
}
