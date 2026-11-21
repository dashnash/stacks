import { GameHost, type GameDefinition, type GamePlayer, type PlayerConnection, type PlayerInfo, type ServerEvent, type StateMessage } from '@stacks/game-server';
import { DEFAULT_DEVICE, fixtureUserId, seatId } from '@stacks/api';

export interface PlayGameOptions {
  roomId?: string;
  /** The manifest's ceiling. Default 8. */
  maxPlayers?: number;
  /** Default 10. */
  idleMinutes?: number;
  /** Default 2. */
  maxHours?: number;
  /** The manifest's `warmMinutes`: end `unused` when nobody joins within it. Default: no such limit. */
  warmMinutes?: number;
}

/** A fake player in a {@link playGame} room: what the server sent them, and ways to act. */
export interface TestPlayer<V = unknown> {
  /** The seat id: the user id, or `<userId>~<device>` for a join with a device. */
  readonly id: string;
  readonly userId: string;
  readonly device: string;
  readonly name: string;
  /** Every snapshot received, oldest first (`state` is the latest). */
  readonly states: V[];
  readonly state: V | undefined;
  /** Tick number of the latest snapshot. */
  readonly tick: number;
  /** Game events received (`room.broadcast` / `room.send`), oldest first. */
  readonly events: unknown[];
  /** The roster as last told. */
  readonly roster: PlayerInfo[];
  /** Set on (re)connect: `rejoined` is true when the slot was kept. */
  readonly welcome: { you: PlayerInfo; players: PlayerInfo[]; tickHz: number; rejoined: boolean } | undefined;
  /** "Game over", once received. */
  readonly over: { reason: string; results?: unknown } | undefined;
  /** Whether the server closed this connection. */
  readonly closed: boolean;
  /** Send input (the unreliable path). */
  input(input: unknown): void;
  /** Send an event (the reliable path). */
  event(event: unknown): void;
  /** Ping; resolves nothing, see `pongs`. */
  ping(stamp: number): void;
  readonly pongs: number[];
  /** Leave for good (`onLeave` runs now). */
  leave(): void;
  /** Lose the connection (the slot is kept for 20 s). */
  drop(): void;
  /** Connect again as the same person and device (the same seat). */
  rejoin(): void;
  /** Send raw text on a channel (to test what a hand-made client could send). */
  raw(channel: 'state' | 'events', text: string): void;
}

/**
 * Run a `defineGame` in memory with fake players and a fake clock:
 *
 *   const g = playGame(game);
 *   const ann = g.join('ann@test.dev');
 *   const annsPhone = g.join('ann@test.dev', { device: 'gun' });   // a second seat for Ann
 *   ann.input({ x: 0.5, y: 0.5 });
 *   g.advance(1000);                 // one second of ticks
 *   expect(ann.state).toMatchObject({ … });
 */
export function playGame<S, E, V>(game: GameDefinition<S, E, V>, opts: PlayGameOptions = {}) {
  let now = 0;
  let ended: { reason: string; results?: unknown } | undefined;
  const gone: GamePlayer[] = [];
  const logs: string[] = [];
  const host = new GameHost(game, {
    roomId: opts.roomId ?? 'test-room',
    now: () => now,
    maxPlayers: opts.maxPlayers ?? 8,
    idleMs: (opts.idleMinutes ?? 10) * 60_000,
    maxMs: (opts.maxHours ?? 2) * 3_600_000,
    ...(opts.warmMinutes !== undefined ? { unusedMs: opts.warmMinutes * 60_000 } : {}),
    onEnd: (end) => (ended = end),
    onPlayerGone: (p) => gone.push(p),
    log: (message, detail) => logs.push(detail === undefined ? message : `${message}: ${String(detail)}`),
  });
  const stepMs = 1000 / host.tickHz;

  /**
   * Connect a seat: `who` is an email (or `{ id, name }` with a user id), `device` a label as the
   * app would pass to `useGameRoom` (default `default`: the seat id is then the user id).
   */
  function join(who: string | { id: string; name: string; device?: string }, opts: { device?: string } = {}): TestPlayer<V> {
    const userId = typeof who === 'string' ? fixtureUserId(who) : who.id;
    const name = typeof who === 'string' ? who.split('@')[0]! : who.name;
    const device = opts.device ?? (typeof who === 'string' ? undefined : who.device) ?? DEFAULT_DEVICE;
    const person: GamePlayer = { id: seatId(userId, device), userId, device, name };
    const seen = {
      states: [] as V[],
      tick: 0,
      events: [] as unknown[],
      roster: [] as PlayerInfo[],
      welcome: undefined as TestPlayer['welcome'],
      over: undefined as TestPlayer['over'],
      closed: false,
      pongs: [] as number[],
    };
    let connection: PlayerConnection | null = null;
    const connect = () => {
      seen.closed = false;
      const link = {
        state: (json: string) => {
          const m = JSON.parse(json) as StateMessage;
          seen.states.push(m.s as V);
          seen.tick = m.n;
        },
        event: (json: string) => {
          const m = JSON.parse(json) as ServerEvent;
          if ('welcome' in m) {
            seen.welcome = m.welcome;
            seen.roster = m.welcome.players;
          } else if ('players' in m) seen.roster = m.players;
          else if ('event' in m) seen.events.push(m.event);
          else if ('pong' in m) seen.pongs.push(m.pong);
          else if ('over' in m) seen.over = m.over;
        },
        close: () => {
          seen.closed = true;
          if (connection === mine) connection = null;
        },
      };
      const result = host.connect(person, link);
      if ('refused' in result) throw new Error(`join refused: ${result.refused}`);
      const mine = result;
      connection = result;
    };
    connect();
    return {
      id: person.id,
      userId: person.userId,
      device: person.device,
      name: person.name,
      get states() {
        return seen.states;
      },
      get state() {
        return seen.states.at(-1);
      },
      get tick() {
        return seen.tick;
      },
      get events() {
        return seen.events;
      },
      get roster() {
        return seen.roster;
      },
      get welcome() {
        return seen.welcome;
      },
      get over() {
        return seen.over;
      },
      get closed() {
        return seen.closed;
      },
      get pongs() {
        return seen.pongs;
      },
      input: (input) => connection?.input(JSON.stringify({ i: input })),
      event: (event) => connection?.message(JSON.stringify({ event })),
      ping: (stamp) => connection?.message(JSON.stringify({ ping: stamp })),
      leave: () => connection?.message(JSON.stringify({ leave: true })),
      drop: () => {
        connection?.dropped();
        connection = null;
      },
      rejoin: connect,
      raw: (channel, text) => (channel === 'state' ? connection?.input(text) : connection?.message(text)),
    };
  }

  return {
    host,
    join,
    /** Let `ms` of game time pass, one tick at a time (as the server's timer would). */
    advance(ms: number) {
      const end = now + ms;
      while (now + stepMs <= end + 1e-9 && !ended) {
        now += stepMs;
        host.advance();
      }
      if (!ended && now < end) {
        now = end;
        host.advance();
      }
    },
    /** The server freezes for `ms`, then its timer fires once (to test the catch-up cap). */
    stall(ms: number) {
      now += ms;
      host.advance();
    },
    /** How the room ended, once it has. */
    get ended() {
      return ended;
    },
    /** Players whose slot was freed, in order. */
    gone,
    /** What the host logged (callbacks that threw, oversized snapshots). */
    logs,
    get now() {
      return now;
    },
  };
}
