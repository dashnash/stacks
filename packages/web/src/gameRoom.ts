/**
 * Game rooms in the browser (manifest module `gameServer`): a WebRTC connection to the room's
 * server-authoritative game server, set up over the realtime channels. Two data channels:
 * `state` (unreliable: your input up, the server's state down, ~20 times a second) and `events`
 * (reliable: joins and leaves, "game over", whatever the game sends). The client only sends input
 * and renders; `useGameRoom` is the way in.
 */
import { ApiError, type Client } from './client';
import type { ChannelStatus, RealtimeHub } from './realtime';

export type GameRoomStatus = 'starting' | 'connecting' | 'live' | 'ended' | 'offline';

/** A seat in the room. One person on two devices (a screen and a phone) holds two seats. */
export interface GamePlayerInfo {
  /** The seat id: the user id for the `default` device, else `<userId>~<device>`. */
  id: string;
  name: string;
  /** Who holds the seat (servers built before devices existed leave it out). */
  userId?: string;
  /** The device label the seat joined with (`default` when none was given). */
  device?: string;
}

/** A device label for `useGameRoom(roomId, { device })`: 1-16 lower-case letters, digits or `-`. */
export const GAME_DEVICE_LABEL = /^[a-z0-9-]{1,16}$/;

/** What comes with each state: the server's tick and clock (ms since the room started). */
export interface StateMeta {
  tick: number;
  serverTime: number;
}

export interface GameRoomSnapshot {
  status: GameRoomStatus;
  players: GamePlayerInfo[];
  /** Your seat (with its `device`), once joined. */
  you: GamePlayerInfo | null;
  /** Round trip to the server in milliseconds (smoothed), or null before the first measurement. */
  rttMs: number | null;
  /** Why the game ended, with its results, once it has. */
  over: { reason: string; results?: unknown } | null;
  /**
   * Why the room can't be joined, when `offline`: `full`, `seats` (you hold as many seats as the
   * game allows one person), `bad_device` (the `device` option is not a label), `not_found`,
   * `signed_out`, `left`.
   */
  error: string | null;
}

/** The part of the realtime hub a room uses (tests pass a fake). */
export interface GameSignaling {
  /** Listen on a channel. Returns the unsubscribe. */
  listen(channel: string, onEvent: (data: unknown) => void, onStatus: (status: ChannelStatus) => void): () => void;
  /** Open a channel for publishing only. */
  sender(channel: string, onStatus: (status: ChannelStatus) => void): { publish(data: unknown): Promise<void>; close(): void };
}

