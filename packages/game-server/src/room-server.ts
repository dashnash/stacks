/**
 * One room's server: signaling over the realtime channels, join tickets, peers, the room's status
 * and results in the app's table. Transport-agnostic: Fargate gives it AppSync signaling, WebRTC
 * peers and DynamoDB; the browser demo gives it the demo bus, in-page peers and its memory store.
 */
import {
  openEnvelope,
  readGameTicket,
  roomChannels,
  roomKeys,
  seatId,
  type IceCandidateInit,
  type Item,
  type RoomServerRecord,
  type Store,
  type ToPlayerSignal,
  type ToServerSignal,
} from '@stacks/api';
import { GameHost, type GameDefinition, type GamePlayer, type PlayerConnection, type PlayerLink } from './game';
import type { ServerEvent } from './protocol';

/** The server's end of the realtime channels. */
export interface Signaling {
  /** Start listening; resolves once the subscription is live. Returns the unsubscribe. */
  subscribe(channel: string, onEvent: (data: unknown) => void): Promise<() => void>;
  publish(channel: string, data: unknown): Promise<void>;
}

/** What a peer tells the room server. */
export interface PeerHooks {
  /** Both data channels are open. */
  onOpen(link: PlayerLink): void;
  /** A message on the unreliable channel. */
  onState(raw: string): void;
  /** A message on the reliable channel. */
  onEvent(raw: string): void;
  /** The connection failed or closed (also after `close()`; called at most once). */
  onClosed(): void;
  /** A local ICE candidate to trickle to the client (peers that put them all in the answer never call it). */
  onCandidate?(candidate: IceCandidateInit): void;
}

/** One connection attempt from a player (a WebRTC peer connection, or the demo's stand-in). */
export interface ServerPeer {
  /** Take the client's offer and return the answer SDP. */
  answer(offerSdp: string): Promise<string>;
  addCandidate(candidate: IceCandidateInit): Promise<void>;
  close(): void;
}

export type PeerFactory = (hooks: PeerHooks) => ServerPeer;

export interface RoomServerOptions<S, E, V> {
  roomId: string;
  game: GameDefinition<S, E, V>;
  store: Store;
  signaling: Signaling;
  peers: PeerFactory;
  /** The app's game key (join tickets are signed with it). */
  key: () => Promise<string>;
  /** The manifest's limits. */
  maxPlayers: number;
  idleMs: number;
  maxMs: number;
  /**
   * A pre-warmed room (META `warm`) that nobody takes within this long ends as `unused` (the
   * manifest's `warmMinutes`). Taken rooms, and rooms that were never warm, keep only the idle limit.
   */
  unusedMs?: number;
  /** Wall clock in milliseconds (ticket expiry, timestamps). Default `Date.now`. */
  now?: () => number;
  /** Monotonic milliseconds for the simulation. Default `performance.now`. */
  monotonic?: () => number;
  /** How the tick loop is driven. Default `setInterval`; tests pass their own and call `advance()`. */
  every?: (ms: number, fn: () => void) => () => void;
  /** How long to let "game over" reach players before closing their connections. Default 500 ms. */
  lingerMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

/** How often a warm room's server checks whether it has been taken. */
export const WARM_POLL_MS = 15_000;
/** A connection attempt that isn't open within this long is dropped. */
export const PEER_OPEN_TIMEOUT_MS = 30_000;
/** Offers one seat may send per 10 s (reconnect storms, or someone poking at the server). */
const OFFERS_PER_WINDOW = 6;
/** Offers one person may send per 10 s across all their devices. */
const USER_OFFERS_PER_WINDOW = 12;
const OFFER_WINDOW_MS = 10_000;
const MAX_CANDIDATES_PER_PEER = 40;

interface Attempt {
  sid: string;
  player: GamePlayer;
  peer: ServerPeer;
  connection: PlayerConnection | null;
  candidates: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
}

const isString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Runs a room from "the task is up" to "the game is over". */
export class RoomServer<S = unknown, E = unknown, V = unknown> {
  /** Set once `start()` has opened the room. */
  host: GameHost<S, E, V> | null = null;
  /** Resolves when the room has ended and everything is written and closed. */
  readonly done: Promise<{ reason: string; results?: unknown }>;
  private finish!: (end: { reason: string; results?: unknown }) => void;
  private readonly attempts = new Map<string, Attempt>();
  private readonly offers = new Map<string, number[]>();
  private unsubscribe: (() => void) | null = null;
  private stopLoop: (() => void) | null = null;
  private watchingWarm = false;
  private checkingWarm = false;
  private nextWarmCheck = 0;
  private readonly now: () => number;
  private readonly log: (message: string, detail?: unknown) => void;

