/**
 * Realtime in the demo: an in-browser stand-in for the app's AppSync Event API. It speaks the same
 * WebSocket protocol, so the web SDK's `useChannel` runs unchanged, and it checks every connect,
 * subscribe and publish with the real authorizer logic against tokens from the app's real token
 * route (so channel guards still apply). Events also cross to other demo tabs of the same app
 * over a `BroadcastChannel`, so two personas side by side see each other live.
 */
import { authorizeRealtime, envelope, eventsOf, isChannelName, MAX_EVENT_BYTES, randomToken, REALTIME_NAMESPACE, SERVER_SENDER, type Realtime, type RealtimeConnection } from '@stacks/api';
import type { SocketLike } from '@stacks/web';

interface Wire {
  channel: string;
  event: string;
  tab: string;
}

export class DemoRealtimeBus implements Realtime {
  /** Signs tokens in this tab; other tabs only ever see events, never tokens. */
  private readonly key = randomToken('demo-key-');
  private readonly tab = randomToken();
  private readonly sockets = new Set<DemoSocket>();
  private readonly broadcast: BroadcastChannel | null;
  private closed = false;

  constructor(
    slug: string,
    /** Called before an event from another tab is delivered (the demo reloads its shared data). */
    private readonly onRemote: () => void = () => undefined,
  ) {
    this.broadcast = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`stacks-demo-realtime:${slug}`);
    if (this.broadcast)
      this.broadcast.onmessage = (m: MessageEvent<Wire>) => {
        if (!m.data || m.data.tab === this.tab) return;
        this.onRemote();
        this.local(m.data.channel, m.data.event);
      };
  }

  /** The server side (`deps.realtime.publish`). */
  async publish(channel: string, data: unknown): Promise<void> {
    if (!isChannelName(channel)) throw new Error(`"${channel}" is not a channel name`);
    const events = eventsOf(data).map((d) => envelope(d, SERVER_SENDER));
    for (const e of events) this.send(`/${REALTIME_NAMESPACE}/${channel}`, e);
  }

  async connection(): Promise<RealtimeConnection> {
    return { key: this.key, endpoint: 'demo:realtime', host: 'realtime.demo.local', namespace: REALTIME_NAMESPACE };
  }

  /** For `createClient({ webSocket })`: a socket onto this bus. */
  open = (_url: string, protocols: string[]): SocketLike => {
    const header = protocols.find((p) => p.startsWith('header-'));
    let token = '';
    try {
      token = (JSON.parse(atob(header!.slice('header-'.length).replace(/-/g, '+').replace(/_/g, '/'))) as { Authorization?: string }).Authorization ?? '';
    } catch {
      // no header: connect is refused below
    }
    const socket = new DemoSocket(this, token);
    this.sockets.add(socket);
    return socket;
  };

  /** Stop listening to other tabs (tests). */
  close(): void {
    this.closed = true;
    this.broadcast?.close();
    for (const s of this.sockets) s.close();
  }

  /** Deliver here and in the other tabs. */
  send(channel: string, event: string): void {
    this.local(channel, event);
    // After the current task, so the route that published has saved its data for the other tab to read.
    // Skipped if the bus closed meanwhile: posting on a closed channel throws.
    setTimeout(() => !this.closed && this.broadcast?.postMessage({ channel, event, tab: this.tab } satisfies Wire), 0);
  }

  private local(channel: string, event: string): void {
    for (const s of this.sockets) s.deliver(channel, event);
  }

  authorize(token: string, operation: string, channel?: string): Promise<boolean> {
    return authorizeRealtime({ authorizationToken: token, requestContext: { operation, ...(channel ? { channel } : {}) } }, this.key, Date.now()).then((r) => r.isAuthorized);
  }

  forget(socket: DemoSocket): void {
    this.sockets.delete(socket);
  }
}

class DemoSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  private readonly subs = new Map<string, string>();
  private closed = false;
  /** The message being handled; the next one waits for it. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly bus: DemoRealtimeBus,
    private readonly token: string,
  ) {
    setTimeout(() => !this.closed && this.onopen?.({}), 0);
  }

  send(raw: string): void {
    const msg = JSON.parse(raw) as { type: string; id?: string; channel?: string; events?: string[]; authorization?: { Authorization?: string } };
    // One message at a time, in the order sent: each awaits an async authorize (WebCrypto), so
    // handling them concurrently let a later message's reply overtake an earlier one's.
    // A failure doesn't stall the socket, and still surfaces as an unhandled rejection, as before.
    this.queue = this.queue.then(() => this.handle(msg)).catch((e: unknown) => void Promise.reject(e));
  }

  private async handle(msg: { type: string; id?: string; channel?: string; events?: string[]; authorization?: { Authorization?: string } }) {
    const token = msg.authorization?.Authorization ?? '';
    switch (msg.type) {
      case 'connection_init':
        if (await this.bus.authorize(this.token, 'EVENT_CONNECT')) this.reply({ type: 'connection_ack', connectionTimeoutMs: 300_000 });
        else {
          this.reply({ type: 'connection_error', errors: [{ errorType: 'UnauthorizedException' }] });
          setTimeout(() => this.close(), 0);
        }
        break;
      case 'subscribe':
        if (await this.bus.authorize(token, 'EVENT_SUBSCRIBE', msg.channel)) {
          this.subs.set(msg.id!, msg.channel!);
          this.reply({ type: 'subscribe_success', id: msg.id });
        } else this.reply({ type: 'subscribe_error', id: msg.id, errors: [{ errorType: 'UnauthorizedException' }] });
        break;
      case 'unsubscribe':
        this.subs.delete(msg.id!);
        this.reply({ type: 'unsubscribe_success', id: msg.id });
        break;
      case 'publish': {
        const events = msg.events ?? [];
        // Like the Event API's onPublish handler: nothing over 4 KB goes out.
        const ok = (await this.bus.authorize(token, 'EVENT_PUBLISH', msg.channel)) && events.every((e) => new TextEncoder().encode(e).length <= MAX_EVENT_BYTES);
        if (!ok) {
          this.reply({ type: 'publish_error', id: msg.id, errors: [{ errorType: 'UnauthorizedException' }] });
          break;
        }
        this.reply({ type: 'publish_success', id: msg.id, successful: events.map((_, index) => ({ identifier: `${msg.id}-${index}`, index })), failed: [] });
        for (const e of events) this.bus.send(msg.channel!, e);
        break;
      }
      default:
        break;
    }
  }

  deliver(channel: string, event: string): void {
    // As AppSync documents it: `event` is a list of JSON strings.
    for (const [id, c] of this.subs) if (c === channel) this.reply({ type: 'data', id, event: [event] });
  }

  private reply(msg: unknown): void {
    setTimeout(() => !this.closed && this.onmessage?.({ data: JSON.stringify(msg) }), 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.bus.forget(this);
    this.onclose?.({});
  }
}
