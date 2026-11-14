/**
 * The game server's end of the app's AppSync Event API: it listens on its room's channels over
 * the Events WebSocket and publishes over HTTP, both with IAM (SigV4, the task role). Browsers use
 * the same API with tokens from the app; this is the only IAM subscriber.
 */
import { envelope, SERVER_SENDER } from '@stacks/api';
import { signRequest, type AwsCredentials } from '@stacks/api/realtime-aws';
import type { Signaling } from '../room-server';

/** The part of a WebSocket this uses (Node 22's global `WebSocket` by default). */
export interface ServerSocket {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface AppSyncSignalingOptions {
  /** `<id>.appsync-api.<region>.amazonaws.com` */
  httpHost: string;
  /** `<id>.appsync-realtime-api.<region>.amazonaws.com` */
  realtimeHost: string;
  namespace: string;
  region: string;
  /** The task role's credentials (they rotate: asked for on every signature). */
  credentials: () => Promise<AwsCredentials>;
  webSocket?: (url: string, protocols: string[]) => ServerSocket;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (message: string, detail?: unknown) => void;
}

/** The headers AppSync documents for IAM on the Events WebSocket (they are part of the signature). */
const WS_HEADERS = { accept: 'application/json, text/javascript', 'content-encoding': 'amz-1.0', 'content-type': 'application/json; charset=UTF-8' };
const SUBSCRIBE_TIMEOUT_MS = 15_000;
const DEFAULT_KEEPALIVE_MS = 300_000;
const BACKOFF_MAX_MS = 15_000;

const base64url = (text: string) => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomId = () => globalThis.crypto.randomUUID();

interface Sub {
  channel: string;
  onEvent: (data: unknown) => void;
  id: string;
  /** Settles the first `subscribe()` call; later re-subscribes (after a reconnect) have nobody waiting. */
  waiting?: { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };
}

export function appSyncSignaling(opts: AppSyncSignalingOptions): Signaling & { close(): void } {
  const url = `https://${opts.httpHost}/event`;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => undefined);
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const open = opts.webSocket ?? ((u, protocols) => new WebSocket(u, protocols) as unknown as ServerSocket);
  const subs = new Set<Sub>();
  let ws: ServerSocket | null = null;
  let ready = false;
  let closed = false;
  let attempt = 0;
  let connecting: Promise<void> | null = null;
  let keepalive: ReturnType<typeof setTimeout> | undefined;
  let keepaliveMs = DEFAULT_KEEPALIVE_MS;

  /** SigV4 for one WebSocket operation: AppSync checks it as a POST of `body` to the HTTP endpoint. */
  const sign = async (body: string) => {
    const { host: _host, ...signed } = signRequest({ url, body, region: opts.region, service: 'appsync', credentials: await opts.credentials(), now: now(), headers: WS_HEADERS });
    return { ...signed, host: opts.httpHost };
  };

  const send = (msg: unknown) => ws?.send(JSON.stringify(msg));

  const armKeepalive = () => {
    clearTimeout(keepalive);
    if (!ws) return;
    keepalive = setTimeout(() => {
      // No keep-alive for too long: the connection is dead even if the socket doesn't know it.
      log('signaling went silent; reconnecting');
      ws?.close();
    }, keepaliveMs);
    keepalive.unref?.();
  };

  const subscribeNow = async (sub: Sub) => {
    sub.id = randomId();
    const channel = `/${opts.namespace}/${sub.channel}`;
    send({ type: 'subscribe', id: sub.id, channel, authorization: await sign(JSON.stringify({ channel })) });
  };

  const lost = () => {
    clearTimeout(keepalive);
    ws = null;
    ready = false;
    connecting = null;
    if (closed || !subs.size) return;
    const delay = Math.min(BACKOFF_MAX_MS, 500 * 2 ** attempt++) * (0.5 + Math.random() / 2);
    log(`signaling connection lost; retrying in ${Math.round(delay)} ms`);
    const timer = setTimeout(() => void connect().catch((err) => log('signaling reconnect failed', err)), delay);
    timer.unref?.();
  };

