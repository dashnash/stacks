import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroceryItem, ListMeta } from '../api/routes';

/** The channel useLiveList asked for, and how to fire its callbacks (as the realtime hub would). */
const channels = new Map<string, { onEvent: (e: unknown) => void; onResync?: () => void }>();
const get = vi.fn<(path: string) => Promise<unknown>>();

vi.mock('@stacks/web', async (importOriginal) => {
  const real = await importOriginal<typeof import('@stacks/web')>();
  const api = { get: (path: string) => get(path) };
  return {
    ...real,
    useApi: () => api,
    useChannel: (channel: string, onEvent: (e: unknown) => void, opts: { onResync?: () => void; publish?: boolean } = {}) => {
      if (opts.publish) throw new Error('Pantry never publishes from the browser');
      channels.set(channel, { onEvent, onResync: opts.onResync });
      return { status: 'live', publish: async () => undefined };
    },
  };
});

const { useLiveList, useLiveLists } = await import('../web/src/live');

const meta = (version: number): ListMeta => ({ id: 'weekly', name: 'Weekly', version, open: 1, done: 0, createdBy: 'u', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' });
const item = (name: string): GroceryItem => ({ id: name, name, done: false, createdBy: 'u', updatedBy: 'u', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' });

let server: { version: number; items: GroceryItem[]; gone: boolean };
beforeEach(() => {
  channels.clear();
  server = { version: 3, items: [item('Milk')], gone: false };
  get.mockReset();
  get.mockImplementation(async (path: string) => {
    if (path === '/lists') return { lists: [{ ...meta(server.version), muted: false }] };
    if (server.gone) {
      const { ApiError } = await import('@stacks/web');
      throw new ApiError(404, 'That list is gone', 'NOT_FOUND');
    }
    const since = /since=(\d+)/.exec(path)?.[1];
    if (since !== undefined && Number(since) === server.version) return { unchanged: true, version: server.version };
    return { list: meta(server.version), items: server.items, muted: false };
  });
});
afterEach(() => vi.useRealTimers());

describe('useLiveList', () => {
  it('loads, then refetches with ?since on a newer hint and on every resync', async () => {
    const { result } = renderHook(() => useLiveList('weekly'));
    await waitFor(() => expect(result.current.state?.items.map((i) => i.name)).toEqual(['Milk']));
    expect(get).toHaveBeenLastCalledWith('/lists/weekly');
    const ch = channels.get('list/weekly')!;

    server = { ...server, version: 4, items: [item('Milk'), item('Eggs')] };
    await act(async () => ch.onEvent({ version: 4 }));
    await waitFor(() => expect(result.current.state?.items.map((i) => i.name)).toEqual(['Milk', 'Eggs']));
    expect(get).toHaveBeenLastCalledWith('/lists/weekly?since=3');

    // A hint for a version we already have costs nothing.
    const calls = get.mock.calls.length;
    await act(async () => ch.onEvent({ version: 4 }));
    await act(async () => ch.onEvent({ junk: true }));
    expect(get.mock.calls.length).toBe(calls);

    // Reconnect: always ask, cheaply.
    await act(async () => ch.onResync!());
    expect(get).toHaveBeenLastCalledWith('/lists/weekly?since=4');
    expect(await get.mock.results.at(-1)!.value).toEqual({ unchanged: true, version: 4 });
    expect(result.current.state?.list.version).toBe(4);
  });

  it('drops the list on { deleted: true }, and when a refetch finds it gone', async () => {
    const { result } = renderHook(() => useLiveList('weekly'));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    await act(async () => channels.get('list/weekly')!.onEvent({ deleted: true }));
    expect(result.current.deleted).toBe(true);

    const other = renderHook(() => useLiveList('weekly'));
    await waitFor(() => expect(other.result.current.state).not.toBeNull());
    server.gone = true;
    await act(async () => channels.get('list/weekly')!.onResync!());
    await waitFor(() => expect(other.result.current.deleted).toBe(true));
  });

  it('refetches on focus, and never polls on a timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useLiveList('weekly'));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    const calls = get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(get.mock.calls.length).toBe(calls);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(get.mock.calls.length).toBe(calls + 1);
    expect(get).toHaveBeenLastCalledWith('/lists/weekly?since=3');
  });

  it("applies a write's response, but never an older version than it has", async () => {
    const { result } = renderHook(() => useLiveList('weekly'));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    act(() => result.current.apply({ list: meta(5), items: [item('Bread')] }));
    expect(result.current.state?.items.map((i) => i.name)).toEqual(['Bread']);
    act(() => result.current.apply({ list: meta(4), items: [item('Old')] }));
    expect(result.current.state?.items.map((i) => i.name)).toEqual(['Bread']);
  });
});

describe('useLiveLists', () => {
  it('refetches the index on a lists hint and on resync, without polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useLiveLists());
    await waitFor(() => expect(result.current.lists).toHaveLength(1));
    const calls = get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(get.mock.calls.length).toBe(calls);
    await act(async () => channels.get('lists')!.onEvent({}));
    await act(async () => channels.get('lists')!.onResync!());
    expect(get.mock.calls.length).toBe(calls + 2);
  });
});