  constructor(private readonly opts: RoomServerOptions<S, E, V>) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.done = new Promise((resolve) => (this.finish = resolve));
  }

  /**
   * Open the room: listen for offers, then mark it `open` and tell the lobby. False (and nothing
   * started) when the room no longer exists or was ended while the server was starting.
   */
  async start(): Promise<boolean> {
    const { roomId, store } = this.opts;
    const meta = await store.get<Item & { status?: string; maxPlayers?: number; warm?: boolean }>(roomKeys.meta(roomId).PK, roomKeys.meta(roomId).SK);
    if (!meta || meta.status === 'ended') {
      this.log(`room ${roomId} is ${meta ? 'already over' : 'unknown'}; nothing to run`);
      return false;
    }
    const monotonic = this.opts.monotonic ?? (() => performance.now());
    const host = new GameHost(this.opts.game, {
      roomId,
      now: monotonic,
      maxPlayers: Math.min(this.opts.maxPlayers, meta.maxPlayers ?? this.opts.maxPlayers),
      idleMs: this.opts.idleMs,
      maxMs: this.opts.maxMs,
      onEnd: (end) => void this.shutdown(end),
      onPlayerGone: (player) => void store.delete(roomKeys.player(roomId, player.id).PK, roomKeys.player(roomId, player.id).SK).catch((err) => this.log('player record not removed', err)),
      log: this.log,
    });
    this.host = host;
    this.watchingWarm = !!meta.warm && this.opts.unusedMs !== undefined;
    host.holdIdle(this.watchingWarm);
    this.unsubscribe = await this.opts.signaling.subscribe(roomChannels.toServer(roomId), (data) => void this.onSignal(data));
    await this.writeStatus({ status: 'open', openedAt: new Date(this.now()).toISOString() });
    await this.opts.signaling.publish(roomChannels.room(roomId), { status: 'open' }).catch((err) => this.log('open not announced', err));
    const every = this.opts.every ?? ((ms, fn) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    });
    this.stopLoop = every(1000 / host.tickHz, () => this.advance());
    this.log(`room ${roomId} is open`);
    return true;
  }

  /** Run the ticks that are due (for callers that drive the loop themselves). */
  advance(): void {
    this.host?.advance();
    this.checkWarm();
  }

  /**
   * A warm room is checked every {@link WARM_POLL_MS} until someone joins. Once its creator's
   * `POST /rooms` has taken it (META no longer warm), its idle clock starts again, so a Play late in
   * the warm window isn't cut short. Untaken after `unusedMs`, it ends as `unused`.
   */
  private checkWarm(): void {
    const host = this.host;
    if (!this.watchingWarm || this.checkingWarm || !host) return;
    if (host.joinedAny) {
      this.watchingWarm = false;
      host.holdIdle(false);
      return;
    }
    const age = host.ageMs;
    if (age < this.nextWarmCheck) return;
    this.checkingWarm = true;
    const { PK, SK } = roomKeys.meta(this.opts.roomId);
    void this.opts.store
      .get<Item & { warm?: boolean; status?: string }>(PK, SK)
      .then((m) => {
        if (host.joinedAny || host.ended) {
          this.watchingWarm = false;
          host.holdIdle(false);
        } else if (!m || m.status === 'ended') {
          // Ended by the API (and its stop didn't reach us): end here too.
          this.watchingWarm = false;
          host.end('stopped');
        } else if (!m.warm) {
          // Taken: its players are on their way, so the idle clock starts now.
          this.watchingWarm = false;
          host.touch();
          host.holdIdle(false);
        } else if (age >= this.opts.unusedMs!) {
          this.watchingWarm = false;
          host.end('unused');
        } else this.nextWarmCheck = Math.min(age + WARM_POLL_MS, this.opts.unusedMs!);
      })
      .catch((err) => {
        this.nextWarmCheck = age + WARM_POLL_MS;
        // Can't tell whether it was taken: past its warm time, let the idle limit end it in the end.
        if (age >= this.opts.unusedMs!) host.holdIdle(false);
        this.log('warm room not checked', err);
      })
      .finally(() => (this.checkingWarm = false));
  }

  /** End the room from outside (the task was told to stop). */
  stop(reason = 'stopped'): void {
    if (this.host) this.host.end(reason);
    else void this.shutdown({ reason });
  }

  private async onSignal(data: unknown): Promise<void> {
    // Clients publish through the web SDK, which wraps data in its envelope; the demo passes data bare.
    const msg = (openEnvelope(data)?.d ?? data) as Partial<ToServerSignal> | null;
    if (!msg || typeof msg !== 'object' || !isString(msg.sid, 64)) return;
    try {
      if (msg.t === 'offer') await this.onOffer(msg as Extract<ToServerSignal, { t: 'offer' }>);
      else if (msg.t === 'ice') await this.onCandidate(msg as Extract<ToServerSignal, { t: 'ice' }>);
    } catch (err) {
      this.log('signal not handled', err);
    }
  }

  private async onOffer(msg: Extract<ToServerSignal, { t: 'offer' }>): Promise<void> {
    const host = this.host;
    if (!host || !isString(msg.sdp, 8192) || !isString(msg.ticket, 2048)) return;
    const { roomId } = this.opts;
    // The ticket says who this is. Forged, or for another room: no answer at all.
    const ticket = await readGameTicket(await this.opts.key(), msg.ticket);
    if (!ticket || ticket.roomId !== roomId) {
      this.log('offer with a bad ticket ignored');
      return;
    }
    // One seat per (user, device). Answers go to the user's channel: the client's `sid` tells
    // their devices' connections apart.
    const player: GamePlayer = { id: seatId(ticket.userId, ticket.device), userId: ticket.userId, device: ticket.device, name: ticket.name };
    const refuse = (reason: string) => this.toPlayer(player.userId, { t: 'refused', sid: msg.sid, reason });
    if (ticket.exp * 1000 <= this.now()) return refuse('ticket');
    if (host.ended) return refuse('ended');
    const full = host.wouldRefuse(player);
    if (full) {
      this.forgetSeat(player);
      return refuse(full);
    }

    const now = this.now();
    const recent = (this.offers.get(player.id) ?? []).filter((at) => now - at < OFFER_WINDOW_MS);
    const userKey = `user:${player.userId}`;
    const recentForUser = (this.offers.get(userKey) ?? []).filter((at) => now - at < OFFER_WINDOW_MS);
    if (recent.length >= OFFERS_PER_WINDOW || recentForUser.length >= USER_OFFERS_PER_WINDOW) return refuse('busy');
    this.offers.set(player.id, [...recent, now]);
    this.offers.set(userKey, [...recentForUser, now]);

    // One attempt per seat: a new offer replaces whatever it had going (not its live connection,
    // which the host swaps when the new one opens). The person's other devices are left alone.
    for (const a of [...this.attempts.values()]) if (a.player.id === player.id && !a.connection) this.closeAttempt(a);
    if (this.attempts.has(msg.sid)) return;

    const attempt: Attempt = { sid: msg.sid, player, peer: undefined as unknown as ServerPeer, connection: null, candidates: 0, timer: undefined, closed: false };
    attempt.peer = this.opts.peers({
      onOpen: (link) => {
        if (attempt.closed) return;
        clearTimeout(attempt.timer);
        const result = host.connect(player, link);
        if ('refused' in result) {
          if (result.refused !== 'ended') this.forgetSeat(player);
          link.event(JSON.stringify({ over: { reason: result.refused } } satisfies ServerEvent));
          setTimeout(() => this.closeAttempt(attempt), this.opts.lingerMs ?? 500);
          return;
        }
        attempt.connection = result;
      },
      onState: (raw) => attempt.connection?.input(raw),
      onEvent: (raw) => attempt.connection?.message(raw),
      onClosed: () => {
        attempt.connection?.dropped();
        attempt.connection = null;
        this.closeAttempt(attempt);
      },
      onCandidate: (c) => void this.toPlayer(player.userId, { t: 'ice', sid: msg.sid, c }),
    });
    this.attempts.set(msg.sid, attempt);
    attempt.timer = setTimeout(() => {
      if (!attempt.connection) this.closeAttempt(attempt);
    }, PEER_OPEN_TIMEOUT_MS);
    try {
      const sdp = await attempt.peer.answer(msg.sdp);
      if (!attempt.closed) await this.toPlayer(player.userId, { t: 'answer', sid: msg.sid, sdp });
    } catch (err) {
      this.log('offer not answered', err);
      this.closeAttempt(attempt);
      await refuse('error');
    }
  }

  private async onCandidate(msg: Extract<ToServerSignal, { t: 'ice' }>): Promise<void> {
    const attempt = this.attempts.get(msg.sid);
    const c = msg.c;
    if (!attempt || attempt.closed || !c || typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > 1024) return;
    if (++attempt.candidates > MAX_CANDIDATES_PER_PEER) return;
    await attempt.peer.addCandidate({
      candidate: c.candidate,
      ...(typeof c.sdpMid === 'string' ? { sdpMid: c.sdpMid } : {}),
      ...(typeof c.sdpMLineIndex === 'number' ? { sdpMLineIndex: c.sdpMLineIndex } : {}),
      ...(typeof c.usernameFragment === 'string' ? { usernameFragment: c.usernameFragment } : {}),
    });
  }

  /**
   * A seat the API handed out but the game turned away (`full`, or `seats` past `maxSeatsPerUser`):
   * drop its record so it doesn't keep counting against the room. Never one that is in the game.
   */
  private forgetSeat(player: GamePlayer): void {
    if (this.host?.players.some((p) => p.id === player.id)) return;
    const key = roomKeys.player(this.opts.roomId, player.id);
    void this.opts.store.delete(key.PK, key.SK).catch((err) => this.log('player record not removed', err));
  }

  private closeAttempt(attempt: Attempt): void {
    if (attempt.closed) return;
    attempt.closed = true;
    clearTimeout(attempt.timer);
    this.attempts.delete(attempt.sid);
    try {
      attempt.peer.close();
    } catch (err) {
      this.log('peer not closed', err);
    }
  }

  private toPlayer(userId: string, signal: ToPlayerSignal): Promise<void> {
    return this.opts.signaling.publish(roomChannels.toPlayer(this.opts.roomId, userId), signal).catch((err) => this.log('signal not sent', err));
  }

  private async writeStatus(record: RoomServerRecord): Promise<void> {
    const key = roomKeys.server(this.opts.roomId);
    const before = await this.opts.store.get<Item & RoomServerRecord>(key.PK, key.SK);
    await this.opts.store.put({ ...key, ...(before?.openedAt ? { openedAt: before.openedAt } : {}), ...record });
  }

  /** The game is over: record it, tell watchers, give "game over" a moment to arrive, close everything. */
  private async shutdown(end: { reason: string; results?: unknown }): Promise<void> {
    this.stopLoop?.();
    this.stopLoop = null;
    const { roomId } = this.opts;
    try {
      await this.writeStatus({ status: 'ended', endedAt: new Date(this.now()).toISOString(), reason: end.reason, ...(end.results !== undefined ? { results: end.results } : {}) });
    } catch (err) {
      this.log('results not written', err);
    }
    await this.opts.signaling.publish(roomChannels.room(roomId), { status: 'ended' }).catch((err) => this.log('end not announced', err));
    await new Promise((resolve) => setTimeout(resolve, this.opts.lingerMs ?? 500));
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const a of [...this.attempts.values()]) this.closeAttempt(a);
    this.log(`room ${roomId} ended: ${end.reason}`);
    this.finish(end);
  }
}
