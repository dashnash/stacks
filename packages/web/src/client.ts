/** Header the API requires on state-changing calls (CSRF); the client always sends it. */
export const CSRF_HEADER = 'X-Stacks-Request';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly body?: unknown,
    /** On a 500: the short id of the failed request. Show it; the owner finds the trace with it. */
    public readonly ref?: string,
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
  /** How realtime opens its WebSocket (the demo passes an in-browser bus). Defaults to `new WebSocket`. */
  webSocket?: (url: string, protocols: string[]) => SocketLike;
  /** How game rooms open their WebRTC connection (the demo passes an in-browser one). Defaults to `new RTCPeerConnection`. */
  peerConnection?: (config: { iceServers: { urls: string[]; username?: string; credential?: string }[] }) => unknown;
}

/** The part of a WebSocket the realtime hub uses. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type Request = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export interface Session {
  /** `email` only for apps whose manifest has `needsEmail`. */
  user: { id: string; email?: string; name: string; pictureUrl?: string };
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
      const err = data as { error?: string; code?: string; ref?: unknown };
      // API Gateway's own 429 (a route's cap, #102) has no `error` field.
      const fallback = res.status === 429 ? 'Too many requests right now. Wait a moment and try again.' : `Request failed (${res.status})`;
      throw new ApiError(res.status, err.error ?? fallback, err.code, data, typeof err.ref === 'string' ? err.ref : undefined);
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
    /** For game rooms: open a WebRTC peer connection (the real one, or the demo's stand-in). */
    openPeer: (config: { iceServers: { urls: string[]; username?: string; credential?: string }[] }): unknown =>
      opts.peerConnection ? opts.peerConnection(config) : new RTCPeerConnection(config),
    /** For realtime: open its socket (a real WebSocket, or the demo's bus). */
    openSocket: (url: string, protocols: string[]): SocketLike => (opts.webSocket ? opts.webSocket(url, protocols) : (new WebSocket(url, protocols) as unknown as SocketLike)),
  };
}

export type Client = ReturnType<typeof createClient>;
