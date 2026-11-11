import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, useApi, useChannel, type ChannelStatus } from '@stacks/web';
import { LISTS_CHANNEL, listChannel, type GroceryItem, type ListChange, type ListMeta, type ListResponse, type ListSummary } from '../../api/routes';

/** What a write returns, and what a full read returns. */
export interface ListState {
  list: ListMeta;
  items: GroceryItem[];
  muted: boolean;
}

/**
 * Refetch whenever the page comes back into view (focus, or the iOS app returning from the
 * background). There is no interval polling anywhere: hints, resyncs, focus and pull-to-refresh only.
 */
function useOnFocus(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const onFocus = () => ref.current();
    const onVisible = () => document.visibilityState === 'visible' && ref.current();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}

/**
 * One list, kept current: the only place a view meets the realtime channel. Refetches with
 * `?since=<version>` (cheap: `{ unchanged }` when nothing moved) on a `{ version }` hint newer than
 * ours, on every (re)connect, on focus and on `refresh()`. `{ deleted: true }` drops the list.
 * `apply(state)` takes a write's response, so your own changes show without waiting for the hint.
 */
export function useLiveList(listId: string) {
  const api = useApi();
  const [state, setState] = useState<ListState | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const version = useRef<number | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const apply = useCallback((next: { list: ListMeta; items: GroceryItem[]; muted?: boolean }) => {
    // Responses can arrive out of order: never step back to an older version.
    if (version.current !== null && next.list.version < version.current) return;
    version.current = next.list.version;
    setState((prev) => ({ list: next.list, items: next.items, muted: next.muted ?? prev?.muted ?? false }));
  }, []);

  const refresh = useCallback((): Promise<void> => {
    // One fetch at a time; a hint that lands mid-fetch asks for one more afterwards.
    if (inflight.current) {
      again.current = true;
      return inflight.current;
    }
    const run = async () => {
      try {
        const since = version.current === null ? '' : `?since=${version.current}`;
        const res = await api.get<ListResponse>(`/lists/${encodeURIComponent(listId)}${since}`);
        if (!res.unchanged) apply(res);
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setDeleted(true);
        else setError(err as Error);
      }
    };
    inflight.current = run().finally(() => {
      inflight.current = null;
      if (again.current) {
        again.current = false;
        void refresh();
      }
    });
    return inflight.current;
  }, [api, listId, apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { status } = useChannel<ListChange>(
    listChannel(listId),
    (e) => {
      if (e && typeof e === 'object' && 'deleted' in e && e.deleted === true) setDeleted(true);
      else if (e && typeof e === 'object' && 'version' in e && typeof e.version === 'number' && (version.current === null || e.version > version.current)) void refresh();
    },
    { onResync: () => void refresh() },
  );
  useOnFocus(() => void refresh());

  /** Change what's on screen now (e.g. mid-swipe), before the response comes back. */
  const setItems = useCallback((fn: (items: GroceryItem[]) => GroceryItem[]) => setState((s) => (s ? { ...s, items: fn(s.items) } : s)), []);
  const setMuted = useCallback((muted: boolean) => setState((s) => (s ? { ...s, muted } : s)), []);

  return { state, deleted, error, status, refresh, apply, setItems, setMuted };
}

/** The list index, kept current on `lists` hints, resyncs and focus. */
export function useLiveLists() {
  const api = useApi();
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    try {
      setLists((await api.get<{ lists: ListSummary[] }>('/lists')).lists);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const { status } = useChannel<object>(LISTS_CHANNEL, () => void refresh(), { onResync: () => void refresh() });
  useOnFocus(() => void refresh());
  return { lists, error, status: status as ChannelStatus, refresh };
}
