/**
 * Realtime in the browser (manifest module `realtime`): one shared AppSync Events WebSocket per
 * tab, carrying every `useChannel` on the page. Tokens come from the app's `POST /api/realtime/token`
 * (for exactly the channels in use) and are refreshed before they expire. The socket reconnects
 * with jittered backoff, closes while the page has been hidden for 30 s (an iOS app in the
 * background too) and reconnects when it is visible again. Every (re)connect fires `onResync`, so
 * apps refetch whatever they may have missed: delivery is at most once.
 */
import { ApiError, type Client, type SocketLike } from './client';

export type ChannelStatus = 'connecting' | 'live' | 'offline';

/** Largest event (its JSON envelope, in UTF-8 bytes); the server enforces the same. */
export const MAX_EVENT_BYTES = 4096;
/** Fetch a new token this long before the current one expires. */
export const REFRESH_BEFORE_MS = 60_000;
/** Close the socket once the page has been hidden this long. */
export const HIDDEN_DISCONNECT_MS = 30_000;
/** Reconnect delays: 1 s doubling to 30 s, each scaled by a random 50-100 %. */
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
const DEFAULT_KEEPALIVE_MS = 300_000;

interface Token {
  token: string;
  expiresAt: number;
  endpoint: string;
  host: string;
  namespace: string;
  subscribe: Set<string>;
  publish: Set<string>;
}

export interface Subscription {
  channel: string;
  /** May publish on the channel (the token asks for it). */
  publish: boolean;
  /** Also deliver this tab's own publishes. */
  echo: boolean;
  /**
   * `false`: publish only, never subscribe (for channels whose guard lets you publish but not
   * listen, like a game room's `to-server`). Its status is `live` once it can publish.
   */
  listen?: boolean;
  onEvent(data: unknown): void;
  onResync?(): void;
  onStatus(status: ChannelStatus): void;
}

type HubState = 'idle' | 'authorizing' | 'connecting' | 'open' | 'waiting' | 'hidden' | 'failed';

const randomId = () => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
};
const base64url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The wire envelope (`{ d, f, i }`: data, sender tag, event id), checked against the 4 KB limit. */
export function encodeEvent(data: unknown, from: string): string {
  if (data === undefined) throw new Error('Realtime events need data (use null for "something changed")');
  const json = JSON.stringify({ d: data, f: from, i: randomId() });
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_EVENT_BYTES) throw new Error(`Realtime event is ${bytes} bytes; the limit is ${MAX_EVENT_BYTES}`);
  return json;
}

/**
 * The tab's one realtime connection. `useChannel` is the way in; use the hub directly only
 * outside React.
 */
export class RealtimeHub {
  /** This tab's sender tag (its own publishes come back with it, and are dropped). */
  readonly tag = randomId();
  private readonly subs = new Set<Subscription>();
  private state: HubState = 'idle';
  private token: Token | null = null;
  private ws: SocketLike | null = null;
  /** Server subscription id per channel, and the channels whose subscription is confirmed. */
  private serverSubs = new Map<string, string>();
  private live = new Set<string>();
  private refused = new Set<string>();
  /** Old subscription ids to drop once their replacement (after a token refresh) is confirmed. */
  private replacing = new Map<string, string>();
  private publishes = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
  private recent: string[] = [];
  private attempt = 0;
  private failedKey: string | null = null;
  private who: string | null = null;
  private generation = 0;
  private syncQueued = false;
  private timers: Record<'refresh' | 'retry' | 'hidden' | 'keepalive', ReturnType<typeof setTimeout> | undefined> = {
    refresh: undefined,
    retry: undefined,
    hidden: undefined,
    keepalive: undefined,
  };
  private keepaliveMs = DEFAULT_KEEPALIVE_MS;
  private visibilityBound = false;

  constructor(
    private readonly api: Client,
    private readonly opts: { random?: () => number; document?: Document } = {},
  ) {}

  /** Start receiving a channel; returns the unsubscribe. `who` (user id + role) resets auth when it changes. */
  add(sub: Subscription, who: string): () => void {
    if (who !== this.who) {
      this.who = who;
      this.generation++;
      this.token = null;
      this.failedKey = null;
      this.closeSocket();
      if (this.state !== 'hidden') this.state = 'idle';
    }
    this.subs.add(sub);
    this.bindVisibility();
    this.queueSync();
    sub.onStatus(this.statusOf(sub));
    return () => {
      this.subs.delete(sub);
      this.queueSync();
    };
  }

