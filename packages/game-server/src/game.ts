/**
 * The game core: `defineGame` and the host that runs one room of it. Transport-agnostic and
 * browser-safe: the same code runs in Fargate (WebRTC peers), in tests (fake players, fake clock)
 * and in the browser demo. The server is the authority: clients only send input and render.
 */
import {
  CLIENT_MESSAGE_MAX_BYTES,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_WARN_BYTES,
  type ClientEvent,
  type InputMessage,
  type PlayerInfo,
  type ServerEvent,
  type StateMessage,
} from './protocol';

export type GamePlayer = PlayerInfo;

/** The room, as the game sees it: who is here, and the ways to reach them reliably. */
export interface GameRoom<E = unknown> {
  readonly id: string;
  /** Every seat in the room (including one whose connection dropped less than 20 s ago). */
  readonly players: readonly GamePlayer[];
  /** Milliseconds since the room started. */
  readonly elapsedMs: number;
  /** Send `event` to everyone on the reliable channel (joins, bumps, "round over"). */
  broadcast(event: E): void;
  /** Send `event` to one seat (`player.id`) on the reliable channel. */
  send(playerId: string, event: E): void;
  /** End the game now. `results` (any JSON) are written to the room record. */
  end(results?: unknown): void;
}

/**
 * A game, as an app writes it in `apps/<slug>/game/server.ts`. `S` is the room's state (it lives in
 * the server's memory and is never sent as is); `V` is what `snapshot` sends each player.
 */
export interface GameDefinition<S = unknown, E = unknown, V = unknown> {
  /** Simulation and snapshot rate, 1-60. Default 20. */
  tickHz?: number;
  /** Seats per room; the manifest's `gameServer.maxPlayers` is the ceiling. */
  maxPlayers?: number;
  /** Seats one person may hold (one per device: a screen and a phone is 2), 1-4. Default 4 (the API's ceiling). */
  maxSeatsPerUser?: number;
  /** Inputs accepted per player per second; more are dropped. Default 60. */
  inputsPerSecond?: number;
  /** Events accepted per player per second. Default 20. */
  eventsPerSecond?: number;
  /** Make the room's state. Keep `room` if the game sends events or ends itself. */
  init(room: GameRoom<E>): S;
  onJoin?(state: S, player: GamePlayer): void;
  /** They left, or their connection dropped and they did not come back within 20 s. */
  onLeave?(state: S, player: GamePlayer): void;
  /** Input from a player (the fast, lossy path). It comes from a browser: check its shape. */
  onInput?(state: S, player: GamePlayer, input: unknown): void;
  /** An event from a player (the reliable path). It comes from a browser: check its shape. */
  onEvent?(state: S, player: GamePlayer, event: unknown): void;
  /** Advance the simulation by `dt` seconds (always `1 / tickHz`). */
  tick?(state: S, dt: number): void;
  /** What this player should see. Sent every tick, unreliably: keep it under ~1 KB. */
  snapshot(state: S, forPlayer: GamePlayer): V;
  /** What to record when the room ends without `room.end(results)` (idle, time limit, stopped). */
  results?(state: S): unknown;
}

export const DEFAULT_TICK_HZ = 20;
export const DEFAULT_INPUTS_PER_SECOND = 60;
export const DEFAULT_EVENTS_PER_SECOND = 20;
/** A dropped player's slot is kept this long. */
export const REJOIN_GRACE_MS = 20_000;
/** After a stall, at most this many ticks are run to catch up; the rest of the lost time is skipped. */
export const MAX_CATCH_UP_TICKS = 5;
/** This many ticks failing in a row ends the room with `error`. */
const MAX_TICK_FAILURES = 50;