/** The part of `RTCDataChannel` a room uses. */
export interface ChannelLike {
  readyState: string;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

/** The part of `RTCPeerConnection` a room uses. */
export interface PeerLike {
  connectionState: string;
  localDescription: { sdp: string } | null;
  createDataChannel(label: string, options?: { ordered?: boolean; maxRetransmits?: number }): ChannelLike;
  createOffer(): Promise<{ type: 'offer'; sdp?: string }>;
  setLocalDescription(description: { type: 'offer'; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: 'answer'; sdp: string }): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  close(): void;
  onicecandidate: ((ev: { candidate: { toJSON(): unknown } | null }) => void) | null;
  onconnectionstatechange: ((ev: unknown) => void) | null;
}

export interface GameRoomClientOptions {
  roomId: string;
  /**
   * Which of your devices this is (`screen`, `gun`): one seat per (you, device), so one person can
   * be in a room twice. Default `default` (your one seat, keyed by your user id).
   */
  device?: string;
  api: Pick<Client, 'get' | 'post'>;
  signaling: GameSignaling;
  createPeer: (config: { iceServers: { urls: string[]; username?: string; credential?: string }[] }) => PeerLike;
  onState(state: unknown, meta: StateMeta): void;
  onEvent(event: unknown): void;
  /** Called whenever status, players, RTT or the end state change. */
  onChange(snapshot: GameRoomSnapshot): void;
  /** Milliseconds, monotonic (RTT). Default `performance.now`. */
  now?: () => number;
  random?: () => number;
}

interface Room {
  id: string;
  status: 'starting' | 'open' | 'ended';
  endedReason?: string;
  results?: unknown;
}

interface JoinResponse {
  ticket: string;
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  channels: { room: string; toServer: string; toMe: string };
  player: GamePlayerInfo;
}

/** While the server is starting, ask again this often (the room channel normally says so first). */
export const STARTING_POLL_MS = 5000;
/** How long one connection attempt may take, signaling to "welcome". */
export const ATTEMPT_TIMEOUT_MS = 15_000;
/** A "disconnected" peer gets this long to recover before the room reconnects. */
export const DISCONNECTED_GRACE_MS = 3000;
export const PING_INTERVAL_MS = 2000;
/** Reconnect delays: 0.5 s doubling to 5 s, each scaled by a random 50-100 %. */
export const RETRY_BASE_MS = 500;
export const RETRY_MAX_MS = 5000;

const randomId = () => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Signaling over the tab's realtime hub. */
export function hubSignaling(hub: RealtimeHub, who: string): GameSignaling {
  return {
    listen: (channel, onEvent, onStatus) => hub.add({ channel, publish: false, echo: false, onEvent, onStatus }, who),
    sender: (channel, onStatus) => {
      const close = hub.add({ channel, publish: true, echo: false, listen: false, onEvent: () => undefined, onStatus }, who);
      return { publish: (data) => hub.publish(channel, data), close };
    },
  };
}

/**
 * One room's connection. `useGameRoom` wraps it for React; use it directly only outside React.
 * `start()` once; `stop()` when done (the server keeps your place for 20 s); `leave()` to give it up.
 */
export class GameRoomClient {
  private snapshot: GameRoomSnapshot = { status: 'starting', players: [], you: null, rttMs: null, over: null, error: null };
  private stopped = false;
  private attemptNo = 0;
  private retries = 0;
  private peer: PeerLike | null = null;
  private stateChannel: ChannelLike | null = null;
  private eventsChannel: ChannelLike | null = null;
  private sid: string | null = null;
  private channels: JoinResponse['channels'] | null = null;
  private unlistenRoom: (() => void) | null = null;
  private unlistenMe: (() => void) | null = null;
  private toServer: ReturnType<GameSignaling['sender']> | null = null;
  private meLive = false;
  private serverLive = false;
  private whenSignalingLive: (() => void) | null = null;
  private timers: Record<'poll' | 'attempt' | 'retry' | 'ping' | 'grace', ReturnType<typeof setTimeout> | undefined> = {
    poll: undefined,
    attempt: undefined,
    retry: undefined,
    ping: undefined,
    grace: undefined,
  };
  private readonly now: () => number;

  constructor(private readonly opts: GameRoomClientOptions) {
    this.now = opts.now ?? (() => performance.now());
  }

  /** Join or leave: no body for the default seat (as before devices), else `{ device }`. */
  private seatPost<T>(action: 'join' | 'leave'): Promise<T> {
    const path = `/rooms/${this.opts.roomId}/${action}`;
    return this.opts.device === undefined ? this.opts.api.post<T>(path) : this.opts.api.post<T>(path, { device: this.opts.device });
  }

  get current(): GameRoomSnapshot {
    return this.snapshot;
  }

  start(): void {
    if (this.opts.device !== undefined && !GAME_DEVICE_LABEL.test(this.opts.device)) {
      console.error(`Game room: device "${this.opts.device}" must be 1-16 lower-case letters, digits or "-"`);
      return this.offline('bad_device');
    }
    this.unlistenRoom = this.opts.signaling.listen(
      `room/${this.opts.roomId}`,
      (data) => {
        const status = (data as { status?: string } | null)?.status;
        if (status === 'open' && this.snapshot.status === 'starting') void this.connect();
        else if (status === 'ended') void this.check();
      },
      // Every (re)connect of the channel: something may have been missed.
      (status) => {
        if (status === 'live' && this.snapshot.status === 'starting') void this.check();
      },
    );
    void this.check();
  }

  /** Send input on the unreliable channel. Dropped unless the room is live (send the next one). */
  sendInput(input: unknown): void {
    if (this.snapshot.status === 'live' && this.stateChannel?.readyState === 'open') this.stateChannel.send(JSON.stringify({ i: input }));
  }

  /** Send an event on the reliable channel. False when the room isn't live. */
  sendEvent(event: unknown): boolean {
    if (this.snapshot.status !== 'live' || this.eventsChannel?.readyState !== 'open') return false;
    this.eventsChannel.send(JSON.stringify({ event }));
    return true;
  }

