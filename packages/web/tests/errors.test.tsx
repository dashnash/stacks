import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createClient, ErrorBoundary, ErrorNote, installErrorReporting, MAX_ERROR_REPORTS, reportError, StacksProvider, type ErrorReport } from '../src/index';

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const windowError = (error: unknown) => act(() => void window.dispatchEvent(Object.assign(new Event('error'), { error, message: String(error) })));
const rejection = (reason: unknown) => act(() => void window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason })));

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
});

describe('ErrorNote', () => {
  it('shows the ref of a server failure, and nothing extra otherwise', async () => {
    const api = createClient({ fetch: (async () => jsonResponse(500, { error: 'Internal server error', code: 'INTERNAL', ref: '3f9a2c1b' })) as unknown as typeof fetch });
    const err = await api.get('/x').catch((e: unknown) => e as ApiError);
    expect(err).toMatchObject({ status: 500, ref: '3f9a2c1b' });
    const { rerender } = render(<ErrorNote error={err as ApiError} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Internal server error (ref 3f9a2c1b)');
    rerender(<ErrorNote error={new ApiError(400, 'Too long', 'BAD_REQUEST')} />);
    expect(screen.getByRole('alert').textContent).toBe('Too long');
    rerender(<ErrorNote error="Plain text" />);
    expect(screen.getByRole('alert').textContent).toBe('Plain text');
  });
});

describe('installErrorReporting', () => {
  it('reports window errors and unhandled rejections with the page and build', () => {
    const sent: ErrorReport[] = [];
    stop = installErrorReporting((r) => void sent.push(r));
    window.history.replaceState(null, '', '/app?token=secret#/notes/7?tab=x');
    windowError(new TypeError('x is not a function'));
    rejection(new Error('fetch fell over'));
    rejection('a string reason');
    expect(sent).toEqual([
      { message: 'x is not a function', stack: expect.stringContaining('TypeError'), source: 'error', path: '/app#/notes/7', build: 'dev' },
      { message: 'fetch fell over', stack: expect.any(String), source: 'unhandledrejection', path: '/app#/notes/7', build: 'dev' },
      { message: 'a string reason', source: 'unhandledrejection', path: '/app#/notes/7', build: 'dev' },
    ]);
    window.history.replaceState(null, '', '/');
  });

  it('sends the same message once, at most five per page load, and shortens long text', () => {
    const sent: ErrorReport[] = [];
    stop = installErrorReporting((r) => void sent.push(r));
    windowError(new Error('again'));
    windowError(new Error('again'));
    rejection(new Error('again'));
    expect(sent).toHaveLength(1);
    for (let i = 0; i < 10; i++) windowError(new Error(`different ${i}`));
    expect(sent).toHaveLength(MAX_ERROR_REPORTS);
    stop();
    stop = installErrorReporting((r) => void sent.push(r));
    const long = new Error('m'.repeat(900));
    long.stack = 's'.repeat(9000);
    windowError(long);
    expect(sent.at(-1)!.message).toHaveLength(500);
    expect(sent.at(-1)!.stack).toHaveLength(4000);
    windowError(new Error('ResizeObserver loop completed with undelivered notifications.'));
    expect(sent).toHaveLength(MAX_ERROR_REPORTS + 1);
  });

  it('survives a failing post without throwing or reporting that failure', async () => {
    const post = vi.fn(async () => Promise.reject(new Error('network down')));
    const unhandled = vi.fn();
    window.addEventListener('unhandledrejection', unhandled);
    stop = installErrorReporting(post);
    expect(() => windowError(new Error('first'))).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    stop();
    stop = installErrorReporting(() => {
      throw new Error('sync failure');
    });
    expect(() => windowError(new Error('second'))).not.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener('unhandledrejection', unhandled);
  });

  it('only logs to the console in demo mode, and stops when uninstalled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stop = installErrorReporting('console');
    windowError(new Error('demo crash'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('demo'), 'demo crash');
    stop();
    reportError(new Error('by hand, after stop'));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

function Bomb({ armed }: { armed: boolean }): JSX.Element {
  if (armed) throw new Error('render blew up');
  return <p>fine</p>;
}

describe('ErrorBoundary', () => {
  it('reports a render crash and shows a fallback with a reload button', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sent: ErrorReport[] = [];
    stop = installErrorReporting((r) => void sent.push(r));
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload, pathname: '/', hash: '' } });
    render(
      <ErrorBoundary>
        <Bomb armed />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalled();
    // Sent once. (React's development build also raises it as a window error first, so there the
    // one report says "error"; a production build says "render".)
    expect(sent).toEqual([expect.objectContaining({ message: 'render blew up', source: expect.stringMatching(/^(render|error)$/) })]);
  });

  it('takes a custom fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary fallback={<p>custom</p>}>
        <Bomb armed />
      </ErrorBoundary>,
    );
    expect(screen.getByText('custom')).toBeInTheDocument();
  });
});

describe('StacksProvider', () => {
  const setup = (errorReporting?: 'console') => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => (url === '/api/auth/session' ? jsonResponse(401, { error: 'no' }) : new Response(null, { status: 204 })));
    render(
      <StacksProvider client={createClient({ fetch: fetch as unknown as typeof globalThis.fetch })} silentSignIn={false} errorReporting={errorReporting}>
        <Bomb armed={false} />
      </StacksProvider>,
    );
    const posts = () => fetch.mock.calls.filter(([url]) => url === '/api/stacks/client-error');
    return { posts };
  };

  it('turns reporting on with no app code: errors are posted to the app API with the CSRF header', async () => {
    const { posts } = setup();
    await screen.findByText('fine');
    windowError(new Error('caught by the provider'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const init = posts()[0]![1]!;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Stacks-Request']).toBe('1');
    expect(JSON.parse(String(init.body))).toMatchObject({ message: 'caught by the provider', source: 'error', build: 'dev' });
  });

  it('makes no call in demo mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { posts } = setup('console');
    await screen.findByText('fine');
    windowError(new Error('demo only'));
    await new Promise((r) => setTimeout(r, 5));
    expect(posts()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});
