/**
 * The `gameServer` module, API side: rooms (session management in the app's table), join tickets
 * and the signaling channels. Each room has its own server-authoritative game server (one Fargate
 * task running the app's `game/server.ts` on `@stacks/game-server`); players reach it over WebRTC
 * data channels, set up through the `realtime` module. Runs the same in Lambda, in tests and in
 * the browser demo (Web Crypto only). The AWS wiring (ECS, the game key, TURN) is in `games-aws.ts`.
 */
import { gameServerSettings, type AppManifest, type GameServerSettings } from '@stacks/manifest';
import type { AppRoutes } from './app';
import { conflict, forbidden, HttpError, notFound, optionalString } from './http';
import type { AppDeps, Viewer } from './model';
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
/** STUN only: what a join gets when the platform has no TURN key. */
export const STUN_ONLY: IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
/** The platform's TURN key (SSM names under `/stacks/<env>/secrets/platform/`). */
export const TURN_KEY_NAMES = ['CLOUDFLARE_TURN_KEY_ID', 'CLOUDFLARE_TURN_API_TOKEN'] as const;

const ROOMS_INDEX = 'STACKS#ROOMS';
const roomPk = (id: string) => `ROOM#${id}`;
const codePk = (code: string) => `ROOMCODE#${code}`;

/** The SDK's keys for a room (documented under "Keys used by the SDK"). */
export const roomKeys = {
  meta: (id: string) => ({ PK: roomPk(id), SK: 'META' }),
  /** Written only by the room's game server: `open`, then `ended` with results. */
  server: (id: string) => ({ PK: roomPk(id), SK: 'SERVER' }),
  player: (id: string, userId: string) => ({ PK: roomPk(id), SK: `PLAYER#${userId}` }),
  /** Where a `Games` implementation keeps what it needs to stop the room's server. */
  task: (id: string) => ({ PK: roomPk(id), SK: 'TASK' }),
  code: (code: string) => ({ PK: codePk(code), SK: 'META' }),
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
  /** People who joined and haven't left. */
  players: number;
  endedAt?: string;
  /** Why it ended: `idle`, `time`, `ended` (by its creator or an approver), `stopped`, `error`. */
  endedReason?: string;
  /** What the game reported when it ended (`room.end(results)` or the game's `results`). */
  results?: unknown;
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
  /** Goes in the WebRTC offer; the game server checks it and binds the peer to this user. */
  ticket: string;
  expiresAt: string;
  iceServers: IceServer[];
  /** The realtime channels for this room and player. */
  channels: { room: string; toServer: string; toMe: string };
  player: GamePlayerInfo;
  room: Room;
}