/** Check a game definition and return it (typed). `export default defineGame({ … })` in `game/server.ts`. */
export function defineGame<S, E = unknown, V = unknown>(game: GameDefinition<S, E, V>): GameDefinition<S, E, V> {
  const range = (name: string, value: number | undefined, min: number, max: number) => {
    if (value !== undefined && (!Number.isFinite(value) || value < min || value > max)) throw new Error(`defineGame: ${name} must be from ${min} to ${max}`);
  };
  range('tickHz', game.tickHz, 1, 60);
  range('maxPlayers', game.maxPlayers, 1, 16);
  range('maxSeatsPerUser', game.maxSeatsPerUser, 1, 4);
  range('inputsPerSecond', game.inputsPerSecond, 1, 240);
  range('eventsPerSecond', game.eventsPerSecond, 1, 120);
  if (typeof game.init !== 'function' || typeof game.snapshot !== 'function') throw new Error('defineGame: a game needs init(room) and snapshot(state, forPlayer)');
  return game;
}

/** How the host reaches one connected player. The transport (WebRTC, the demo, a test) implements it. */
export interface PlayerLink {
  /** Send on the unreliable channel. May drop. */
  state(json: string): void;
  /** Send on the reliable channel. */
  event(json: string): void;
  /** Close the connection (after "game over", or when another connection takes the slot). */
  close(): void;
}

/** What the transport calls as a player's messages arrive. */
export interface PlayerConnection {
  /** A message on the unreliable channel. */
  input(raw: string): void;
  /** A message on the reliable channel. */
  message(raw: string): void;
  /** The connection is gone (the slot is kept for 20 s). */
  dropped(): void;
}

export interface GameHostOptions {
  roomId: string;
  /** Milliseconds, monotonic. Tests pass a fake clock. */
  now: () => number;
  /** The room's ceiling (the manifest's); the game's own `maxPlayers` can only lower it. */
  maxPlayers: number;
  /** End after this long with no input or event from anyone. */
  idleMs: number;
  /** End after this long whatever happens. */
  maxMs: number;
  rejoinGraceMs?: number;
  /** The room ended: write results, tell watchers, shut down. Called once. */
  onEnd?(end: { reason: string; results?: unknown }): void;
  /** A seat was freed (its player left, or dropped and did not return). */
  onPlayerGone?(player: GamePlayer): void;
  log?: (message: string, detail?: unknown) => void;
}

