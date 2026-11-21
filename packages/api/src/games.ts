/**
 * The `gameServer` module, API side: rooms (session management in the app's table), join tickets
 * and the signaling channels. Each room has its own server-authoritative game server (one Fargate
 * task running the app's `game/server.ts` on `@stacks/game-server`); players reach it over WebRTC
 * data channels, set up through the `realtime` module. Runs the same in Lambda, in tests and in
 * the browser demo (Web Crypto only). The AWS wiring (ECS, the game key, TURN) is in `games-aws.ts`.
 */
import { gameServerSettings, type AppManifest, type GameServerSettings } from '@stacks/manifest';
import type { AppRoutes } from './app';
import { badRequest, conflict, forbidden, HttpError, notFound, optionalString } from './http';
import type { AppDeps, Viewer } from './model';
import { log } from './log';
import { isUser } from './people';
import { openHmacToken, signHmacToken, type RealtimeChannels } from './realtime';
import { ConditionFailedError, type Item, type Store } from './store';

/** How long a join ticket is good for. The web SDK asks for a fresh one for every (re)connect. */
export const TICKET_TTL_SECONDS = 60;
/** Room codes: 4 characters from an alphabet without look-alikes (no I, L, O, 0, 1). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
/** Ended rooms stay readable this long (results, "this game is over"), then DynamoDB drops them. */
export const ENDED_ROOM_TTL_DAYS = 7;
/** A server still running this long past the room's time limit is stopped by the sweeper. */
export const OVERTIME_GRACE_MS = 5 * 60_000;
/**
 * A warm room this close to its `warmMinutes` isn't picked up by `POST /rooms` (its server would end
 * as `unused` before anyone joined): it is retired and a fresh one starts.
 */
export const WARM_ADOPT_MARGIN_MS = 30_000;
/**
 * A person's warm-up lock holds this long: a second `POST /rooms/warm` meanwhile, while the first is
 * still starting its server, gets 409 `ALREADY_WARMING`. After it, the lock is replaced (by a
 * compare-and-swap), so one left behind by a crash never blocks anyone for longer.
 */
export const WARM_LOCK_MS = 60_000;
/** STUN only: what a join gets when the platform has no TURN key. */
export const STUN_ONLY: IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
/** The platform's TURN key (SSM names under `/stacks/<env>/secrets/platform/`). */
export const TURN_KEY_NAMES = ['CLOUDFLARE_TURN_KEY_ID', 'CLOUDFLARE_TURN_API_TOKEN'] as const;

/** The device of a join that names none: its seat id is the user id, as before devices existed. */
export const DEFAULT_DEVICE = 'default';
/**
 * Seats one person may hold in a room, whatever the game allows (so nobody fills a room by joining
 * under many labels). A game's `maxSeatsPerUser` can only lower it.
 */
export const MAX_SEATS_PER_USER = 4;
/** A device label (chosen by the app: `screen`, `gun`, `gun-2`). */
export const DEVICE_LABEL = /^[a-z0-9-]{1,16}$/;

/**
 * The seat a (user, device) holds in a room: the user id for {@link DEFAULT_DEVICE}, else
 * `<userId>~<device>`. One person can hold several seats (a desktop screen and a phone).
 */
export function seatId(userId: string, device: string = DEFAULT_DEVICE): string {
  return device === DEFAULT_DEVICE ? userId : `${userId}~${device}`;
}

/** A device label from a request body: absent is {@link DEFAULT_DEVICE}, anything not a label is a 400. */
export function deviceLabel(body: Record<string, unknown> | undefined): string {
  const value = body?.device;
  if (value === undefined || value === null) return DEFAULT_DEVICE;
  if (typeof value !== 'string' || !DEVICE_LABEL.test(value)) throw badRequest('"device" must be 1-16 lower-case letters, digits or "-"');
  return value;
}

const ROOMS_INDEX = 'STACKS#ROOMS';
const roomPk = (id: string) => `ROOM#${id}`;
const codePk = (code: string) => `ROOMCODE#${code}`;