  /** Give up your place in the room. */
  async leave(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.eventsChannel?.readyState === 'open') this.eventsChannel.send(JSON.stringify({ leave: true }));
    } catch {
      // the connection is already gone
    }
    this.stop();
    this.set({ status: 'offline', error: 'left', players: [] });
    await this.seatPost('leave').catch(() => undefined);
  }

  /** Close everything (on unmount). The server keeps your place for 20 s. */
  stop(): void {
    this.stopped = true;
    this.teardownPeer();
    for (const name of Object.keys(this.timers) as (keyof GameRoomClient['timers'])[]) this.clearTimer(name);
    this.unlistenRoom?.();
    this.unlistenMe?.();
    this.toServer?.close();
    this.unlistenRoom = this.unlistenMe = this.toServer = null;
  }

  // --- room status ----------------------------------------------------------------------------

  /** Ask the API where the room stands and act on it. */
  private async check(): Promise<void> {
    if (this.stopped || this.snapshot.status === 'ended') return;
    this.clearTimer('poll');
    let room: Room;
    try {
      room = (await this.opts.api.get<{ room: Room }>(`/rooms/${this.opts.roomId}`)).room;
    } catch (err) {
      if (this.stopped) return;
      if (err instanceof ApiError && err.status === 404) return this.offline('not_found');
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return this.offline('signed_out');
      this.timers.poll = setTimeout(() => void this.check(), STARTING_POLL_MS);
      return;
    }
    if (this.stopped) return;
    if (room.status === 'ended') return this.ended({ reason: room.endedReason ?? 'ended', ...(room.results !== undefined ? { results: room.results } : {}) });
    if (room.status === 'open') {
      if (this.snapshot.status === 'starting') void this.connect();
      return;
    }
    this.timers.poll = setTimeout(() => void this.check(), STARTING_POLL_MS);
  }

  private ended(over: { reason: string; results?: unknown }): void {
    if (this.snapshot.status === 'ended') return;
    this.stop();
    this.set({ status: 'ended', over: this.snapshot.over ?? over, players: [] });
  }

  private offline(error: string): void {
    this.stop();
    this.set({ status: 'offline', error, players: [] });
  }

  // --- connecting -------------------------------------------------------------------------------

  /** One connection attempt: a fresh ticket, an offer, the answer, "welcome". */
  private async connect(): Promise<void> {
    if (this.stopped || this.peer) return;
    const attempt = ++this.attemptNo;
    const stale = () => this.stopped || attempt !== this.attemptNo;
    this.clearTimer('retry');
    this.set({ status: 'connecting' });
    this.timers.attempt = setTimeout(() => this.retry(), ATTEMPT_TIMEOUT_MS);

    let join: JoinResponse;
    try {
      join = await this.seatPost<JoinResponse>('join');
    } catch (err) {
      if (stale()) return;
      this.clearTimer('attempt');
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === 'ROOM_ENDED') return void this.check();
      if (code === 'ROOM_FULL') return this.offline('full');
      if (code === 'TOO_MANY_SEATS') return this.offline('seats');
      if (code === 'ROOM_STARTING') {
        this.set({ status: 'starting' });
        this.timers.poll = setTimeout(() => void this.check(), STARTING_POLL_MS);
        return;
      }
      if (err instanceof ApiError && err.status === 404) return this.offline('not_found');
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return this.offline('signed_out');
      return this.retry();
    }
    if (stale()) return;
    this.set({ you: this.withDevice(join.player) });

    // The answer comes back on our own channel: be listening before the offer goes out.
    if (!this.channels) {
      this.channels = join.channels;
      this.unlistenMe = this.opts.signaling.listen(join.channels.toMe, (data) => void this.onSignal(data), (status) => this.signalingStatus('me', status));
      this.toServer = this.opts.signaling.sender(join.channels.toServer, (status) => this.signalingStatus('server', status));
    }
    if (!(this.meLive && this.serverLive)) {
      await new Promise<void>((resolve) => (this.whenSignalingLive = resolve));
      if (stale()) return;
    }

    try {
      const peer = this.opts.createPeer({ iceServers: join.iceServers });
      this.peer = peer;
      const sid = (this.sid = randomId());
      const state = (this.stateChannel = peer.createDataChannel('state', { ordered: false, maxRetransmits: 0 }));
      const events = (this.eventsChannel = peer.createDataChannel('events'));
      state.onmessage = (ev) => this.peer === peer && this.onStateMessage(ev.data);
      events.onmessage = (ev) => this.peer === peer && this.onEventMessage(ev.data);
      events.onclose = state.onclose = () => this.peer === peer && this.dropped();
      peer.onconnectionstatechange = () => {
        if (this.peer !== peer) return;
        this.clearTimer('grace');
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.dropped();
        else if (peer.connectionState === 'disconnected') this.timers.grace = setTimeout(() => this.peer === peer && this.dropped(), DISCONNECTED_GRACE_MS);
      };
      peer.onicecandidate = (ev) => {
        if (this.peer !== peer || !ev.candidate) return;
        // Trickle ICE: one candidate per event.
        void this.toServer?.publish({ t: 'ice', sid, c: ev.candidate.toJSON() }).catch(() => undefined);
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (stale() || this.peer !== peer) return;
      await this.toServer!.publish({ t: 'offer', sid, ticket: join.ticket, sdp: peer.localDescription?.sdp ?? offer.sdp ?? '' });
    } catch (err) {
      if (stale()) return;
      console.error('Game room: connecting failed', err);
      this.retry();
    }
  }

  private signalingStatus(which: 'me' | 'server', status: ChannelStatus): void {
    if (which === 'me') this.meLive = status === 'live';
    else this.serverLive = status === 'live';
    if (this.meLive && this.serverLive) {
      const go = this.whenSignalingLive;
      this.whenSignalingLive = null;
      go?.();
    }
  }

  private async onSignal(data: unknown): Promise<void> {
    const msg = data as { t?: string; sid?: string; sdp?: string; c?: unknown; reason?: string } | null;
    const peer = this.peer;
    if (!msg || !peer || msg.sid !== this.sid) return;
    try {
      if (msg.t === 'answer' && typeof msg.sdp === 'string') await peer.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      else if (msg.t === 'ice' && msg.c) await peer.addIceCandidate(msg.c);
      else if (msg.t === 'refused') {
        if (msg.reason === 'full' || msg.reason === 'seats') this.offline(msg.reason);
        else if (msg.reason === 'ended') {
          this.teardownPeer();
          void this.check();
        } else this.retry(msg.reason === 'ticket');
      }
    } catch (err) {
      console.error('Game room: bad signal', err);
      this.retry();
    }
  }

  // --- the data channels --------------------------------------------------------------------------

  private onStateMessage(raw: unknown): void {
    let msg: { n?: number; t?: number; s?: unknown };
    try {
      msg = JSON.parse(String(raw)) as typeof msg;
    } catch {
      return;
    }
    if (!msg || typeof msg.n !== 'number' || typeof msg.t !== 'number') return;
    try {
      this.opts.onState(msg.s, { tick: msg.n, serverTime: msg.t });
    } catch (err) {
      console.error('Game room: onState threw', err);
    }
  }

  private onEventMessage(raw: unknown): void {
    let msg: {
      welcome?: { you: GamePlayerInfo; players: GamePlayerInfo[] };
      players?: GamePlayerInfo[];
      event?: unknown;
      pong?: number;
      over?: { reason: string; results?: unknown };
    };
    try {
      msg = JSON.parse(String(raw)) as typeof msg;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.welcome) {
      this.clearTimer('attempt');
      this.retries = 0;
      this.set({ status: 'live', you: this.withDevice(msg.welcome.you), players: msg.welcome.players });
      this.ping();
    } else if (msg.players) this.set({ players: msg.players });
    else if (typeof msg.pong === 'number') {
      const rtt = Math.max(0, this.now() - msg.pong);
      const before = this.snapshot.rttMs;
      this.set({ rttMs: Math.round(before === null ? rtt : before * 0.7 + rtt * 0.3) });
    } else if (msg.over) {
      // "ended" for a peer that connected just as the game finished; "full" when the last seat went.
      if ((msg.over.reason === 'full' || msg.over.reason === 'seats') && this.snapshot.status !== 'live') this.offline(msg.over.reason);
      else this.ended(msg.over);
    } else if ('event' in msg) {
      try {
        this.opts.onEvent(msg.event);
      } catch (err) {
        console.error('Game room: onEvent threw', err);
      }
    }
  }

  /** `you` always says which device it is, even from an API or server that predates devices. */
  private withDevice(you: GamePlayerInfo): GamePlayerInfo {
    return { ...you, device: you.device ?? this.opts.device ?? 'default' };
  }

  private ping(): void {
    this.clearTimer('ping');
    if (this.snapshot.status !== 'live' || this.eventsChannel?.readyState !== 'open') return;
    this.eventsChannel.send(JSON.stringify({ ping: this.now() }));
    this.timers.ping = setTimeout(() => this.ping(), PING_INTERVAL_MS);
  }

  /** The connection went away under us: reconnect with a fresh ticket (the server keeps our place for 20 s). */
  private dropped(): void {
    if (this.stopped || !this.peer) return;
    this.retry(this.snapshot.status === 'live');
  }

  private retry(now = false): void {
    if (this.stopped) return;
    this.teardownPeer();
    this.clearTimer('attempt');
    this.clearTimer('retry');
    this.attemptNo++;
    this.set({ status: 'connecting', rttMs: null });
    const random = this.opts.random ?? Math.random;
    const delay = now ? 0 : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.retries) * (0.5 + random() / 2);
    this.retries++;
    this.timers.retry = setTimeout(() => void this.connect(), delay);
  }

  private teardownPeer(): void {
    const peer = this.peer;
    this.peer = null;
    this.sid = null;
    this.clearTimer('ping');
    this.clearTimer('grace');
    for (const ch of [this.stateChannel, this.eventsChannel]) {
      if (!ch) continue;
      ch.onmessage = ch.onclose = ch.onopen = null;
    }
    this.stateChannel = this.eventsChannel = null;
    if (!peer) return;
    peer.onicecandidate = peer.onconnectionstatechange = null;
    try {
      peer.close();
    } catch {
      // already closed
    }
  }

  private clearTimer(name: keyof GameRoomClient['timers']): void {
    if (this.timers[name] !== undefined) clearTimeout(this.timers[name]);
    this.timers[name] = undefined;
  }

  private set(change: Partial<GameRoomSnapshot>): void {
    const next = { ...this.snapshot, ...change };
    if (next.status !== 'offline') next.error = change.error ?? null;
    const same = (Object.keys(next) as (keyof GameRoomSnapshot)[]).every((k) => next[k] === this.snapshot[k]);
    if (same) return;
    this.snapshot = next;
    this.opts.onChange(next);
  }
}

