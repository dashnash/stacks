import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountMenu, createClient, StacksProvider, type Navigator } from '../src/index';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => sessionStorage.clear());

function setup(platformAnswer: Record<string, unknown>) {
  let signedIn = false;
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/auth/session') return signedIn ? json(200, { user: { email: 'ann@x.dev', name: 'Ann' }, role: 'MEMBER', canManageAccess: false }) : json(401, {});
    if (url === '/api/auth/silent-start') return json(200, { url: 'https://auth.x/api/silent-authorize?app=club', state: 's1' });
    if (url === '/api/auth/silent-finish') {
      signedIn = true;
      return json(200, { user: { email: 'ann@x.dev', name: 'Ann' }, role: 'MEMBER', canManageAccess: false });
    }
    if (url === '/api/stacks/account') return json(200, { portalUrl: 'https://auth.x/#/', profileUrl: '', inboxUrl: '', unread: 0, app: { slug: 'club', name: 'Club', roleLabel: 'Member' }, apps: [], manage: null });
    if (url === '/api/auth/logout') return json(200, { ok: true, platformLogoutUrl: 'https://auth.x/logout' });
    return json(404, {});
  });
  const platformFetch = vi.fn(async (_url: string, _init?: RequestInit) => json(200, platformAnswer));
  const nav: Navigator & { visited: string[] } = {
    visited: [],
    assign: (u) => void nav.visited.push(u),
    current: () => '/#/book/42',
    href: () => 'https://club.x/#/book/42',
  };
  render(
    <StacksProvider client={createClient({ fetch: fetch as unknown as typeof globalThis.fetch })} navigator={nav} platformFetch={platformFetch as unknown as typeof globalThis.fetch}>
      <header>
        <AccountMenu />
      </header>
    </StacksProvider>,
  );
  return { nav, calls, platformFetch };
}

describe('silent sign-in', () => {
  it('signs in without a click or a redirect when the platform already has a session', async () => {
    const { nav, calls, platformFetch } = setup({ code: 'stc_1', state: 's1' });
    expect(await screen.findByRole('button', { name: /Account menu for Ann/ })).toBeInTheDocument();
    expect(nav.visited).toEqual([]);
    expect(platformFetch).toHaveBeenCalledWith('https://auth.x/api/silent-authorize?app=club', { credentials: 'include' });
    expect(calls).toContain('POST /api/auth/silent-finish');
    // It never showed "Sign in" in between.
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('shows Sign in when the platform has no session', async () => {
    setup({ error: 'login_required' });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('offers Request access (and files nothing) for a private app the person has no role in', async () => {
    const { nav } = setup({ error: 'access_required' });
    const button = await screen.findByRole('button', { name: 'Request access' });
    expect(nav.visited).toEqual([]);
    await userEvent.click(button);
    // Only the click goes through the platform's authorize, which files the request.
    expect(nav.visited).toEqual(['/api/auth/login?return=%2F%23%2Fbook%2F42']);
  });

  it('shows the pending state when a request is waiting', async () => {
    setup({ error: 'access_pending' });
    expect(await screen.findByRole('button', { name: /Access requested/ })).toBeInTheDocument();
  });

  it('asks the platform at most every 30 seconds', async () => {
    sessionStorage.setItem('stacks.silent.at', String(Date.now()));
    const { platformFetch } = setup({ code: 'stc_1' });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(platformFetch).not.toHaveBeenCalled();
  });
});

describe('sign-out', () => {
  it('signs out of everything and comes back to the same page', async () => {
    const { nav } = setup({ code: 'stc_1', state: 's1' });
    await userEvent.click(await screen.findByRole('button', { name: /Account menu for Ann/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Sign out/ }));
    await waitFor(() => expect(nav.visited).toEqual([`https://auth.x/logout?return=${encodeURIComponent('https://club.x/#/book/42')}`]));
  });
});
