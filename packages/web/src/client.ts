/** Header the API requires on state-changing calls (CSRF); the client always sends it. */
export const CSRF_HEADER = 'X-Stacks-Request';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  /** Defaults to `/api` (same origin as the app). */
  baseUrl?: string;
  /** Called on 401, so the app can show its signed-out view. */
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
}

export type Request = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export interface Session {
  user: { email: string; name: string; pictureUrl?: string };
  role: string;
  canManageAccess: boolean;
}

/**
 * A JSON client for the app's own API. The session travels in an HttpOnly cookie, so there is
 * no token to handle here.
 *
 *   const api = createClient();
 *   const { notes } = await api.request<{ notes: Note[] }>('GET', '/notes');
 */
export function createClient(opts: ClientOptions = {}) {
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = opts.baseUrl ?? '/api';

  const request: Request = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { [CSRF_HEADER]: '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) opts.onUnauthorized?.();
      const err = data as { error?: string; code?: string };
      throw new ApiError(res.status, err.error ?? `Request failed (${res.status})`, err.code, data);
    }
    return data as T;
  };

  return {
    request,
    get: <T = unknown,>(path: string) => request<T>('GET', path),
    post: <T = unknown,>(path: string, body: unknown = {}) => request<T>('POST', path, body),
    patch: <T = unknown,>(path: string, body: unknown) => request<T>('PATCH', path, body),
    put: <T = unknown,>(path: string, body: unknown) => request<T>('PUT', path, body),
    del: <T = unknown,>(path: string) => request<T>('DELETE', path),
    session: () => request<Session>('GET', '/auth/session'),
    logout: () => request<{ ok: true; platformLogoutUrl: string }>('POST', '/auth/logout'),
  };
}

export type Client = ReturnType<typeof createClient>;