// --- Interpolation ---------------------------------------------------------------------------------

/**
 * Blend two states: numbers are interpolated (`t` 0 is `a`, 1 is `b`), arrays and objects are
 * walked, everything else comes from `b`. Array items are matched by `id` when they have one
 * (players that appear or vanish are taken from `b`), else by position.
 */
export function interpolate<T>(a: T, b: T, t: number): T {
  if (typeof a === 'number' && typeof b === 'number') return (a + (b - a) * t) as T;
  if (Array.isArray(a) && Array.isArray(b)) {
    const hasIds = b.every((x) => x && typeof x === 'object' && 'id' in x);
    const byId = hasIds ? new Map(a.filter((x) => x && typeof x === 'object' && 'id' in x).map((x) => [(x as { id: unknown }).id, x])) : null;
    return b.map((item, i) => {
      const from = byId ? byId.get((item as { id: unknown }).id) : a[i];
      return from === undefined ? item : interpolate(from, item, t);
    }) as T;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(b)) {
      const from = (a as Record<string, unknown>)[key];
      const to = (b as Record<string, unknown>)[key];
      out[key] = from === undefined ? to : interpolate(from, to, t);
    }
    return out as T;
  }
  return b;
}

/**
 * Smooth rendering between server states: `push` each state as it arrives (from `onState`), then
 * every frame draw `sample()`: the state as it was `delayMs` ago (default 100 ms, two ticks at
 * 20 Hz), interpolated between the two states around that moment.
 */
