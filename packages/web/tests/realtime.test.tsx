import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { createClient, RealtimeHub, StacksProvider, useChannel, type ChannelStatus, type Client, type SocketLike } from '../src/index';

/** A fake AppSync Events server: one per test, every socket the hub opens connects to it. */
class FakeAppSync {
  sockets: FakeSocket[] = [];
  /** Answer the protocol automatically (ack, subscribe_success, publish → data to subscribers). */
  auto = true;
  get last(): FakeSocket {
    return this.sockets.at(-1)!;
  }
  open = (url: string, protocols: string[]): SocketLike => {
    const s = new FakeSocket(this, url, protocols);
    this.sockets.push(s);
    queueMicrotask(() => s.onopen?.({}));
    return s;
  };
  /** Let time pass with AppSync's keep-alives arriving every minute. */
  async pass(ms: number) {
    for (let t = 0; t < ms; t += 60_000) {
      for (const s of this.sockets) if (!s.closed) s.reply({ type: 'ka' });
      await vi.advanceTimersByTimeAsync(Math.min(60_000, ms - t));
    }
  }
  /** Someone else (another tab, the server) publishes. */
  broadcast(channel: string, data: unknown, from = 'server') {
    for (const s of this.sockets) if (!s.closed) s.deliver(channel, JSON.stringify({ d: data, f: from, i: Math.random().toString(36) }));
  }
}

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  sent: any[] = [];
  closed = false;
  subs = new Map<string, string>(); // id -> channel
  constructor(
    private readonly server: FakeAppSync,
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(raw: string) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    if (!this.server.auto) return;
    if (msg.type === 'connection_init') this.reply({ type: 'connection_ack', connectionTimeoutMs: 300_000 });
    if (msg.type === 'subscribe') {
      this.subs.set(msg.id, msg.channel);
      this.reply({ type: 'subscribe_success', id: msg.id });
    }
    if (msg.type === 'unsubscribe') this.subs.delete(msg.id);
    if (msg.type === 'publish') {
      this.reply({ type: 'publish_success', id: msg.id, successful: [{ identifier: 'x', index: 0 }], failed: [] });
      for (const s of this.server.sockets) if (!s.closed) for (const e of msg.events) s.deliver(msg.channel, e);
    }
  }
  deliver(channel: string, event: string) {
    for (const [id, ch] of this.subs) if (ch === channel) this.reply({ type: 'data', id, event });
  }
  reply(msg: unknown) {
    queueMicrotask(() => !this.closed && this.onmessage?.({ data: JSON.stringify(msg) }));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }
  /** The connection drops from the server side. */
  drop() {
    this.close();
  }
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);
let server: FakeAppSync;
let tokens: { subscribe: string[]; publish: string[] }[];

function fakeApi(opts: { refuse?: boolean } = {}): Client {
  let n = 0;
  return {
    post: vi.fn(async (path: string, body: { subscribe: string[]; publish: string[] }) => {
      expect(path).toBe('/realtime/token');
      tokens.push(body);
      if (opts.refuse) throw Object.assign(new (await import('../src/client')).ApiError(403, 'refused', 'REALTIME_REFUSED'));
      return {
        token: `tok-${++n}`,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        endpoint: 'wss://abc.appsync-realtime-api.us-east-1.amazonaws.com/event/realtime',
        host: 'abc.appsync-api.us-east-1.amazonaws.com',
        namespace: 'app',
      };
    }),
    openSocket: server.open,
  } as unknown as Client;
}

