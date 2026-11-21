import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, PREWARM_POLL_MS, StacksProvider, usePrewarmRoom, type Client, type SocketLike } from '../src/index';

function Title({ on }: { on: boolean }) {
  usePrewarmRoom(on);
  return <p>title</p>;
}
function Status({ on }: { on: boolean }) {
  const w = usePrewarmRoom(on);
  return <p data-testid="status">{[w.status, w.roomId].filter(Boolean).join(' ')}</p>;
}

const session = { user: { id: 'u_ann', name: 'Ann' }, role: 'MEMBER', canManageAccess: false };
function client(post: (path: string) => Promise<unknown>, signedIn = true) {
  return {
    session: async () => {
      if (!signedIn) throw new ApiError(401, 'Sign in required', 'UNAUTHORIZED');
      return session;
    },
    get: vi.fn(async () => ({})),
    post: vi.fn(post),
    openSocket: () => ({}) as SocketLike,
    openPeer: vi.fn(),
  } as unknown as Client;
}
const hide = (state: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

afterEach(() => {
  vi.useRealTimers();
  hide('visible');
});

describe('usePrewarmRoom', () => {
  it('warms once when enabled, again only when the tab comes back after the warm room expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-21T10:00:00Z'));
    const api = client(async () => ({ room: { id: 'r1', warm: true, warmUntil: '2026-11-21T10:05:00Z' } }));
    const view = render(
      <StacksProvider client={api} silentSignIn={false}>
        <Title on={false} />
      </StacksProvider>,
    );
    await act(async () => undefined);
    expect(api.post).not.toHaveBeenCalled();
    view.rerender(
      <StacksProvider client={api} silentSignIn={false}>
        <Title on />
      </StacksProvider>,
    );
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/rooms/warm', {}));
    // Back to the tab within the 5 minutes: nothing new.
    hide('hidden');
    vi.setSystemTime(Date.parse('2026-11-21T10:04:00Z'));
    await act(async () => hide('visible'));
    expect(api.post).toHaveBeenCalledTimes(1);
    // Back after it expired: warm again.
    hide('hidden');
    vi.setSystemTime(Date.parse('2026-11-21T10:06:00Z'));
    await act(async () => hide('visible'));
    expect(api.post).toHaveBeenCalledTimes(2);
    // Off during a game (Play took the warm room), on again back at the title: the next one warms at once.
    for (const on of [false, true])
      view.rerender(
        <StacksProvider client={api} silentSignIn={false}>
          <Title on={on} />
        </StacksProvider>,
      );
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3));
  });

  it('warms the next one when it expires with the player still active, not in a forgotten tab', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const api = client(async () => ({ room: { id: 'r1', warm: true, warmUntil: new Date(Date.now() + 300_000).toISOString() } }));
    render(
      <StacksProvider client={api} silentSignIn={false}>
        <Title on />
      </StacksProvider>,
    );
    for (let i = 0; i < 10 && !(api.post as ReturnType<typeof vi.fn>).mock.calls.length; i++) await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(api.post).toHaveBeenCalledTimes(1);
    // Untouched for the whole 5 minutes: nothing more.
    await act(async () => vi.advanceTimersByTimeAsync(302_000));
    expect(api.post).toHaveBeenCalledTimes(1);
    // A tab return warms again; then a key press before it runs out keeps it going.
    hide('hidden');
    await act(async () => hide('visible'));
    expect(api.post).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await act(async () => vi.advanceTimersByTimeAsync(242_000));
    expect(api.post).toHaveBeenCalledTimes(3);
  });

  it('tries again a minute after a refusal while the tab is visible, and reports busy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let refuse = true;
    const api = client(async () => {
      if (refuse) throw new ApiError(429, 'Too many games running, try again soon', 'TOO_MANY_GAMES');
      return { room: { id: 'r1', status: 'open', warm: true, warmUntil: new Date(Date.now() + 300_000).toISOString() } };
    });
    const view = render(
      <StacksProvider client={api} silentSignIn={false}>
        <Status on />
      </StacksProvider>,
    );
    for (let i = 0; i < 10 && !(api.post as ReturnType<typeof vi.fn>).mock.calls.length; i++) await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(api.post).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(view.getByTestId('status').textContent).toBe('busy');
    // Hidden: no retry until it's back.
    hide('hidden');
    await act(async () => vi.advanceTimersByTimeAsync(61_000));
    expect(api.post).toHaveBeenCalledTimes(1);
    await act(async () => hide('visible'));
    expect(api.post).toHaveBeenCalledTimes(2);
    // Visible and untouched: still retried a minute later; this time it's ready.
    refuse = false;
    await act(async () => vi.advanceTimersByTimeAsync(61_000));
    expect(api.post).toHaveBeenCalledTimes(3);
    expect(view.getByTestId('status').textContent).toBe('ready r1');
  });

  it('reports warming while the server starts, ready once it is open, idle once Play would no longer take it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let status = 'starting';
    const api = client(async () => ({ room: { id: 'r1', status: 'starting', warm: true }, leftMs: 300_000 }));
    (api.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      expect(path).toBe('/rooms/r1');
      return { room: { id: 'r1', status } };
    });
    const view = render(
      <StacksProvider client={api} silentSignIn={false}>
        <Status on />
      </StacksProvider>,
    );
    const text = () => view.getByTestId('status').textContent;
    for (let i = 0; i < 10 && text() !== 'warming r1'; i++) await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(text()).toBe('warming r1');
    await act(async () => vi.advanceTimersByTimeAsync(PREWARM_POLL_MS));
    expect(text()).toBe('warming r1');
    status = 'open';
    await act(async () => vi.advanceTimersByTimeAsync(PREWARM_POLL_MS));
    expect(text()).toBe('ready r1');
    // Nobody about: no re-warm, and 30 s before it ends Play would start fresh, so it's not ready any more.
    await act(async () => vi.advanceTimersByTimeAsync(300_000 - 30_000 - 2 * PREWARM_POLL_MS - 100));
    expect(text()).toBe('ready r1');
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(text()).toBe('idle');
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('is quiet when refused, and does nothing signed out', async () => {
    const refused = client(async () => {
      throw new ApiError(429, 'Too many games running, try again soon', 'TOO_MANY_GAMES');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(
      <StacksProvider client={refused} silentSignIn={false}>
        <Title on />
      </StacksProvider>,
    );
    await waitFor(() => expect(refused.post).toHaveBeenCalledTimes(1));
    expect(view.getByText('title')).toBeInTheDocument();
    view.unmount();
    const out = client(async () => ({}), false);
    render(
      <StacksProvider client={out} silentSignIn={false}>
        <Title on />
      </StacksProvider>,
    );
    await act(async () => undefined);
    expect(out.post).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
