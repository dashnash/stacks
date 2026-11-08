import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient, matchRoute, Modal, RequestAccess, StacksProvider, timeAgo, useStacks, type Navigator } from '../src/index';

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('createClient', () => {
  it('sends the CSRF header and same-origin credentials, and parses JSON', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { ok: 1 }));
    const api = createClient({ fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await api.post('/notes', { text: 'hi' })).toEqual({ ok: 1 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/notes');
    expect(init!.credentials).toBe('same-origin');
    expect((init!.headers as Record<string, string>)['X-Stacks-Request']).toBe('1');
    expect(init!.body).toBe('{"text":"hi"}');
  });

  it('throws ApiError with the server message and calls onUnauthorized on 401', async () => {
    const onUnauthorized = vi.fn();
    const api = createClient({ onUnauthorized, fetch: (async () => jsonResponse(401, { error: 'Sign in required', code: 'UNAUTHORIZED' })) as unknown as typeof fetch });
    await expect(api.get('/x')).rejects.toMatchObject({ status: 401, message: 'Sign in required', code: 'UNAUTHORIZED' });
    await expect(api.get('/x')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalled();
  });
});

function Probe() {
  const { status, session, signIn, signOut } = useStacks();
  return (
    <div>
      <p>status:{status}</p>
      <p>user:{session?.user.name ?? '-'}</p>
      <button onClick={() => signIn()}>in</button>
      <button onClick={() => void signOut()}>out</button>
    </div>
  );
}

function setup(sessionStatus: number) {
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/auth/session') {
      return sessionStatus === 200 ? jsonResponse(200, { user: { email: 'a@b.c', name: 'Ann' }, role: 'MEMBER', canManageAccess: false }) : jsonResponse(401, { error: 'no' });
    }
    if (url === '/api/auth/logout') return jsonResponse(200, { ok: true, platformLogoutUrl: 'https://auth.x/logout' });
    return jsonResponse(404, {});
  });
  const nav: Navigator & { visited: string[] } = { visited: [], assign: (u) => void nav.visited.push(u), current: () => '/#/notes/7' };
  render(
    <StacksProvider client={createClient({ fetch: fetch as unknown as typeof globalThis.fetch })} navigator={nav}>
      <Probe />
    </StacksProvider>,
  );
  return nav;
}

describe('StacksProvider', () => {
  it('loads the session', async () => {
    setup(200);
    expect(await screen.findByText('status:signedIn')).toBeInTheDocument();
    expect(screen.getByText('user:Ann')).toBeInTheDocument();
  });

  it('is signed out on 401 and signs in through the platform, returning to the current page', async () => {
    const nav = setup(401);
    expect(await screen.findByText('status:signedOut')).toBeInTheDocument();
    await userEvent.click(screen.getByText('in'));
    expect(nav.visited).toEqual(['/api/auth/login?return=%2F%23%2Fnotes%2F7']);
  });

  it('signs out of the app and then the platform', async () => {
    const nav = setup(200);
    await screen.findByText('status:signedIn');
    await userEvent.click(screen.getByText('out'));
    await waitFor(() => expect(nav.visited).toEqual(['https://auth.x/logout']));
    expect(screen.getByText('status:signedOut')).toBeInTheDocument();
  });

  it('picks up and removes the access notice from the URL', async () => {
    window.history.replaceState(null, '', '/?stacks_access=access_pending#/x');
    render(
      <StacksProvider client={createClient({ fetch: (async () => jsonResponse(401, {})) as unknown as typeof fetch })}>
        <RequestAccess />
      </StacksProvider>,
    );
    expect(await screen.findByText(/request for access has been sent/)).toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#/x');
  });
});

describe('Modal', () => {
  it('closes on Escape and on the backdrop, not on the panel', async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Edit">
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole('dialog', { name: 'Edit' })).toHaveFocus();
    await userEvent.click(screen.getByText('body'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('helpers', () => {
  it('matchRoute', () => {
    expect(matchRoute('/notes/:id', '/notes/a%20b')).toEqual({ id: 'a b' });
    expect(matchRoute('/notes/:id', '/notes')).toBeNull();
  });
  it('timeAgo', () => {
    const now = new Date('2026-01-10T12:00:00Z');
    expect(timeAgo('2026-01-10T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-01-10T11:00:00Z', now)).toBe('1h ago');
    expect(timeAgo('2026-01-08T12:00:00Z', now)).toBe('2d ago');
  });
});
