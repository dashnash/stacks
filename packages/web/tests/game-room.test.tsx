import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createStateBuffer,
  GameRoomClient,
  interpolate,
  StacksProvider,
  useGameRoom,
  type ChannelLike,
  type ChannelStatus,
  type Client,
  type GameRoomSnapshot,
  type GameSignaling,
  type PeerLike,
  type SocketLike,
} from '../src/index';

const ROOM = 'r1';
const CHANNELS = { room: `room/${ROOM}`, toServer: `room/${ROOM}/to-server`, toMe: `room/${ROOM}/to/u-ann` };

/** The realtime channels, in memory. */
class FakeSignaling implements GameSignaling {
  readonly sent: { channel: string; data: any }[] = [];
  private readonly listeners = new Map<string, { onEvent: (d: unknown) => void; onStatus: (s: ChannelStatus) => void }[]>();
  /** Channels go live as soon as they are opened, unless this is false. */
  auto = true;
  listen(channel: string, onEvent: (d: unknown) => void, onStatus: (s: ChannelStatus) => void) {
    const entry = { onEvent, onStatus };
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), entry]);
    if (this.auto) queueMicrotask(() => onStatus('live'));
    return () => this.listeners.set(channel, (this.listeners.get(channel) ?? []).filter((e) => e !== entry));
  }
  sender(channel: string, onStatus: (s: ChannelStatus) => void) {
    const stop = this.listen(channel, () => undefined, onStatus);
    return { publish: async (data: unknown) => void this.sent.push({ channel, data }), close: stop };
  }
  /** The server (or the API) publishes on a channel. */
  deliver(channel: string, data: unknown) {
    for (const l of this.listeners.get(channel) ?? []) l.onEvent(data);
  }
  goLive(channel: string) {
    for (const l of this.listeners.get(channel) ?? []) l.onStatus('live');
  }
  listening(channel: string) {
    return (this.listeners.get(channel) ?? []).length;
  }
  of(t: string) {
    return this.sent.filter((s) => s.data.t === t);
  }
}

