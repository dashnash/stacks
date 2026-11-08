import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Run an async loader on mount (and when `deps` change), with a manual `reload`. Stale results are dropped. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const result = await loaderRef.current();
      if (mine === generation.current) {
        setData(result);
        setError(undefined);
      }
    } catch (err) {
      if (mine === generation.current) setError(err as Error);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload };
}

/**
 * Hash routing, so apps work from any static host and the single-file demo with no server
 * rewrites. Returns the path after `#` (e.g. `/notes/7`) and its segments.
 */
export function useHashRoute(): { path: string; segments: string[] } {
  const [hash, setHash] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash));
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const path = hash.replace(/^#/, '') || '/';
  return { path, segments: path.split(/[?#]/)[0]!.split('/').filter(Boolean).map(decodeURIComponent) };
}

/**
 * Match a hash path against a pattern like `/notes/:id`. Returns the params, or null.
 *
 *   const params = matchRoute('/notes/:id', path); // { id: '7' }
 */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const a = path.split(/[?#]/)[0]!.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) params[p[i]!.slice(1)] = decodeURIComponent(a[i]!);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}