function watch(hub: RealtimeHub, channel: string, opts: { publish?: boolean; echo?: boolean } = {}) {
  const events: unknown[] = [];
  const statuses: ChannelStatus[] = [];
  const resyncs = { n: 0 };
  const stop = hub.add(
    { channel, publish: !!opts.publish, echo: !!opts.echo, onEvent: (d) => events.push(d), onResync: () => resyncs.n++, onStatus: (s) => statuses.push(s) },
    'u_1:MEMBER',
  );
  return { events, statuses, resyncs, stop, status: () => statuses.at(-1) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
  server = new FakeAppSync();
  tokens = [];
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('RealtimeHub', () => {
  it('connects with the token in the subprotocol, subscribes, goes live, resyncs and delivers events', async () => {
    const hub = new RealtimeHub(fakeApi(), { random: () => 1 });
    const w = watch(hub, 'counter/main');
    expect(w.status()).toBe('connecting');
    await flush();
    expect(tokens).toEqual([{ subscribe: ['counter/main'], publish: [] }]);
    const ws = server.last;
    expect(ws.url).toBe('wss://abc.appsync-realtime-api.us-east-1.amazonaws.com/event/realtime');
    expect(ws.protocols[0]).toBe('aws-appsync-event-ws');
    const header = JSON.parse(atob(ws.protocols[1]!.slice('header-'.length).replace(/-/g, '+').replace(/_/g, '/')));
    expect(header).toEqual({ host: 'abc.appsync-api.us-east-1.amazonaws.com', Authorization: 'tok-1' });
    expect(ws.of('subscribe')).toEqual([expect.objectContaining({ channel: '/app/counter/main', authorization: header })]);
    expect(w.status()).toBe('live');
    expect(w.resyncs.n).toBe(1);
    server.broadcast('/app/counter/main', { n: 3 });
    await flush();
    expect(w.events).toEqual([{ n: 3 }]);
    // The documented shape: `event` is a list of JSON strings.
    const [sub] = ws.of('subscribe');
    ws.reply({ type: 'data', id: sub.id, event: [JSON.stringify({ d: { n: 4 }, f: 'server', i: 'a' }), JSON.stringify({ d: { n: 5 }, f: 'server', i: 'b' })] });
    await flush();
    expect(w.events).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
  });

  it("drops this tab's own publishes by default, but not other tabs'", async () => {
    const hub = new RealtimeHub(fakeApi());
    const mine = watch(hub, 'room/lobby', { publish: true });
    const withEcho = watch(hub, 'room/lobby', { echo: true });
    await flush();
    expect(tokens.at(-1)).toEqual({ subscribe: ['room/lobby'], publish: ['room/lobby'] });
    await hub.publish('room/lobby', { wave: 'Sam' });
    await flush();
    expect(server.last.of('publish')[0]).toMatchObject({ channel: '/app/room/lobby', authorization: { Authorization: 'tok-1' } });
    expect(mine.events).toEqual([]);
    expect(withEcho.events).toEqual([{ wave: 'Sam' }]);
    server.broadcast('/app/room/lobby', { wave: 'Ann' }, 'another-tab');
    await flush();
    expect(mine.events).toEqual([{ wave: 'Ann' }]);
  });

  it('refuses events over 4 KB and publishing without asking for it', async () => {
    const hub = new RealtimeHub(fakeApi());
    watch(hub, 'room/lobby', { publish: true });
    watch(hub, 'counter/main');
    await flush();
    await expect(hub.publish('room/lobby', 'x'.repeat(5000))).rejects.toThrow(/limit is 4096/);
    await expect(hub.publish('counter/main', 1)).rejects.toThrow(/publish: true/);
    expect(server.last.of('publish')).toEqual([]);
  });

  it('refreshes the token a minute before it expires and re-subscribes under it', async () => {
    const hub = new RealtimeHub(fakeApi());
    const w = watch(hub, 'counter/main');
    await flush();
    const ws = server.last;
    const [first] = ws.of('subscribe');
    await server.pass(13 * 60_000);
    expect(tokens).toHaveLength(1);
    await server.pass(60_000);
    expect(tokens).toHaveLength(2);
    expect(server.sockets).toHaveLength(1);
    const subs = ws.of('subscribe');
    expect(subs).toHaveLength(2);
    expect(subs[1].authorization.Authorization).toBe('tok-2');
    expect(ws.of('unsubscribe')).toEqual([{ type: 'unsubscribe', id: first.id }]);
    expect(w.status()).toBe('live');
    server.broadcast('/app/counter/main', 7);
    await flush();
    expect(w.events).toEqual([7]);
    // ...and again before the second one runs out.
    await server.pass(14 * 60_000);
    expect(tokens).toHaveLength(3);
    expect(server.sockets).toHaveLength(1);
  });

  it('reconnects with jittered, growing backoff and resyncs each time', async () => {
    const hub = new RealtimeHub(fakeApi(), { random: () => 1 });
    const w = watch(hub, 'counter/main');
    await flush();
    expect(w.resyncs.n).toBe(1);
    server.last.drop();
    expect(w.status()).toBe('offline');
    await vi.advanceTimersByTimeAsync(999);
    expect(server.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.sockets).toHaveLength(2);
    expect(w.status()).toBe('live');
    expect(w.resyncs.n).toBe(2);

    // Two failures in a row without a connection in between: 1 s, then 2 s.
    server.auto = false;
    server.last.drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.sockets).toHaveLength(3);
    server.last.drop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(server.sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.sockets).toHaveLength(4);
    expect(w.status()).toBe('connecting');
  });

  it('scales the backoff by a random 50-100 %', async () => {
    const hub = new RealtimeHub(fakeApi(), { random: () => 0 });
    watch(hub, 'counter/main');
    await flush();
    server.last.drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(server.sockets).toHaveLength(2);
  });

  it('reconnects when the keep-alives stop', async () => {
    const hub = new RealtimeHub(fakeApi(), { random: () => 1 });
    const w = watch(hub, 'counter/main');
    await flush();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(server.sockets[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.sockets).toHaveLength(2);
    expect(w.status()).toBe('live');
  });

  it('disconnects after 30 s hidden, and reconnects and resyncs when visible again', async () => {
    const hub = new RealtimeHub(fakeApi());
    const w = watch(hub, 'counter/main');
    await flush();
    const setVisibility = (v: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(server.last.closed).toBe(false);
    setVisibility('visible');
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(server.last.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.last.closed).toBe(true);
    expect(w.status()).toBe('offline');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.sockets).toHaveLength(1);
    setVisibility('visible');
    await flush();
    expect(server.sockets).toHaveLength(2);
    expect(w.status()).toBe('live');
    expect(w.resyncs.n).toBe(2);
  });

  it('asks for a token covering every channel on the page, and closes when the last one goes', async () => {
    const hub = new RealtimeHub(fakeApi());
    const a = watch(hub, 'counter/main');
    await flush();
    const b = watch(hub, 'room/lobby', { publish: true });
    await flush();
    expect(tokens.at(-1)).toEqual({ subscribe: ['counter/main', 'room/lobby'], publish: ['room/lobby'] });
    expect(server.sockets).toHaveLength(1);
    expect(server.last.of('subscribe').map((m) => m.channel)).toEqual(['/app/counter/main', '/app/room/lobby']);
    b.stop();
    await flush();
    expect(server.last.of('unsubscribe')).toHaveLength(1);
    a.stop();
    await flush();
    expect(server.last.closed).toBe(true);
  });

  it('stays offline when the token is refused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hub = new RealtimeHub(fakeApi({ refuse: true }));
    const w = watch(hub, 'list/secret');
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.status()).toBe('offline');
    expect(tokens).toHaveLength(1);
    expect(server.sockets).toHaveLength(0);
    error.mockRestore();
  });
});