class FakeChannel implements ChannelLike {
  readyState = 'connecting';
  readonly sent: any[] = [];
  onopen: ChannelLike['onopen'] = null;
  onmessage: ChannelLike['onmessage'] = null;
  onclose: ChannelLike['onclose'] = null;
  constructor(
    readonly label: string,
    readonly options?: { ordered?: boolean; maxRetransmits?: number },
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 'closed';
  }
  /** The server sends on this channel. */
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

class FakePeer implements PeerLike {
  connectionState = 'new';
  localDescription: { sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  readonly channels: Record<string, FakeChannel> = {};
  readonly candidates: unknown[] = [];
  closed = false;
  onicecandidate: PeerLike['onicecandidate'] = null;
  onconnectionstatechange: PeerLike['onconnectionstatechange'] = null;
  constructor(readonly config: { iceServers: unknown[] }) {}
  createDataChannel(label: string, options?: { ordered?: boolean; maxRetransmits?: number }) {
    return (this.channels[label] = new FakeChannel(label, options));
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: 'v=0 offer' };
  }
  async setLocalDescription(d: { sdp?: string }) {
    this.localDescription = { sdp: d.sdp! };
  }
  async setRemoteDescription(d: { type: 'answer'; sdp: string }) {
    this.remote = d;
  }
  async addIceCandidate(c: unknown) {
    this.candidates.push(c);
  }
  close() {
    this.closed = true;
  }
  /** The connection comes up: both channels open and the server says welcome. */
  open(players = [{ id: 'u_ann', name: 'Ann' }]) {
    this.connectionState = 'connected';
    for (const ch of Object.values(this.channels)) ch.readyState = 'open';
    this.channels.events!.receive({ welcome: { you: { id: 'u_ann', name: 'Ann' }, players, tickHz: 20, rejoined: false } });
  }
  setState(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.({});
  }
}

function setup(opts: { room?: () => any; join?: () => any } = {}) {
  const signaling = new FakeSignaling();
  const peers: FakePeer[] = [];
  const changes: GameRoomSnapshot[] = [];
  const states: { state: unknown; meta: unknown }[] = [];
  const events: unknown[] = [];
  let ticket = 0;
  const room = { current: opts.room ?? (() => ({ id: ROOM, status: 'open' })) };
  const join = {
    current:
      opts.join ??
      (() => ({ ticket: `ticket-${++ticket}`, iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], channels: CHANNELS, player: { id: 'u_ann', name: 'Ann' } })),
  };
  const api = {
    get: vi.fn(async (path: string) => {
      expect(path).toBe(`/rooms/${ROOM}`);
      return { room: room.current() };
    }),
    post: vi.fn(async (path: string) => (path.endsWith('/join') ? join.current() : { ok: true })),
  };
  let clock = 1000;
  const client = new GameRoomClient({
    roomId: ROOM,
    api: api as never,
    signaling,
    createPeer: (config) => {
      const p = new FakePeer(config);
      peers.push(p);
      return p;
    },
    onState: (state, meta) => states.push({ state, meta }),
    onEvent: (e) => events.push(e),
    onChange: (s) => changes.push(s),
    now: () => clock,
    random: () => 1,
  });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  /** Start and get to "the offer is out". */
  const toOffer = async () => {
    client.start();
    await flush();
    return peers.at(-1)!;
  };
  const answer = async (peer = peers.at(-1)!) => {
    signaling.deliver(CHANNELS.toMe, { t: 'answer', sid: signaling.of('offer').at(-1)!.data.sid, sdp: 'v=0 answer' });
    await flush();
    peer.open();
  };
  return { signaling, peers, changes, states, events, api, client, room, join, flush, toOffer, answer, statuses: () => changes.map((c) => c.status), tick: (ms: number) => (clock += ms) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('GameRoomClient', () => {
  it('goes starting → connecting → live: joins, offers with the ticket, takes the answer, and is welcomed', async () => {
    const t = setup();
    const peer = await t.toOffer();
    expect(t.api.post).toHaveBeenCalledWith(`/rooms/${ROOM}/join`);
    expect(peer.config).toEqual({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] });
    // The fast path is unreliable and unordered; events are reliable.
    expect(peer.channels.state!.options).toEqual({ ordered: false, maxRetransmits: 0 });
    expect(peer.channels.events!.options).toBeUndefined();
    const offer = t.signaling.of('offer')[0]!;
    expect(offer).toMatchObject({ channel: CHANNELS.toServer, data: { t: 'offer', ticket: 'ticket-1', sdp: 'v=0 offer' } });
    expect(offer.data.sid).toMatch(/^[0-9a-f]{24}$/);
    expect(t.client.current.status).toBe('connecting');

    await t.answer();
    expect(peer.remote).toEqual({ type: 'answer', sdp: 'v=0 answer' });
    expect(t.statuses()).toEqual(['connecting', 'connecting', 'live']);
    expect(t.client.current).toMatchObject({ status: 'live', you: { id: 'u_ann', name: 'Ann' }, players: [{ id: 'u_ann', name: 'Ann' }] });
  });

  it('waits for the server while the room is starting: told over the room channel, or by asking again', async () => {
    const t = setup({ room: () => ({ id: ROOM, status: 'starting' }) });
    t.client.start();
    await t.flush();
    expect(t.client.current.status).toBe('starting');
    expect(t.peers).toEqual([]);
    // The server says it is open.
    t.room.current = () => ({ id: ROOM, status: 'open' });
    t.signaling.deliver(CHANNELS.room, { status: 'open' });
    await t.flush();
    expect(t.client.current.status).toBe('connecting');
    expect(t.peers).toHaveLength(1);

    // Missed the event: the poll finds out.
    const u = setup({ room: () => ({ id: ROOM, status: 'starting' }) });
    u.client.start();
    await u.flush();
    u.room.current = () => ({ id: ROOM, status: 'open' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(u.peers).toHaveLength(1);
  });

  it('is listening for the answer before the offer goes out', async () => {
    const t = setup();
    t.signaling.auto = false;
    t.client.start();
    await t.flush();
    expect(t.signaling.listening(CHANNELS.toMe)).toBe(1);
    expect(t.signaling.of('offer')).toEqual([]);
    t.signaling.goLive(CHANNELS.toMe);
    await t.flush();
    expect(t.signaling.of('offer')).toEqual([]);
    t.signaling.goLive(CHANNELS.toServer);
    await t.flush();
    expect(t.signaling.of('offer')).toHaveLength(1);
  });

  it('trickles its ICE candidates one per event and takes the server\'s', async () => {
    const t = setup();
    const peer = await t.toOffer();
    const sid = t.signaling.of('offer')[0]!.data.sid;
    peer.onicecandidate!({ candidate: { toJSON: () => ({ candidate: 'candidate:1', sdpMid: '0' }) } });
    peer.onicecandidate!({ candidate: { toJSON: () => ({ candidate: 'candidate:2', sdpMid: '0' }) } });
    peer.onicecandidate!({ candidate: null });
    expect(t.signaling.of('ice').map((s) => s.data)).toEqual([
      { t: 'ice', sid, c: { candidate: 'candidate:1', sdpMid: '0' } },
      { t: 'ice', sid, c: { candidate: 'candidate:2', sdpMid: '0' } },
    ]);
    t.signaling.deliver(CHANNELS.toMe, { t: 'ice', sid, c: { candidate: 'candidate:9' } });
    // Signals for another connection attempt are ignored.
    t.signaling.deliver(CHANNELS.toMe, { t: 'ice', sid: 'someone-else', c: { candidate: 'candidate:x' } });
    await t.flush();
    expect(peer.candidates).toEqual([{ candidate: 'candidate:9' }]);
  });

  it('sends input on the unreliable channel and events on the reliable one, only while live', async () => {
    const t = setup();
    const peer = await t.toOffer();
    t.client.sendInput({ x: 0.1 });
    expect(t.client.sendEvent('bump')).toBe(false);
    await t.answer();
    t.client.sendInput({ x: 0.5, y: 0.25 });
    expect(t.client.sendEvent('bump')).toBe(true);
    expect(peer.channels.state!.sent).toEqual([{ i: { x: 0.5, y: 0.25 } }]);
    expect(peer.channels.events!.sent.filter((m) => 'event' in m)).toEqual([{ event: 'bump' }]);
  });

  it('hands raw states (with tick and server time), game events and roster changes to the app', async () => {
    const t = setup();
    const peer = await t.toOffer();
    await t.answer();
    peer.channels.state!.receive({ n: 7, t: 350, s: { dots: [{ id: 'u_ann', x: 0.5 }] } });
    peer.channels.state!.onmessage!({ data: 'not json' });
    peer.channels.events!.receive({ event: { shake: 'Bob' } });
    peer.channels.events!.receive({ players: [{ id: 'u_ann', name: 'Ann' }, { id: 'u_bob', name: 'Bob' }] });
    expect(t.states).toEqual([{ state: { dots: [{ id: 'u_ann', x: 0.5 }] }, meta: { tick: 7, serverTime: 350 } }]);
    expect(t.events).toEqual([{ shake: 'Bob' }]);
    expect(t.client.current.players.map((p) => p.name)).toEqual(['Ann', 'Bob']);
  });

  it('measures RTT with pings on the reliable channel, smoothed', async () => {
    const t = setup();
    const peer = await t.toOffer();
    await t.answer();
    const pings = () => peer.channels.events!.sent.filter((m) => 'ping' in m);
    expect(pings()).toEqual([{ ping: 1000 }]);
    t.tick(40);
    peer.channels.events!.receive({ pong: 1000 });
    expect(t.client.current.rttMs).toBe(40);
    await vi.advanceTimersByTimeAsync(2000);
    expect(pings()).toHaveLength(2);
    t.tick(140);
    peer.channels.events!.receive({ pong: 1040 });
    // 0.7 × 40 + 0.3 × 140
    expect(t.client.current.rttMs).toBe(70);
  });

  it('rejoins with a fresh ticket when the connection drops, and is live again', async () => {
    const t = setup();
    const first = await t.toOffer();
    await t.answer();
    first.setState('failed');
    expect(t.client.current).toMatchObject({ status: 'connecting', rttMs: null });
    expect(first.closed).toBe(true);
    await t.flush();
    expect(t.peers).toHaveLength(2);
    expect(t.signaling.of('offer').map((o) => o.data.ticket)).toEqual(['ticket-1', 'ticket-2']);
    expect(t.signaling.of('offer')[1]!.data.sid).not.toBe(t.signaling.of('offer')[0]!.data.sid);
    // Signaling channels are reused, not opened again.
    expect(t.signaling.listening(CHANNELS.toMe)).toBe(1);
    await t.answer();
    expect(t.client.current.status).toBe('live');
    // Nothing from the dead connection leaks through.
    first.channels.state!.receive({ n: 1, t: 1, s: 'ghost' });
    expect(t.states).toEqual([]);
  });

  it('gives a "disconnected" peer 3 s to recover before reconnecting, and reconnects when a channel closes', async () => {
    const t = setup();
    const peer = await t.toOffer();
    await t.answer();
    peer.setState('disconnected');
    await vi.advanceTimersByTimeAsync(2000);
    peer.setState('connected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.peers).toHaveLength(1);
    peer.setState('disconnected');
    await vi.advanceTimersByTimeAsync(3000);
    await t.flush();
    expect(t.peers).toHaveLength(2);
    await t.answer();
    t.peers[1]!.channels.events!.onclose!({});
    await t.flush();
    expect(t.peers).toHaveLength(3);
  });

  it('retries with growing delays when no answer comes, and straight away when the ticket had expired', async () => {
    const t = setup();
    await t.toOffer();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.peers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(t.peers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000 + 999);
    expect(t.peers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.peers).toHaveLength(3);

    t.signaling.deliver(CHANNELS.toMe, { t: 'refused', sid: t.signaling.of('offer').at(-1)!.data.sid, reason: 'ticket' });
    await t.flush();
    expect(t.peers).toHaveLength(4);
    expect(t.client.current.status).toBe('connecting');
  });

  it('is "ended" on game over, keeps the results, and stops', async () => {
    const t = setup();
    const peer = await t.toOffer();
    await t.answer();
    peer.channels.events!.receive({ over: { reason: 'idle', results: { winner: 'u_ann' } } });
    expect(t.client.current).toMatchObject({ status: 'ended', over: { reason: 'idle', results: { winner: 'u_ann' } }, players: [] });
    expect(peer.closed).toBe(true);
    // The channel closing afterwards does not start a reconnect.
    peer.setState('closed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.peers).toHaveLength(1);
    expect(t.signaling.listening(CHANNELS.room)).toBe(0);
  });

  it('is "ended" when the room channel says so, or when the room is already over', async () => {
    const t = setup();
    await t.toOffer();
    await t.answer();
    t.room.current = () => ({ id: ROOM, status: 'ended', endedReason: 'ended' });
    t.signaling.deliver(CHANNELS.room, { status: 'ended' });
    await t.flush();
    expect(t.client.current).toMatchObject({ status: 'ended', over: { reason: 'ended' } });

    const u = setup({ room: () => ({ id: ROOM, status: 'ended', endedReason: 'time', results: { n: 1 } }) });
    u.client.start();
    await u.flush();
    expect(u.client.current).toMatchObject({ status: 'ended', over: { reason: 'time', results: { n: 1 } } });
    expect(u.api.post).not.toHaveBeenCalled();
  });

  it('is "offline" with a reason for a full room, an unknown room, and being signed out', async () => {
    const full = setup({ join: () => { throw new ApiError(409, 'This game is full', 'ROOM_FULL'); } });
    full.client.start();
    await full.flush();
    expect(full.client.current).toMatchObject({ status: 'offline', error: 'full' });

    const refused = setup();
    await refused.toOffer();
    refused.signaling.deliver(CHANNELS.toMe, { t: 'refused', sid: refused.signaling.of('offer')[0]!.data.sid, reason: 'full' });
    await refused.flush();
    expect(refused.client.current).toMatchObject({ status: 'offline', error: 'full' });

    const missing = setup({ room: () => { throw new ApiError(404, 'No such room', 'NOT_FOUND'); } });
    missing.client.start();
    await missing.flush();
    expect(missing.client.current).toMatchObject({ status: 'offline', error: 'not_found' });

    const out = setup({ room: () => { throw new ApiError(401, 'Sign in required', 'UNAUTHORIZED'); } });
    out.client.start();
    await out.flush();
    expect(out.client.current).toMatchObject({ status: 'offline', error: 'signed_out' });
  });

  it('leave() tells the server and the API, and stays out', async () => {
    const t = setup();
    const peer = await t.toOffer();
    await t.answer();
    await t.client.leave();
    expect(peer.channels.events!.sent.at(-1)).toEqual({ leave: true });
    expect(t.api.post).toHaveBeenLastCalledWith(`/rooms/${ROOM}/leave`);
    expect(t.client.current).toMatchObject({ status: 'offline', error: 'left' });
    expect(peer.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.peers).toHaveLength(1);
  });

  it('stop() closes the connection without leaving (the server keeps the place)', async () => {
    const t = setup();
    const peer = await t.toOffer();
    await t.answer();
    t.client.stop();
    expect(peer.closed).toBe(true);
    expect(peer.channels.events!.sent.some((m) => 'leave' in m)).toBe(false);
    expect(t.api.post).toHaveBeenCalledTimes(1);
  });
});

describe('interpolate', () => {
  it('blends numbers through objects and arrays, and takes everything else from the newer state', () => {
    expect(interpolate(0, 10, 0.25)).toBe(2.5);
    expect(interpolate({ x: 0, y: 1, name: 'a', on: false }, { x: 1, y: 3, name: 'b', on: true }, 0.5)).toEqual({ x: 0.5, y: 2, name: 'b', on: true });
    expect(interpolate([0, 10], [10, 20], 0.1)).toEqual([1, 11]);
  });

  it('matches list items by id, so players joining and leaving never blend into each other', () => {
    const a = { dots: [{ id: 'ann', x: 0 }, { id: 'bob', x: 1 }] };
    const b = { dots: [{ id: 'bob', x: 0 }, { id: 'cy', x: 0.4 }] };
    expect(interpolate(a, b, 0.5)).toEqual({ dots: [{ id: 'bob', x: 0.5 }, { id: 'cy', x: 0.4 }] });
  });
});

describe('createStateBuffer', () => {
  it('renders 100 ms behind, between the two states around that moment', () => {
    let now = 5000;
    const buffer = createStateBuffer<{ x: number }>({ now: () => now });
    expect(buffer.sample()).toBeUndefined();
    buffer.push({ x: 0 }, { tick: 1, serverTime: 1000 });
    now += 50;
    buffer.push({ x: 1 }, { tick: 2, serverTime: 1050 });
    now += 50;
    buffer.push({ x: 2 }, { tick: 3, serverTime: 1100 });
    // Now is server time 1100; 100 ms ago is 1000.
    expect(buffer.sample()).toEqual({ x: 0 });
    now += 25;
    expect(buffer.sample()).toEqual({ x: 0.5 });
    now += 50;
    expect(buffer.sample()).toEqual({ x: 1.5 });
    // Nothing newer: hold the last state rather than guess.
    now += 500;
    expect(buffer.sample()).toEqual({ x: 2 });
  });

  it('ignores a state that arrives after a newer one, and is not thrown by a late packet', () => {
    let now = 0;
    const buffer = createStateBuffer<{ x: number }>({ now: () => now, delayMs: 0 });
    buffer.push({ x: 1 }, { tick: 2, serverTime: 100 });
    now = 80; // this one was held up on the way
    buffer.push({ x: 0 }, { tick: 1, serverTime: 50 });
    expect(buffer.sample()).toEqual({ x: 1 });
    buffer.clear();
    expect(buffer.sample()).toBeUndefined();
  });
});

describe('useGameRoom', () => {
  function Room({ roomId }: { roomId: string | null }) {
    const room = useGameRoom(roomId);
    return (
      <p data-testid="room">
        {room.status}:{room.error ?? ''}:{room.players.length}
      </p>
    );
  }

  it('is offline signed out or without a room, and connects through the app API signed in', async () => {
    vi.useRealTimers();
    const get = vi.fn(async (path: string) => {
      if (path === '/auth/session') throw new ApiError(401, 'Sign in required', 'UNAUTHORIZED');
      return {};
    });
    const signedOut = { get, post: vi.fn(), session: () => get('/auth/session'), openSocket: () => ({}) as SocketLike, openPeer: vi.fn() } as unknown as Client;
    const view = render(
      <StacksProvider client={signedOut} silentSignIn={false}>
        <Room roomId="r1" />
      </StacksProvider>,
    );
    expect(await screen.findByText(/offline/)).toBeInTheDocument();
    view.unmount();

    const session = { user: { id: 'u_ann', name: 'Ann' }, role: 'MEMBER', canManageAccess: false };
    const calls: string[] = [];
    const api = {
      session: async () => session,
      get: vi.fn(async (path: string) => {
        calls.push(`GET ${path}`);
        return { room: { id: 'r1', status: 'starting' } };
      }),
      post: vi.fn(async () => {
        throw new ApiError(503, 'no realtime in this test');
      }),
      openSocket: () => ({ send: () => undefined, close: () => undefined }) as unknown as SocketLike,
      openPeer: vi.fn(),
    } as unknown as Client;
    render(
      <StacksProvider client={api} silentSignIn={false}>
        <Room roomId="r1" />
      </StacksProvider>,
    );
    expect(await screen.findByText('starting::0')).toBeInTheDocument();
    await act(async () => undefined);
    expect(calls).toContain('GET /rooms/r1');
  });
});