export interface GamePlayerInfo {
  id: string;
  name: string;
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

/** What a join ticket says: this user may connect to this room as this name, until `exp`. */
export interface GameTicket {
  roomId: string;
  userId: string;
  name: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const TICKET_PREFIX = 'sgt1';

/** `sgt1.<claims>.<HMAC-SHA256>`, base64url: the realtime tokens' shape, signed with the app's game key. */
export function signGameTicket(key: string, ticket: GameTicket): Promise<string> {
  return signHmacToken(TICKET_PREFIX, key, ticket);
}

/** The claims of a genuine, unexpired ticket for `roomId`, or null. */
export async function verifyGameTicket(key: string, token: unknown, roomId: string, nowMs: number): Promise<GameTicket | null> {
  const t = (await openHmacToken(TICKET_PREFIX, key, token)) as Partial<GameTicket> | null;
  if (!t || typeof t.roomId !== 'string' || typeof t.userId !== 'string' || typeof t.name !== 'string' || typeof t.exp !== 'number') return null;
  if (t.roomId !== roomId || t.exp * 1000 <= nowMs) return null;
  return { roomId: t.roomId, userId: t.userId, name: t.name, exp: t.exp };
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

async function view(store: Store, meta: RoomMeta): Promise<Room> {
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
  };
}

/**
 * The rooms of an app: what the built-in routes do, for apps that also need it elsewhere
 * (`gameRooms(v.deps, v.manifest)`).
 */
export function gameRooms(deps: AppDeps, manifest: AppManifest) {
  const settings: GameServerSettings = gameServerSettings(manifest);
  const { store } = deps;

  const meta = (id: string) => (ROOM_ID.test(id) ? store.get<RoomMeta>(roomPk(id), 'META') : Promise.resolve(undefined));

  /** Close the API's side of a room: out of the index, its code freed, kept for a week. */
  async function finish(m: RoomMeta, reason: string): Promise<void> {
    if (m.status === 'ended') return;
    const now = deps.now();
    const { GSI1PK: _pk, GSI1SK: _sk, ...rest } = m;
    await store.put({
      ...rest,
      status: 'ended',
      endedAt: now.toISOString(),
      endedReason: reason,
      expiresAt: Math.floor(now.getTime() / 1000) + ENDED_ROOM_TTL_DAYS * 86_400,
    });
    await store.delete(codePk(m.code), 'META');
    for (const p of await store.query<Item>(roomPk(m.id), 'PLAYER#')) await store.delete(p.PK, p.SK);
  }

  /** Tell everyone watching the room that it is over (best effort: they also poll). */
  const announceEnd = (id: string) =>
    deps.realtime.publish(roomChannels.room(id), { status: 'ended' }).catch((err) => console.error('Room end not announced', id, err));

  /**
   * The rooms still going, after closing the ones that are not: the server said it ended, its task
   * is gone (crashed, failed to start), or it ran past the time limit (stopped here).
   */
  async function active(): Promise<{ meta: RoomMeta; room: Room }[]> {
    const metas = await store.queryGsi1<RoomMeta>(ROOMS_INDEX);
    if (!metas.length) return [];
    const rooms = await Promise.all(metas.map(async (m) => ({ meta: m, room: await view(store, m) })));
    const alive = await deps.games.running(rooms.filter((r) => r.room.status !== 'ended').map((r) => r.meta.id));
    const limit = settings.maxHours * 3_600_000 + OVERTIME_GRACE_MS;
    const going: { meta: RoomMeta; room: Room }[] = [];
    for (const r of rooms) {
      const age = deps.now().getTime() - Date.parse(r.meta.createdAt);
      if (r.room.status === 'ended') {
        await finish(r.meta, r.room.endedReason ?? 'ended');
        // The server is normally gone by now; make sure of it.
        await deps.games.stop(r.meta.id).catch(() => undefined);
      } else if (!alive.has(r.meta.id)) {
        await finish(r.meta, 'stopped');
        await announceEnd(r.meta.id);
      } else if (age > limit) {
        await deps.games.stop(r.meta.id).catch((err) => console.error('Overtime game server not stopped', r.meta.id, err));
        await finish(r.meta, 'time');
        await announceEnd(r.meta.id);
      } else going.push(r);
    }
    return going;
  }

  return {
    settings,

    /** Create a room and start its game server. 429 when the app is at its `maxRooms`. */
    async create(creator: { id: string; name: string }, opts: { name?: string } = {}): Promise<Room> {
      const going = await active();
      if (going.length >= settings.maxRooms) throw new HttpError(429, 'Too many games running, try again soon', 'TOO_MANY_GAMES');
      const id = deps.newId();
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
      };
      await store.put(m);
      try {
        await deps.games.start(id);
      } catch (err) {
        console.error('Game server not started', id, err);
        await finish(m, 'error');
        throw new HttpError(503, "Couldn't start a game server. Try again in a minute.", 'GAME_START_FAILED');
      }
      return view(store, m);
    },

    /** Open and starting rooms, oldest first (dead ones are closed on the way). */
    async list(): Promise<Room[]> {
      return (await active()).map((r) => r.room);
    },

    /** One room (ended ones too, for a week), or undefined. */
    async get(id: string): Promise<Room | undefined> {
      const m = await meta(id);
      if (!m) return undefined;
      const room = await view(store, m);
      if (room.status === 'ended' || m.status === 'ended') return room;
      // Still listed as going: check it really is (same rules as the list).
      return (await active()).find((r) => r.meta.id === id)?.room ?? view(store, (await meta(id)) ?? m);
    },

    async byCode(code: string): Promise<Room | undefined> {
      const hit = await store.get<Item & { roomId: string }>(codePk(normalizeRoomCode(code)), 'META');
      return hit ? this.get(hit.roomId) : undefined;
    },

    /** A ticket and ICE servers for `player` to connect to an open room. 409 when it is full, ended or not open yet. */
    async join(id: string, player: GamePlayerInfo): Promise<JoinResponse> {
      const room = await this.get(id);
      if (!room) throw notFound('No such room');
      if (room.status === 'ended') throw new HttpError(409, 'This game is over', 'ROOM_ENDED');
      if (room.status !== 'open') throw new HttpError(409, 'The game server is still starting', 'ROOM_STARTING');
      const key = roomKeys.player(id, player.id);
      const already = await store.get(key.PK, key.SK);
      if (!already && room.players >= room.maxPlayers) throw new HttpError(409, 'This game is full', 'ROOM_FULL');
      const now = deps.now();
      if (!already) await store.put({ ...key, id: player.id, name: player.name, joinedAt: now.toISOString() });
      const exp = Math.floor(now.getTime() / 1000) + TICKET_TTL_SECONDS;
      const ticket = await signGameTicket(await deps.games.key(), { roomId: id, userId: player.id, name: player.name, exp });
      // TURN credentials outlive the ticket: they must last as long as the connection may.
      const iceServers = await deps.games.iceServers(Math.ceil(settings.maxHours * 3600) + 600).catch((err) => {
        console.error('TURN credentials unavailable; joining with STUN only', err);
        return STUN_ONLY;
      });
      return {
        ticket,
        expiresAt: new Date(exp * 1000).toISOString(),
        iceServers,
        channels: { room: roomChannels.room(id), toServer: roomChannels.toServer(id), toMe: roomChannels.toPlayer(id, player.id) },
        player,
        room: already ? room : { ...room, players: room.players + 1 },
      };
    },

    async leave(id: string, userId: string): Promise<void> {
      const key = roomKeys.player(id, userId);
      await store.delete(key.PK, key.SK);
    },

    /** End a room now: marked ended, its server stopped (it says "game over" on its way out), watchers told. */
    async end(id: string, reason = 'ended'): Promise<Room> {
      const m = await meta(id);
      if (!m) throw notFound('No such room');
      await finish(m, reason);
      await deps.games.stop(id).catch((err) => console.error('Game server not stopped', id, err));
      await announceEnd(id);
      return view(store, (await meta(id)) ?? m);
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
  api.member('GET', '/rooms', async (_req, v) => ({ body: { rooms: await rooms(v).list() } }));
  api.member('GET', '/rooms/by-code/:code', async (req, v) => {
    const room = await rooms(v).byCode(req.params.code!);
    if (!room) throw notFound('No game with that code');
    return { body: { room } };
  });
  api.member('GET', '/rooms/:id', async (req, v) => {
    const room = await rooms(v).get(req.params.id!);
    if (!room) throw notFound('No such room');
    return { body: { room } };
  });
  api.member('POST', '/rooms/:id/join', async (req, v) => ({ body: await rooms(v).join(req.params.id!, player(v)) }));
  api.member('POST', '/rooms/:id/leave', async (req, v) => {
    await rooms(v).leave(req.params.id!, v.user.id);
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