  const connect = (): Promise<void> =>
    (connecting ??= (async () => {
      const header = await sign('{}');
      await new Promise<void>((resolve, reject) => {
        const socket = open(`wss://${opts.realtimeHost}/event/realtime`, ['aws-appsync-event-ws', `header-${base64url(JSON.stringify(header))}`]);
        ws = socket;
        let acked = false;
        socket.onopen = () => socket.send(JSON.stringify({ type: 'connection_init' }));
        socket.onerror = () => undefined; // onclose follows
        socket.onclose = () => {
          if (ws !== socket) return;
          if (!acked) reject(new Error('Signaling connection refused'));
          lost();
        };
        socket.onmessage = (ev) => {
          if (ws !== socket) return;
          let msg: { type?: string; id?: string; event?: unknown; connectionTimeoutMs?: number; errors?: unknown };
          try {
            msg = JSON.parse(String(ev.data)) as typeof msg;
          } catch {
            return;
          }
          armKeepalive();
          switch (msg.type) {
            case 'connection_ack':
              acked = true;
              ready = true;
              attempt = 0;
              keepaliveMs = msg.connectionTimeoutMs ?? DEFAULT_KEEPALIVE_MS;
              armKeepalive();
              for (const sub of subs) void subscribeNow(sub).catch((err) => log('re-subscribe failed', err));
              resolve();
              break;
            case 'subscribe_success':
            case 'subscribe_error': {
              const sub = [...subs].find((s) => s.id === msg.id);
              if (!sub?.waiting) {
                if (msg.type === 'subscribe_error') log(`subscribing to ${sub?.channel ?? '?'} was refused`, msg.errors);
                break;
              }
              clearTimeout(sub.waiting.timer);
              if (msg.type === 'subscribe_success') sub.waiting.resolve();
              else sub.waiting.reject(new Error(`Subscribing to ${sub.channel} was refused: ${JSON.stringify(msg.errors ?? '').slice(0, 300)}`));
              delete sub.waiting;
              break;
            }
            case 'data': {
              const sub = [...subs].find((s) => s.id === msg.id);
              if (!sub) break;
              // AppSync documents `event` as a list of JSON strings; it has also been seen as one string.
              for (const raw of Array.isArray(msg.event) ? msg.event : [msg.event]) {
                try {
                  sub.onEvent(typeof raw === 'string' ? JSON.parse(raw) : raw);
                } catch (err) {
                  log('signal handler threw', err);
                }
              }
              break;
            }
            case 'connection_error':
            case 'error':
              log('signaling error', msg.errors);
              if (!acked) socket.close();
              break;
            default:
              // 'ka' (keep-alive) needs nothing more.
              break;
          }
        };
      });
    })().catch((err) => {
      connecting = null;
      throw err;
    }));

  return {
    async subscribe(channel, onEvent) {
      const sub: Sub = { channel, onEvent, id: '' };
      const live = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Subscribing to ${channel} timed out`)), SUBSCRIBE_TIMEOUT_MS);
        sub.waiting = { resolve, reject, timer };
      });
      const wasReady = ready;
      subs.add(sub);
      try {
        // A fresh connection subscribes everything in `subs` when it is acknowledged.
        await connect();
        if (wasReady) await subscribeNow(sub);
        await live;
      } catch (err) {
        clearTimeout(sub.waiting?.timer);
        subs.delete(sub);
        throw err;
      }
      return () => {
        subs.delete(sub);
        if (ready && sub.id) send({ type: 'unsubscribe', id: sub.id });
      };
    },

    async publish(channel, data) {
      const body = JSON.stringify({ channel: `/${opts.namespace}/${channel}`, events: [envelope(data, SERVER_SENDER)] });
      const headers = signRequest({ url, body, region: opts.region, service: 'appsync', credentials: await opts.credentials(), now: now() });
      const res = await doFetch(url, { method: 'POST', headers, body });
      const answer = (await res.json().catch(() => ({}))) as { failed?: unknown[]; errors?: unknown[] };
      if (!res.ok || answer.failed?.length || answer.errors?.length) {
        throw new Error(`Publish to ${channel} failed (${res.status}): ${JSON.stringify(answer).slice(0, 300)}`);
      }
    },

    close() {
      closed = true;
      clearTimeout(keepalive);
      const socket = ws;
      ws = null;
      socket?.close();
    },
  };
}