/** The SDK's keys for a room (documented under "Keys used by the SDK"). */
export const roomKeys = {
  meta: (id: string) => ({ PK: roomPk(id), SK: 'META' }),
  /** Written only by the room's game server: `open`, then `ended` with results. */
  server: (id: string) => ({ PK: roomPk(id), SK: 'SERVER' }),
  /** One seat (`seatId`: the user id, or `<userId>~<device>`). */
  player: (id: string, seat: string) => ({ PK: roomPk(id), SK: `PLAYER#${seat}` }),
  /** Where a `Games` implementation keeps what it needs to stop the room's server. */
  task: (id: string) => ({ PK: roomPk(id), SK: 'TASK' }),
  code: (code: string) => ({ PK: codePk(code), SK: 'META' }),
  /** Written once (if absent) by whoever takes a warm room: its creator's `POST /rooms`, or the sweeper retiring it. */
  claim: (id: string) => ({ PK: roomPk(id), SK: 'CLAIM' }),
  /** One person's warm-up lock (written if absent, or swapped once expired: two at once start one server). */
  warmLock: (userId: string) => ({ PK: `ROOMWARM#${userId}`, SK: 'LOCK' }),
};

export type RoomStatus = 'starting' | 'open' | 'ended';

/** A room as the API returns it. */
export interface Room {
  id: string;
  /** What people type to join, e.g. `K7QX`. */
  code: string;
  name: string;
  status: RoomStatus;
  createdBy: { id: string; name: string };
  createdAt: string;
  maxPlayers: number;
  /** Seats taken (people who joined and haven't left; one person on two devices holds two). */
  players: number;
  endedAt?: string;
  /** Why it ended: `idle`, `time`, `ended` (by its creator or an approver), `stopped`, `error`. */
  endedReason?: string;
  /** What the game reported when it ended (`room.end(results)` or the game's `results`). */
  results?: unknown;
  /**
   * A pre-warmed room (`POST /rooms/warm`): not listed, not found by code, not joinable. Its
   * creator's next `POST /rooms` takes it over; otherwise it ends as `unused` at `warmUntil`.
   */
  warm?: true;
  warmUntil?: string;
}

interface RoomMeta extends Item {
  id: string;
  code: string;
  name: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  maxPlayers: number;
  /** The API's view; the server's is on {@link RoomServerRecord}. */
  status: 'starting' | 'ended';
  /** Pre-warmed and not taken yet. */
  warm?: boolean;
  endedAt?: string;
  endedReason?: string;
  expiresAt?: number;
}