  /** Publish on a channel this tab holds with `publish: true`. Resolves when AppSync accepts it. */
  async publish(channel: string, data: unknown): Promise<void> {
    const event = encodeEvent(data, this.tag);
    if (![...this.subs].some((s) => s.channel === channel && s.publish)) throw new Error(`Open "${channel}" with { publish: true } to publish on it`);
    const token = this.token;
    if (this.state !== 'open' || !this.ws || !token?.publish.has(channel)) throw new Error('Not connected; try again when the channel is live');
    const id = randomId();
    const done = new Promise<void>((resolve, reject) => this.publishes.set(id, { resolve, reject }));
    this.send({ type: 'publish', id, channel: this.full(channel, token), events: [event], authorization: this.auth(token) });
    return done;
  }

  // --- the desired state ----------------------------------------------------------------------

  private wanted() {
    const subscribe = new Set<string>();
    const publish = new Set<string>();
    for (const s of this.subs) {
      if (s.listen !== false) subscribe.add(s.channel);
      if (s.publish) publish.add(s.channel);
    }
    return { subscribe, publish, key: `${[...subscribe].sort().join(',')}|${[...publish].sort().join(',')}` };
  }

  private queueSync(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      void this.sync();
    });
  }

  private async sync(): Promise<void> {
    const want = this.wanted();
    if (!want.subscribe.size && !want.publish.size) {
      this.closeSocket();
      this.clearTimer('refresh');
      this.clearTimer('retry');
      this.state = this.state === 'hidden' ? 'hidden' : 'idle';
      return;
    }
    if (this.state === 'hidden' || this.state === 'waiting' || this.state === 'authorizing') return;
    if (this.state === 'failed' && this.failedKey === want.key) return;

    const covers = (t: Token | null) =>
      !!t && t.expiresAt - REFRESH_BEFORE_MS > Date.now() && [...want.subscribe].every((c) => t.subscribe.has(c)) && [...want.publish].every((c) => t.publish.has(c));
    if (!covers(this.token)) {
      if (!(await this.authorize(want))) return;
    }
    if (!this.ws) {
      this.connect();
      return;
    }
    if (this.state === 'open') this.reconcile();
  }

  /** Fetch a token for exactly the wanted channels. False when it didn't work (state says why). */
  private async authorize(want: ReturnType<RealtimeHub['wanted']>): Promise<boolean> {
    const gen = ++this.generation;
    const previous = this.state;
    this.state = 'authorizing';
    this.emitStatus();
    try {
      const res = await this.api.post<{ token: string; expiresAt: string; endpoint: string; host: string; namespace: string }>('/realtime/token', {
        subscribe: [...want.subscribe],
        publish: [...want.publish],
      });
      if (gen !== this.generation) return false;
      this.token = { ...res, expiresAt: Date.parse(res.expiresAt), subscribe: new Set(want.subscribe), publish: new Set(want.publish) };
      this.failedKey = null;
      this.state = this.ws && (previous === 'open' || previous === 'connecting') ? previous : 'idle';
      this.scheduleRefresh();
      // Channels may have changed while the token was on its way.
      if (this.wanted().key !== want.key) this.queueSync();
      return true;
    } catch (err) {
      if (gen !== this.generation) return false;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        // Signed out, or a channel was refused: nothing to retry until the channels change.
        console.error('Realtime: no token', err.message);
        this.failedKey = want.key;
        this.state = 'failed';
        this.closeSocket();
      } else {
        this.state = 'waiting';
        this.closeSocket();
        this.scheduleRetry();
      }
      this.emitStatus();
      return false;
    }
  }

  // --- the socket -------------------------------------------------------------------------------

  private connect(): void {
    const token = this.token!;
    this.state = 'connecting';
    this.emitStatus();
    const protocols = ['aws-appsync-event-ws', `header-${base64url(JSON.stringify(this.auth(token)))}`];
    const ws = this.api.openSocket(token.endpoint, protocols);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws === ws) this.send({ type: 'connection_init' });
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(String(ev.data));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.lost();
    };
    ws.onerror = () => {
      // onclose follows.
    };
  }

  private onMessage(raw: string): void {
    let msg: { type?: string; id?: string; event?: unknown; connectionTimeoutMs?: number; errors?: unknown };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    this.armKeepalive();
    switch (msg.type) {
      case 'connection_ack':
        this.keepaliveMs = msg.connectionTimeoutMs ?? DEFAULT_KEEPALIVE_MS;
        this.armKeepalive();
        this.state = 'open';
        this.attempt = 0;
        this.reconcile();
        // Anything may have happened while we weren't listening.
        for (const s of this.subs) s.onResync?.();
        break;
      case 'subscribe_success': {
        const channel = this.channelFor(msg.id);
        if (channel) {
          this.live.add(channel);
          const old = this.replacing.get(channel);
          if (old) {
            this.replacing.delete(channel);
            this.send({ type: 'unsubscribe', id: old });
          }
          this.emitStatus();
        }
        break;
      }
      case 'subscribe_error': {
        const channel = this.channelFor(msg.id);
        if (channel) {
          console.error(`Realtime: subscribing to "${channel}" was refused`, msg.errors);
          this.serverSubs.delete(channel);
          this.refused.add(channel);
          this.emitStatus();
        }
        break;
      }
      case 'data':
        this.deliver(msg.id, msg.event);
        break;
      case 'publish_success':
      case 'publish_error': {
        const pending = msg.id ? this.publishes.get(msg.id) : undefined;
        if (!pending) break;
        this.publishes.delete(msg.id!);
        const failed = (msg as { failed?: unknown[] }).failed;
        if (msg.type === 'publish_error' || failed?.length) pending.reject(new Error('Realtime publish was refused'));
        else pending.resolve();
        break;
      }
      case 'connection_error':
      case 'error':
        console.error('Realtime error', msg.errors);
        if (this.state !== 'open') this.ws?.close();
        break;
      default:
        // 'ka' (keep-alive) and acknowledgements need nothing more.
        break;
    }
  }

  private deliver(subId: string | undefined, raw: unknown): void {
    const channel = this.channelFor(subId) ?? [...this.replacing].find(([, old]) => old === subId)?.[0];
    if (!channel) return;
    // AppSync documents `event` as a list of JSON strings; it has also been seen as one string.
    for (const one of Array.isArray(raw) ? raw : [raw]) this.deliverOne(channel, one);
  }

  private deliverOne(channel: string, raw: unknown): void {
    let env: { d?: unknown; f?: string; i?: string };
    try {
      env = (typeof raw === 'string' ? JSON.parse(raw) : raw) as typeof env;
    } catch {
      return;
    }
    if (!env || typeof env !== 'object' || !('d' in env)) return;
    // The same event can arrive twice while a subscription is being replaced.
    if (env.i) {
      const key = `${channel}#${env.i}`;
      if (this.recent.includes(key)) return;
      this.recent.push(key);
      if (this.recent.length > 200) this.recent.shift();
    }
    for (const s of [...this.subs]) {
      if (s.channel !== channel) continue;
      if (!s.echo && env.f === this.tag) continue;
      try {
        s.onEvent(env.d);
      } catch (err) {
        console.error(`Realtime: a "${channel}" handler threw`, err);
      }
    }
  }

  /** Subscribe to wanted channels we aren't on yet; drop the ones nobody wants. */
  private reconcile(): void {
    const token = this.token;
    if (!token || this.state !== 'open') return;
    const want = this.wanted();
    for (const channel of want.subscribe) {
      if (this.serverSubs.has(channel) || this.refused.has(channel) || !token.subscribe.has(channel)) continue;
      this.subscribe(channel, token);
    }
    for (const [channel, id] of this.serverSubs) {
      if (want.subscribe.has(channel)) continue;
      this.send({ type: 'unsubscribe', id });
      this.serverSubs.delete(channel);
      this.live.delete(channel);
    }
    this.emitStatus();
  }

  private subscribe(channel: string, token: Token): void {
    const id = randomId();
    this.serverSubs.set(channel, id);
    this.send({ type: 'subscribe', id, channel: this.full(channel, token), authorization: this.auth(token) });
  }

  /** The connection dropped (or went silent): back off and try again. */
  private lost(): void {
    this.dropSocketState();
    this.ws = null;
    if (this.state === 'hidden' || !this.subs.size) return;
    this.state = 'waiting';
    this.scheduleRetry();
    this.emitStatus();
  }

  private dropSocketState(): void {
    this.serverSubs.clear();
    this.live.clear();
    this.refused.clear();
    this.replacing.clear();
    this.clearTimer('keepalive');
    for (const p of this.publishes.values()) p.reject(new Error('Realtime connection closed'));
    this.publishes.clear();
  }

  private closeSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    this.dropSocketState();
    ws.onclose = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  // --- timers -----------------------------------------------------------------------------------

  private clearTimer(name: keyof RealtimeHub['timers']): void {
    if (this.timers[name] !== undefined) clearTimeout(this.timers[name]);
    this.timers[name] = undefined;
  }

  private scheduleRetry(): void {
    this.clearTimer('retry');
    const random = this.opts.random ?? Math.random;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt) * (0.5 + random() / 2);
    this.attempt++;
    this.timers.retry = setTimeout(() => {
      this.timers.retry = undefined;
      if (this.state === 'waiting') this.state = 'idle';
      void this.sync();
    }, delay);
  }

  private scheduleRefresh(): void {
    this.clearTimer('refresh');
    const token = this.token;
    if (!token) return;
    const delay = Math.max(0, token.expiresAt - REFRESH_BEFORE_MS - Date.now());
    this.timers.refresh = setTimeout(() => void this.refresh(), delay);
  }

  /** A fresh token, then every subscription again under it (the old one is dropped once the new is confirmed). */
  private async refresh(): Promise<void> {
    this.timers.refresh = undefined;
    if (!this.subs.size || this.state === 'hidden') return;
    const want = this.wanted();
    if (!(await this.authorize(want))) return;
    const token = this.token!;
    if (this.state !== 'open' || !this.ws) {
      void this.sync();
      return;
    }
    for (const [channel, oldId] of [...this.serverSubs]) {
      if (!want.subscribe.has(channel)) continue;
      this.replacing.set(channel, oldId);
      this.subscribe(channel, token);
    }
    this.reconcile();
  }

  private armKeepalive(): void {
    this.clearTimer('keepalive');
    if (!this.ws) return;
    this.timers.keepalive = setTimeout(() => {
      // No keep-alive for too long: the connection is dead even if the socket doesn't know it.
      const ws = this.ws;
      this.closeSocket();
      if (ws) this.lost();
    }, this.keepaliveMs);
  }

  private bindVisibility(): void {
    const doc = this.opts.document ?? (typeof document === 'undefined' ? undefined : document);
    if (this.visibilityBound || !doc) return;
    this.visibilityBound = true;
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') {
        this.clearTimer('hidden');
        this.timers.hidden = setTimeout(() => {
          this.timers.hidden = undefined;
          this.state = 'hidden';
          this.clearTimer('retry');
          this.closeSocket();
          this.emitStatus();
        }, HIDDEN_DISCONNECT_MS);
      } else {
        this.clearTimer('hidden');
        if (this.state === 'hidden') {
          this.state = 'idle';
          this.attempt = 0;
          void this.sync();
        }
      }
    });
  }

  // --- helpers ------------------------------------------------------------------------------------

  private statusOf(sub: Subscription): ChannelStatus {
    const channel = sub.channel;
    if (sub.listen === false) {
      // Publish only: live as soon as the connection is up with a token that covers it.
      if (this.state === 'open') return this.token?.publish.has(channel) ? 'live' : 'connecting';
    } else if (this.refused.has(channel)) return 'offline';
    switch (this.state) {
      case 'open':
        return this.live.has(channel) ? 'live' : 'connecting';
      case 'idle':
      case 'authorizing':
      case 'connecting':
        return 'connecting';
      default:
        return 'offline';
    }
  }

  private emitStatus(): void {
    for (const s of [...this.subs]) s.onStatus(this.statusOf(s));
  }

  private channelFor(id: string | undefined): string | undefined {
    if (!id) return undefined;
    for (const [channel, subId] of this.serverSubs) if (subId === id) return channel;
    return undefined;
  }

  private full(channel: string, token: Token): string {
    return `/${token.namespace}/${channel}`;
  }

  private auth(token: Token): Record<string, string> {
    return { host: token.host, Authorization: token.token };
  }

  private send(msg: unknown): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch (err) {
      console.error('Realtime: send failed', err);
    }
  }
}

const hubs = new WeakMap<Client, RealtimeHub>();

/** The tab's hub for an API client (one per `<StacksProvider>`). */
export function realtimeHub(api: Client): RealtimeHub {
  let hub = hubs.get(api);
  if (!hub) hubs.set(api, (hub = new RealtimeHub(api)));
  return hub;
}