export function createStateBuffer<T>(opts: { delayMs?: number; now?: () => number } = {}) {
  const delay = opts.delayMs ?? 100;
  const now = opts.now ?? (() => performance.now());
  let states: { at: number; state: T }[] = [];
  /** Local clock minus server clock, from the state that arrived fastest. */
  let offset: number | null = null;
  return {
    push(state: T, meta: StateMeta): void {
      const arrived = now();
      const guess = arrived - meta.serverTime;
      offset = offset === null ? guess : Math.min(offset, guess);
      // Unordered delivery: an older state than the newest we have is of no use.
      if (states.length && meta.serverTime <= states[states.length - 1]!.at) return;
      states.push({ at: meta.serverTime, state });
      if (states.length > 32) states = states.slice(-32);
    },
    /** The state to draw now, or undefined before the first one arrives. */
    sample(): T | undefined {
      if (!states.length || offset === null) return undefined;
      const want = now() - offset - delay;
      const first = states[0]!;
      if (want <= first.at) return first.state;
      for (let i = 1; i < states.length; i++) {
        const b = states[i]!;
        if (want <= b.at) {
          const a = states[i - 1]!;
          return interpolate(a.state, b.state, (want - a.at) / (b.at - a.at));
        }
      }
      return states[states.length - 1]!.state;
    },
    clear(): void {
      states = [];
      offset = null;
    },
  };
}