/** The game server's own record for its room (`roomKeys.server`). Nothing secret goes here. */
export interface RoomServerRecord {
  status: 'open' | 'ended';
  openedAt?: string;
  endedAt?: string;
  reason?: string;
  results?: unknown;
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** What `POST /rooms/:id/join` returns. */
export interface JoinResponse {
  /** Goes in the WebRTC offer; the game server checks it and binds the peer to this seat. */
  ticket: string;
  expiresAt: string;
  iceServers: IceServer[];
  /** The realtime channels for this room and player (`toMe` is per user: your devices share it). */
  channels: { room: string; toServer: string; toMe: string };
  /** Your seat: `id` is the seat id. */
  player: GameSeatInfo;
  room: Room;
}

/** Someone joining a room: a user id and the name the game shows. */
export interface GamePlayerInfo {
  id: string;
  name: string;
}

/** A seat in a room: `id` is the seat id ({@link seatId}), the user id for the `default` device. */
export interface GameSeatInfo extends GamePlayerInfo {
  userId: string;
  device: string;
}

/**
 * What the module gives an app's handlers (`v.deps.games`). The built-in room routes use it; an
 * app that creates rooms its own way can call `start` and `stop` itself.
 */
export interface Games {
  /** Start the room's game server (about 30-60 s until it marks the room `open`). */
  start(roomId: string): Promise<void>;
  /** Stop the room's game server. Stopping one that is already gone is not an error. */
  stop(roomId: string): Promise<void>;
  /** Which of these rooms still have a server (starting or running). */
  running(roomIds: string[]): Promise<Set<string>>;
  /** The key join tickets are signed with (the game server checks them with it). */
  key(): Promise<string>;
  /** ICE servers for one join: STUN, plus short-lived TURN credentials when the platform has a TURN key. */
  iceServers(ttlSeconds: number): Promise<IceServer[]>;
  /** Names of platform keys that are not set (shown on `/health`). */
  missingKeys?(): Promise<string[]>;
}

/** `deps.games` for an app without the module: every call says how to turn it on. */
export function gamesOff(slug: string): Games {
  const fail = () => Promise.reject(new Error(`${slug} does not have the gameServer module: add "gameServer" (and "realtime") to "modules" in app.manifest.json`));
  return { start: fail, stop: fail, running: fail, key: fail, iceServers: fail };
}

// --- Channels ------------------------------------------------------------------------------------

/**
 * A user id as a channel segment (channels allow letters, digits and `-` only): `u_1a2b` → `u-1a2b`.
 * Ids are `u_` + lower-case letters, digits and `_`, so this is one-to-one.
 */
export function playerChannelId(userId: string): string {
  return userId.replace(/_/g, '-');
}

/** The realtime channels of a room. */
export const roomChannels = {
  /** Room status (`{ status: 'open' | 'ended' }`); members listen, only servers publish. */
  room: (roomId: string) => `room/${roomId}`,
  /** Offers and ICE candidates to the game server; members publish, nobody but the server listens. */
  toServer: (roomId: string) => `room/${roomId}/to-server`,
  /** Answers for one player; only that player listens. */
  toPlayer: (roomId: string, userId: string) => `room/${roomId}/to/${playerChannelId(userId)}`,
};

/** Declare the module's channels on an app (done for you when the module is on). */
export function declareRoomChannels<D extends AppDeps>(realtime: RealtimeChannels<Viewer<D>>): void {
  realtime
    .channel('room/*', { subscribe: (v) => !!v.role, publish: false })
    .channel('room/*/to-server', { subscribe: false, publish: (v) => !!v.role })
    // `id` is "<roomId>/<player segment>": only your own.
    .channel('room/*/to/*', { subscribe: (v, id) => id.split('/')[1] === playerChannelId(v.user.id), publish: false });
}

// --- Signaling messages (over the realtime channels) -----------------------------------------------

/** Client → server, on `room/<id>/to-server`. */
export type ToServerSignal =
  /** Start (or restart) a connection. `sid` is the client's random name for it. */
  | { t: 'offer'; sid: string; ticket: string; sdp: string }
  /** One ICE candidate for connection `sid` (null candidate fields are left out). */
  | { t: 'ice'; sid: string; c: IceCandidateInit };

/** Server → one player, on `room/<id>/to/<player>`. */
export type ToPlayerSignal =
  | { t: 'answer'; sid: string; sdp: string }
  | { t: 'ice'; sid: string; c: IceCandidateInit }
  /** The offer was turned down: `ticket` (forged or expired), `full`, `ended`, `error`. */
  | { t: 'refused'; sid: string; reason: string };

export interface IceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

// --- Join tickets ----------------------------------------------------------------------------------

/** What a join ticket says: this user may connect to this room from this device as this name, until `exp`. */
export interface GameTicket {
  roomId: string;
  userId: string;
  /** Tickets from before devices existed have none: read as {@link DEFAULT_DEVICE}. */
  device: string;
  name: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const TICKET_PREFIX = 'sgt1';

/** `sgt1.<claims>.<HMAC-SHA256>`, base64url: the realtime tokens' shape, signed with the app's game key. */
export function signGameTicket(key: string, ticket: Omit<GameTicket, 'device'> & { device?: string }): Promise<string> {
  return signHmacToken(TICKET_PREFIX, key, { ...ticket, device: ticket.device ?? DEFAULT_DEVICE });
}

/** The claims of a ticket this key signed, whatever its room or expiry, or null (forged or malformed). */
export async function readGameTicket(key: string, token: unknown): Promise<GameTicket | null> {
  const t = (await openHmacToken(TICKET_PREFIX, key, token)) as Partial<GameTicket> | null;
  if (!t || typeof t.roomId !== 'string' || typeof t.userId !== 'string' || typeof t.name !== 'string' || typeof t.exp !== 'number') return null;
  const device = t.device ?? DEFAULT_DEVICE;
  if (typeof device !== 'string' || !DEVICE_LABEL.test(device)) return null;
  return { roomId: t.roomId, userId: t.userId, device, name: t.name, exp: t.exp };
}

/** The claims of a genuine, unexpired ticket for `roomId`, or null. */
export async function verifyGameTicket(key: string, token: unknown, roomId: string, nowMs: number): Promise<GameTicket | null> {
  const t = await readGameTicket(key, token);
  return t && t.roomId === roomId && t.exp * 1000 > nowMs ? t : null;
}

// --- Rooms -----------------------------------------------------------------------------------------

/** A random room code. */
export function newRoomCode(random: (max: number) => number = randomBelow): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[random(ROOM_CODE_ALPHABET.length)];
  return code;
}

function randomBelow(max: number): number {
  // Rejection sampling, so every character is equally likely.
  const limit = 256 - (256 % max);
  const byte = new Uint8Array(1);
  do globalThis.crypto.getRandomValues(byte);
  while (byte[0]! >= limit);
  return byte[0]! % max;
}

/** What someone typed as a code, as codes are stored: trimmed, upper case. */
export const normalizeRoomCode = (text: string): string => text.trim().toUpperCase();

const ROOM_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;

async function view(store: Store, meta: RoomMeta, warmMs: number): Promise<Room> {
  const items = await store.query<Item>(roomPk(meta.id));
  const server = items.find((i) => i.SK === 'SERVER') as (Item & RoomServerRecord) | undefined;
  const ended = meta.status === 'ended' || server?.status === 'ended';
  const status: RoomStatus = ended ? 'ended' : server?.status === 'open' ? 'open' : 'starting';
  const endedAt = meta.endedAt ?? server?.endedAt;
  const endedReason = server?.reason ?? meta.endedReason;
  return {
    id: meta.id,
    code: meta.code,
    name: meta.name,
    status,
    createdBy: { id: meta.createdBy, name: meta.createdByName },
    createdAt: meta.createdAt,
    maxPlayers: meta.maxPlayers,
    players: ended ? 0 : items.filter((i) => i.SK.startsWith('PLAYER#')).length,
    ...(ended && endedAt ? { endedAt } : {}),
    ...(ended && endedReason ? { endedReason } : {}),
    ...(server?.results !== undefined ? { results: server.results } : {}),
    ...(meta.warm && !ended ? { warm: true as const, warmUntil: new Date(Date.parse(meta.createdAt) + warmMs).toISOString() } : {}),
  };
}

/**
 * The rooms of an app: what the built-in routes do, for apps that also need it elsewhere
 * (`gameRooms(v.deps, v.manifest)`).
 */
export function gameRooms(deps: AppDeps, manifest: AppManifest) {
  const settings: GameServerSettings = gameServerSettings(manifest);
  const warmMs = settings.warmMinutes * 60_000;
  const { store } = deps;

  const meta = (id: string) => (ROOM_ID.test(id) ? store.get<RoomMeta>(roomPk(id), 'META') : Promise.resolve(undefined));
  const ageOf = (m: RoomMeta) => deps.now().getTime() - Date.parse(m.createdAt);

  /** Close the API's side of a room: out of the index, its code freed, kept for a week. */
  async function finish(m: RoomMeta, reason: string): Promise<void> {
    if (m.status === 'ended') return;
    const now = deps.now();
    const { GSI1PK: _pk, GSI1SK: _sk, warm: _warm, ...rest } = m;
    await store.put({
      ...rest,
      status: 'ended',
      endedAt: now.toISOString(),
      endedReason: reason,
      expiresAt: Math.floor(now.getTime() / 1000) + ENDED_ROOM_TTL_DAYS * 86_400,
    });
    await store.delete(codePk(m.code), 'META');
    for (const p of await store.query<Item>(roomPk(m.id), 'PLAYER#')) await store.delete(p.PK, p.SK);
    if (m.warm) await unlock(m.createdBy, m.id);
  }

  /** Tell everyone watching the room that it is over (best effort: they also poll). */
  const announceEnd = (id: string) =>
    deps.realtime.publish(roomChannels.room(id), { status: 'ended' }).catch((err) => log.warn('Room end not announced', { roomId: id, error: err }));

  /**
   * Take a warm room, once: true for the first caller (its creator adopting it, or the API retiring
   * it), false for anyone after. Two `POST /rooms` at once can't both get it.
   */
  async function claim(m: RoomMeta): Promise<boolean> {
    try {
      const expiresAt = Math.floor(deps.now().getTime() / 1000) + Math.ceil(settings.maxHours * 3600) + ENDED_ROOM_TTL_DAYS * 86_400;
      await store.put({ ...roomKeys.claim(m.id), expiresAt }, { ifNotExists: true });
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
  }

  /** Free a person's warm-up lock if it is still this room's. */
  async function unlock(userId: string, roomId: string): Promise<void> {
    const key = roomKeys.warmLock(userId);
    const lock = await store.get<Item & { roomId?: string }>(key.PK, key.SK);
    if (lock?.roomId === roomId) await store.delete(key.PK, key.SK);
  }

  /** End a warm room nobody took (expired, or making space under `maxRooms`). */
  async function retire(m: RoomMeta): Promise<void> {
    await deps.games.stop(m.id).catch((err) => log.error('Warm game server not stopped', { roomId: m.id, error: err }));
    await finish(m, 'unused');
    await announceEnd(m.id);
  }

  /**
   * The rooms still going, after closing the ones that are not: the server said it ended, its task
   * is gone (crashed, failed to start), it ran past the time limit (stopped here), or it was warm
   * and nobody took it within `warmMinutes`.
   */
  async function active(): Promise<{ meta: RoomMeta; room: Room }[]> {
    const metas = await store.queryGsi1<RoomMeta>(ROOMS_INDEX);
    if (!metas.length) return [];
    const rooms = await Promise.all(metas.map(async (m) => ({ meta: m, room: await view(store, m, warmMs) })));
    const alive = await deps.games.running(rooms.filter((r) => r.room.status !== 'ended').map((r) => r.meta.id));
    const limit = settings.maxHours * 3_600_000 + OVERTIME_GRACE_MS;
    const going: { meta: RoomMeta; room: Room }[] = [];
    for (const r of rooms) {
      const age = ageOf(r.meta);
      if (r.room.status === 'ended') {
        await finish(r.meta, r.room.endedReason ?? 'ended');
        // The server is normally gone by now; make sure of it.
        await deps.games.stop(r.meta.id).catch(() => undefined);
      } else if (!alive.has(r.meta.id)) {
        await finish(r.meta, 'stopped');
        await announceEnd(r.meta.id);
      } else if (age > limit) {
        await deps.games.stop(r.meta.id).catch((err) => log.error('Overtime game server not stopped', { roomId: r.meta.id, error: err }));
        await finish(r.meta, 'time');
        await announceEnd(r.meta.id);
      } else if (r.meta.warm && age >= warmMs && (await claim(r.meta))) {
        await retire(r.meta);
      } else going.push(r);
    }
    return going;
  }

  /** Start a room's server and record it (`warm`: pre-warmed, hidden until its creator takes it). */
  async function start(creator: { id: string; name: string }, opts: { name?: string; warm?: boolean; id?: string }): Promise<Room> {
    const id = opts.id ?? deps.newId();
    if (!ROOM_ID.test(id)) throw new Error(`Room id "${id}" can't be a channel segment (letters, digits and "-")`);
    let code = '';
    for (let attempt = 0; ; attempt++) {
      code = newRoomCode();
      try {
        await store.put({ ...roomKeys.code(code), roomId: id }, { ifNotExists: true });
        break;
      } catch (err) {
        if (!(err instanceof ConditionFailedError) || attempt >= 8) throw err;
      }
    }
    const createdAt = deps.now().toISOString();
    const m: RoomMeta = {
      ...roomKeys.meta(id),
      GSI1PK: ROOMS_INDEX,
      GSI1SK: `${createdAt}#${id}`,
      id,
      code,
      name: opts.name?.trim() || `${creator.name}'s game`,
      createdBy: creator.id,
      createdByName: creator.name,
      createdAt,
      maxPlayers: settings.maxPlayers,
      status: 'starting',
      ...(opts.warm ? { warm: true } : {}),
    };
    await store.put(m);
    try {
      await deps.games.start(id);
    } catch (err) {
      log.error('Game server not started', { roomId: id, error: err });
      await finish(m, 'error');
      throw new HttpError(503, "Couldn't start a game server. Try again in a minute.", 'GAME_START_FAILED');
    }
    return view(store, m, warmMs);
  }

  const tooMany = () => new HttpError(429, 'Too many games running, try again soon', 'TOO_MANY_GAMES');

  /**
   * The caller's live warm room among `going`; or, when the room index hasn't caught up with one
   * started a moment ago, the one their warm-up lock names (read by key), added to `going`.
   */
  async function warmOf(creatorId: string, going: { meta: RoomMeta; room: Room }[]) {
    const listed = going.find((r) => r.meta.warm && r.meta.createdBy === creatorId);
    if (listed) return listed;
    const key = roomKeys.warmLock(creatorId);
    const lock = await store.get<Item & { roomId?: string }>(key.PK, key.SK);
    const m = lock?.roomId ? await meta(lock.roomId) : undefined;
    if (!m?.warm || m.status === 'ended' || m.createdBy !== creatorId) return undefined;
    const room = await view(store, m, warmMs);
    if (room.status === 'ended' || ageOf(m) >= warmMs) return undefined;
    const r = { meta: m, room };
    going.push(r);
    return r;
  }

  return {
    settings,

    /**
     * Create a room. If the creator has a warm room (`warm`), it takes that one over: named,
     * listed and joinable, its server already on its way up. Otherwise it starts a server; at the
     * app's `maxRooms` it first retires the oldest warm room, and answers 429 if there is none.
     */
    async create(creator: { id: string; name: string }, opts: { name?: string } = {}): Promise<Room> {
      let going = await active();
      const mine = await warmOf(creator.id, going);
      // Claimed by a request a moment ago: another Play's game now (it counts below), or being
      // retired by a sweep (it doesn't, once ended).
      const won = mine ? await claim(mine.meta) : false;
      if (mine && !won) {
        const again = await meta(mine.meta.id);
        if (!again || again.status === 'ended') going = going.filter((r) => r !== mine);
      }
      if (mine && won) {
        // Re-read it: it may have ended since the list was read (ended by its creator, or its server stopped).
        const now = await meta(mine.meta.id);
        const room = now && (await view(store, now, warmMs));
        if (now?.warm && room?.status !== 'ended' && ageOf(now) < warmMs - WARM_ADOPT_MARGIN_MS) {
          const { warm: _warm, ...rest } = now;
          const taken: RoomMeta = { ...rest, name: opts.name?.trim() || `${creator.name}'s game` };
          try {
            // Only over the record as it was read: ended meanwhile (its creator, a sweep), it stays ended.
            await store.put(taken, { ifMatch: { status: 'starting', warm: true } });
            await unlock(creator.id, taken.id);
            return view(store, taken, warmMs);
          } catch (err) {
            if (!(err instanceof ConditionFailedError)) throw err;
            // Gone from under us: start over, which now starts a fresh room.
            return this.create(creator, opts);
          }
        }
        // About to expire, or already over: retire it and start a fresh one.
        if (now) await retire(now);
        going = going.filter((r) => r !== mine);
      }
      if (going.length >= settings.maxRooms) {
        const spares = going.filter((r) => r.meta.warm).sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt));
        let made = false;
        for (const spare of spares)
          if (await claim(spare.meta)) {
            await retire(spare.meta);
            made = true;
            break;
          }
        if (!made) throw tooMany();
      }
      return start(creator, opts);
    },

    /**
     * Pre-warm a room for `creator`: start a server now, so their next `create` finds it running.
     * One per person: with a warm room already going, returns it (`started: false`). 429 at the
     * app's `maxRooms` (warm rooms never push out real ones).
     */
    async warm(creator: { id: string; name: string }): Promise<{ room: Room; started: boolean }> {
      let going = await active();
      const mine = await warmOf(creator.id, going);
      if (mine) {
        // Too close to its end for a Play to take it: start the next one now instead.
        if (ageOf(mine.meta) < warmMs - WARM_ADOPT_MARGIN_MS || !(await claim(mine.meta))) return { room: mine.room, started: false };
        await retire(mine.meta);
        going = going.filter((r) => r !== mine);
      }
      if (going.length >= settings.maxRooms) throw tooMany();
      // One at a time per person: a lock naming the room, written only if absent, or swapped for an
      // expired one only if nobody swapped it first.
      const id = deps.newId();
      const now = deps.now().getTime();
      const key = roomKeys.warmLock(creator.id);
      const lock = { ...key, roomId: id, until: now + WARM_LOCK_MS, expiresAt: Math.floor(now / 1000) + 3600 };
      const busy = () => new HttpError(409, 'Already warming a game for you', 'ALREADY_WARMING');
      try {
        await store.put(lock, { ifNotExists: true });
      } catch (err) {
        if (!(err instanceof ConditionFailedError)) throw err;
        const held = await store.get<Item & { roomId?: string; until?: number }>(key.PK, key.SK);
        if (held?.roomId && (held.until ?? 0) > now) throw busy();
        try {
          // Gone since (freed): write it afresh. Expired: swap it, unless someone swapped it first.
          await store.put(lock, held?.roomId ? { ifMatch: { roomId: held.roomId } } : { ifNotExists: true });
        } catch (again) {
          if (again instanceof ConditionFailedError) throw busy();
          throw again;
        }
      }
      let room: Room;
      try {
        room = await start(creator, { warm: true, id });
      } catch (err) {
        await unlock(creator.id, id);
        throw err;
      }
      // Others started rooms meanwhile and the app is over its cap: the newest warm rooms give way,
      // as many as it is over (so two warm-ups racing for one slot don't both lose it).
      const after = await active();
      const self = after.find((r) => r.meta.id === id);
      const newest = after.filter((r) => r.meta.warm).sort((a, b) => b.meta.GSI1SK!.localeCompare(a.meta.GSI1SK!));
      const over = after.length - settings.maxRooms;
      if (self && over > 0 && newest.slice(0, over).includes(self) && (await claim(self.meta))) {
        await retire(self.meta);
        throw tooMany();
      }
      return { room, started: true };
    },

    /** Open and starting rooms, oldest first (dead ones are closed on the way). */
    async list(): Promise<Room[]> {
      return (await active()).filter((r) => !r.meta.warm).map((r) => r.room);
    },

    /** One room (ended ones too, for a week), or undefined. */
    async get(id: string): Promise<Room | undefined> {
      const m = await meta(id);
      if (!m) return undefined;
      const room = await view(store, m, warmMs);
      if (room.status === 'ended' || m.status === 'ended') return room;
      // Still listed as going: check it really is (same rules as the list).
      return (await active()).find((r) => r.meta.id === id)?.room ?? view(store, (await meta(id)) ?? m, warmMs);
    },

    async byCode(code: string): Promise<Room | undefined> {
      const hit = await store.get<Item & { roomId: string }>(codePk(normalizeRoomCode(code)), 'META');
      const room = hit ? await this.get(hit.roomId) : undefined;
      // A warm room's code isn't shared yet.
      return room?.warm ? undefined : room;
    },

    /**
     * A ticket and ICE servers for `player` to connect to an open room from `device` (default
     * `default`): one seat per (user, device). 409 when it is full, ended or not open yet.
     */
    async join(id: string, player: GamePlayerInfo, opts: { device?: string } = {}): Promise<JoinResponse> {
      const device = opts.device ?? DEFAULT_DEVICE;
      if (!DEVICE_LABEL.test(device)) throw badRequest('"device" must be 1-16 lower-case letters, digits or "-"');
      const seat: GameSeatInfo = { id: seatId(player.id, device), userId: player.id, device, name: player.name };
      const room = await this.get(id);
      if (!room) throw notFound('No such room');
      if (room.status === 'ended') throw new HttpError(409, 'This game is over', 'ROOM_ENDED');
      if (room.warm) throw new HttpError(409, "This game hasn't been started yet", 'ROOM_STARTING');
      if (room.status !== 'open') throw new HttpError(409, 'The game server is still starting', 'ROOM_STARTING');
      const key = roomKeys.player(id, seat.id);
      const already = await store.get(key.PK, key.SK);
      if (!already && room.players >= room.maxPlayers) throw new HttpError(409, 'This game is full', 'ROOM_FULL');
      if (!already && device !== DEFAULT_DEVICE) {
        const mine = (await store.query<Item & { userId?: string; id?: string }>(key.PK, 'PLAYER#')).filter((p) => (p.userId ?? p.id) === player.id);
        if (mine.length >= MAX_SEATS_PER_USER) throw new HttpError(409, `You are already in this game on ${MAX_SEATS_PER_USER} devices`, 'TOO_MANY_SEATS');
      }
      const now = deps.now();
      if (!already) await store.put({ ...key, ...seat, joinedAt: now.toISOString() });
      const exp = Math.floor(now.getTime() / 1000) + TICKET_TTL_SECONDS;
      const ticket = await signGameTicket(await deps.games.key(), { roomId: id, userId: player.id, device, name: player.name, exp });
      // TURN credentials outlive the ticket: they must last as long as the connection may.
      const iceServers = await deps.games.iceServers(Math.ceil(settings.maxHours * 3600) + 600).catch((err) => {
        log.warn('TURN credentials unavailable; joining with STUN only', err);
        return STUN_ONLY;
      });
      return {
        ticket,
        expiresAt: new Date(exp * 1000).toISOString(),
        iceServers,
        channels: { room: roomChannels.room(id), toServer: roomChannels.toServer(id), toMe: roomChannels.toPlayer(id, player.id) },
        player: seat,
        room: already ? room : { ...room, players: room.players + 1 },
      };
    },

    /** Give up one seat: this user's on `device` (default `default`); their other seats stay. */
    async leave(id: string, userId: string, device: string = DEFAULT_DEVICE): Promise<void> {
      const key = roomKeys.player(id, seatId(userId, device));
      await store.delete(key.PK, key.SK);
    },

    /** End a room now: marked ended, its server stopped (it says "game over" on its way out), watchers told. */
    async end(id: string, reason = 'ended'): Promise<Room> {
      let m = await meta(id);
      if (!m) throw notFound('No such room');
      // A warm room: take it first, so a Play adopting it at this moment starts a fresh one instead;
      // if that Play got there first, end the room as it now is.
      if (m.warm && !(await claim(m))) m = (await meta(id)) ?? m;
      await finish(m, reason);
      await deps.games.stop(id).catch((err) => log.error('Game server not stopped', { roomId: id, error: err }));
      await announceEnd(id);
      return view(store, (await meta(id)) ?? m, warmMs);
    },

    /** The room's creator id (for "may they end it?"), or undefined. */
    async creatorOf(id: string): Promise<string | undefined> {
      return (await meta(id))?.createdBy;
    },
  };
}