/** A token bucket: `rate` per second, bursts up to one second's worth. */
class Bucket {
  private tokens: number;
  private at: number;
  constructor(
    private readonly rate: number,
    now: number,
  ) {
    this.tokens = rate;
    this.at = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

interface Slot {
  player: GamePlayer;
  link: PlayerLink | null;
  droppedAt: number | null;
  inputs: Bucket;
  events: Bucket;
  pings: Bucket;
}

const bytes = (text: string) => (text.length * 3 < CLIENT_MESSAGE_MAX_BYTES ? 0 : new TextEncoder().encode(text).length);

/** Runs one room of a game: players, the fixed-timestep loop, rate limits, the idle and time limits. */
export class GameHost<S = unknown, E = unknown, V = unknown> {
  readonly tickHz: number;
  readonly maxPlayers: number;
  private readonly slots = new Map<string, Slot>();
  private readonly state: S;
  private readonly room: GameRoom<E>;
  private readonly startedAt: number;
  private readonly stepMs: number;
  private readonly graceMs: number;
  private lastAdvance: number;
  private lastActivity: number;
  private owed = 0;
  private tickNumber = 0;
  private tickFailures = 0;
  private warnedSize = false;
  private over: { reason: string; results?: unknown } | null = null;

  constructor(
    private readonly game: GameDefinition<S, E, V>,
    private readonly opts: GameHostOptions,
  ) {
    this.tickHz = game.tickHz ?? DEFAULT_TICK_HZ;
    this.maxPlayers = Math.min(opts.maxPlayers, game.maxPlayers ?? opts.maxPlayers);
    this.stepMs = 1000 / this.tickHz;
    this.graceMs = opts.rejoinGraceMs ?? REJOIN_GRACE_MS;
    this.startedAt = this.lastAdvance = this.lastActivity = opts.now();
    const host = this;
    this.room = {
      id: opts.roomId,
      get players() {
        return host.players;
      },
      get elapsedMs() {
        return opts.now() - host.startedAt;
      },
      broadcast: (event) => this.toAll({ event }),
      send: (playerId, event) => this.slots.get(playerId)?.link?.event(JSON.stringify({ event } satisfies ServerEvent)),
      end: (results) => this.end('finished', results),
    };
    this.state = game.init(this.room);
  }

  /** Why a seat that isn't in the room yet can't join it now (`full`, or `seats`: its person holds as many as the game allows). */
  wouldRefuse(player: Pick<GamePlayer, 'id' | 'userId'>): 'full' | 'seats' | null {
    if (this.slots.has(player.id)) return null;
    if (this.slots.size >= this.maxPlayers) return 'full';
    const cap = this.game.maxSeatsPerUser;
    if (cap !== undefined && [...this.slots.values()].filter((s) => s.player.userId === player.userId).length >= cap) return 'seats';
    return null;
  }

  get players(): GamePlayer[] {
    return [...this.slots.values()].map((s) => s.player);
  }

  /** Players with a live connection right now. */
  get connected(): number {
    return [...this.slots.values()].filter((s) => s.link).length;
  }

  get ended(): { reason: string; results?: unknown } | null {
    return this.over;
  }

  /** The tick the simulation is at. */
  get tick(): number {
    return this.tickNumber;
  }

  /**
   * A connection for a seat is up. A seat already in the room (dropped, or the same person and
   * device connecting again from another tab) is taken back with no `onJoin`; the old connection is
   * closed. Another device of the same person is a seat of its own.
   */
  connect(player: GamePlayer, link: PlayerLink): PlayerConnection | { refused: 'full' | 'seats' | 'ended' } {
    if (this.over) return { refused: 'ended' };
    const now = this.opts.now();
    let slot = this.slots.get(player.id);
    const rejoined = !!slot;
    if (slot) {
      const old = slot.link;
      slot.link = link;
      slot.droppedAt = null;
      slot.player.name = player.name;
      if (old && old !== link) this.safely('close', () => old.close());
    } else {
      const refused = this.wouldRefuse(player);
      if (refused) return { refused };
      slot = {
        player: { id: player.id, userId: player.userId, device: player.device, name: player.name },
        link,
        droppedAt: null,
        inputs: new Bucket(this.game.inputsPerSecond ?? DEFAULT_INPUTS_PER_SECOND, now),
        events: new Bucket(this.game.eventsPerSecond ?? DEFAULT_EVENTS_PER_SECOND, now),
        pings: new Bucket(5, now),
      };
      this.slots.set(player.id, slot);
      this.safely('onJoin', () => this.game.onJoin?.(this.state, slot!.player));
    }
    this.lastActivity = now;
    link.event(JSON.stringify({ welcome: { you: slot.player, players: this.players, tickHz: this.tickHz, rejoined } } satisfies ServerEvent));
    if (!rejoined) this.toAll({ players: this.players }, slot);
    const mine = slot;
    return {
      input: (raw) => {
        if (this.over || mine.link !== link || bytes(raw) > CLIENT_MESSAGE_MAX_BYTES) return;
        const now = this.opts.now();
        if (!mine.inputs.take(now)) return;
        const msg = parse<InputMessage>(raw);
        if (!msg || !('i' in msg)) return;
        this.lastActivity = now;
        this.safely('onInput', () => this.game.onInput?.(this.state, mine.player, msg.i));
      },
      message: (raw) => {
        if (this.over || mine.link !== link || bytes(raw) > CLIENT_MESSAGE_MAX_BYTES) return;
        const now = this.opts.now();
        const msg = parse<Partial<{ event: unknown; ping: number; leave: boolean }> & ClientEvent>(raw);
        if (!msg) return;
        if ('ping' in msg && typeof msg.ping === 'number') {
          if (mine.pings.take(now)) link.event(JSON.stringify({ pong: msg.ping } satisfies ServerEvent));
        } else if ('leave' in msg && msg.leave === true) {
          this.remove(mine);
          this.safely('close', () => link.close());
        } else if ('event' in msg) {
          if (!mine.events.take(now)) return;
          this.lastActivity = now;
          this.safely('onEvent', () => this.game.onEvent?.(this.state, mine.player, msg.event));
        }
      },
      dropped: () => {
        if (mine.link !== link || !this.slots.has(mine.player.id)) return;
        mine.link = null;
        mine.droppedAt = this.opts.now();
      },
    };
  }

  /**
   * Run the ticks that are due (call it from a timer, about once per tick). After a stall it runs
   * at most {@link MAX_CATCH_UP_TICKS} and skips the rest, so a long pause never becomes a burst.
   */
  advance(): void {
    if (this.over) return;
    const now = this.opts.now();
    this.owed += now - this.lastAdvance;
    this.lastAdvance = now;

    for (const slot of [...this.slots.values()]) {
      if (slot.droppedAt !== null && now - slot.droppedAt >= this.graceMs) this.remove(slot);
    }

    let due = Math.floor(this.owed / this.stepMs + 1e-9);
    if (due > MAX_CATCH_UP_TICKS) {
      this.owed = MAX_CATCH_UP_TICKS * this.stepMs;
      due = MAX_CATCH_UP_TICKS;
    }
    for (let i = 0; i < due && !this.over; i++) {
      this.owed -= this.stepMs;
      this.tickNumber++;
      try {
        this.game.tick?.(this.state, 1 / this.tickHz);
        this.tickFailures = 0;
      } catch (err) {
        this.opts.log?.('tick threw', err);
        if (++this.tickFailures >= MAX_TICK_FAILURES) this.end('error');
      }
    }
    if (this.over) return;
    if (due > 0) this.sendSnapshots(now);

    if (now - this.startedAt >= this.opts.maxMs) this.end('time');
    else if (now - this.lastActivity >= this.opts.idleMs) this.end('idle');
  }

  /** End the room: everyone gets "game over" on the reliable channel, then `onEnd` runs. Once. */
  end(reason: string, results?: unknown): void {
    if (this.over) return;
    let final = results;
    if (final === undefined && this.game.results) {
      try {
        final = this.game.results(this.state);
      } catch (err) {
        this.opts.log?.('results threw', err);
      }
    }
    this.over = { reason, ...(final !== undefined ? { results: final } : {}) };
    this.toAll({ over: this.over });
    this.opts.onEnd?.(this.over);
  }

  private sendSnapshots(now: number): void {
    for (const slot of this.slots.values()) {
      if (!slot.link) continue;
      let json: string;
      try {
        json = JSON.stringify({ n: this.tickNumber, t: Math.round(now - this.startedAt), s: this.game.snapshot(this.state, slot.player) } satisfies StateMessage);
      } catch (err) {
        this.opts.log?.('snapshot threw', err);
        continue;
      }
      if (json.length > SNAPSHOT_WARN_BYTES && !this.warnedSize) {
        this.warnedSize = true;
        this.opts.log?.(`snapshot is ${json.length} characters: over ~${SNAPSHOT_WARN_BYTES} it is split across packets and lost more often`);
      }
      if (json.length > SNAPSHOT_MAX_BYTES) continue;
      this.safely('send', () => slot.link?.state(json));
    }
  }

  private remove(slot: Slot): void {
    if (this.slots.get(slot.player.id) !== slot) return;
    this.slots.delete(slot.player.id);
    slot.link = null;
    this.safely('onLeave', () => this.game.onLeave?.(this.state, slot.player));
    this.toAll({ players: this.players });
    this.safely('onPlayerGone', () => this.opts.onPlayerGone?.(slot.player));
  }

  private toAll(event: ServerEvent, except?: Slot): void {
    const json = JSON.stringify(event);
    for (const slot of this.slots.values()) {
      if (slot === except || !slot.link) continue;
      this.safely('send', () => slot.link?.event(json));
    }
  }

  /** A game callback or a link that throws must not take the room down. */
  private safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.log?.(`${what} threw`, err);
    }
  }
}

function parse<T>(raw: string): T | null {
  try {
    const value = JSON.parse(raw) as T;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