describe('useChannel', () => {
  function Counter() {
    const [n, setN] = useState(0);
    const [resyncs, setResyncs] = useState(0);
    const { status, publish } = useChannel<{ n: number }>('counter/main', (e) => setN(e.n), { publish: true, onResync: () => setResyncs((r) => r + 1) });
    return (
      <div>
        <p>status: {status}</p>
        <p>n: {n}</p>
        <p>resyncs: {resyncs}</p>
        <button type="button" onClick={() => void publish({ n: n + 1 })}>
          bump
        </button>
      </div>
    );
  }

  it('is offline signed out and live signed in, through the app API and one shared socket', async () => {
    let signedIn = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/session') {
        return signedIn
          ? new Response(JSON.stringify({ user: { id: 'u_1', name: 'Sam' }, role: 'MEMBER', canManageAccess: false }))
          : new Response('{}', { status: 401 });
      }
      if (url === '/api/realtime/token') {
        const body = JSON.parse(String(init?.body));
        tokens.push(body);
        return new Response(JSON.stringify({ token: 't', expiresAt: new Date(Date.now() + 900_000).toISOString(), endpoint: 'wss://r/event/realtime', host: 'h', namespace: 'app' }));
      }
      return new Response('{}', { status: 404 });
    });
    const client = createClient({ fetch: fetch as never, webSocket: server.open });
    const { unmount } = render(
      <StacksProvider client={client} silentSignIn={false}>
        <Counter />
      </StacksProvider>,
    );
    await act(flush);
    expect(screen.getByText('status: offline')).toBeInTheDocument();
    expect(server.sockets).toHaveLength(0);
    unmount();

    signedIn = true;
    render(
      <StacksProvider client={createClient({ fetch: fetch as never, webSocket: server.open })} silentSignIn={false}>
        <Counter />
        <Counter />
      </StacksProvider>,
    );
    await act(flush);
    await act(flush);
    expect(screen.getAllByText('status: live')).toHaveLength(2);
    expect(screen.getAllByText('resyncs: 1')).toHaveLength(2);
    expect(server.sockets).toHaveLength(1);
    expect(tokens).toEqual([{ subscribe: ['counter/main'], publish: ['counter/main'] }]);
    await act(async () => server.broadcast('/app/counter/main', { n: 5 }));
    await act(flush);
    expect(screen.getAllByText('n: 5')).toHaveLength(2);
  });
});