/** The built-in room routes and channels (added by `createStacksApp` when the module is on). */
export function registerGameRoutes<D extends AppDeps>(api: AppRoutes<D>): void {
  declareRoomChannels(api.realtime);
  const rooms = (v: Viewer<D>) => gameRooms(v.deps, v.manifest);
  const player = (v: Viewer<D>): GamePlayerInfo => ({ id: v.user.id, name: v.user.name });

  api.member(
    'POST',
    '/rooms',
    async (req, v) => {
      const room = await rooms(v).create(player(v), { name: optionalString(req.body, 'name', 60) });
      return { status: 201, body: { room }, audit: { label: room.name, roomId: room.id } };
    },
    { audit: 'room.create' },
  );
  // Pre-warm: start a server for the caller's next `POST /rooms`. Speculative, so not audited.
  api.member('POST', '/rooms/warm', async (_req, v) => {
    const { room, started } = await rooms(v).warm(player(v));
    return { status: started ? 201 : 200, body: { room } };
  });
  api.member('GET', '/rooms', async (_req, v) => ({ body: { rooms: await rooms(v).list() } }));
  api.member('GET', '/rooms/by-code/:code', async (req, v) => {
    const room = await rooms(v).byCode(req.params.code!);
    if (!room) throw notFound('No game with that code');
    return { body: { room } };
  });
  api.member('GET', '/rooms/:id', async (req, v) => {
    const room = await rooms(v).get(req.params.id!);
    // A warm room is its creator's alone until they start the game.
    if (!room || (room.warm && !isUser(v.user, room.createdBy.id))) throw notFound('No such room');
    return { body: { room } };
  });
  // `{ device? }`: one seat per (user, device), so one person can be the screen and the controller.
  api.member('POST', '/rooms/:id/join', async (req, v) => ({ body: await rooms(v).join(req.params.id!, player(v), { device: deviceLabel(req.body) }) }));
  api.member('POST', '/rooms/:id/leave', async (req, v) => {
    await rooms(v).leave(req.params.id!, v.user.id, deviceLabel(req.body));
    return { body: { ok: true } };
  });
  api.member(
    'POST',
    '/rooms/:id/end',
    async (req, v) => {
      const r = rooms(v);
      const creator = await r.creatorOf(req.params.id!);
      if (!creator) throw notFound('No such room');
      if (!v.canManageAccess && !isUser(v.user, creator)) throw forbidden('Only whoever started this game (or someone who manages access) can end it');
      const before = await r.get(req.params.id!);
      if (before?.status === 'ended') throw conflict('This game is already over');
      const room = await r.end(req.params.id!);
      return { body: { room }, audit: { label: room.name, roomId: room.id } };
    },
    { audit: 'room.end' },
  );
}
