/**
 * What travels on a player's two WebRTC data channels (JSON text). `@stacks/web` speaks the same
 * protocol from the browser (it keeps its own copy of these shapes; the demo tests hold them together).
 *
 * - `state` (unreliable, unordered): input up, snapshots down. A lost packet is replaced by the next.
 * - `events` (reliable, ordered): everything that must arrive.
 */

/** Data channel labels; the client creates both. */
export const STATE_CHANNEL = 'state';
export const EVENTS_CHANNEL = 'events';

/** Client → server on `state`. */
export interface InputMessage {
  i: unknown;
}

/** Server → client on `state`, once per tick batch. */
export interface StateMessage {
  /** Tick number. */
  n: number;
  /** Server time: milliseconds since the room started. */
  t: number;
  /** The game's `snapshot(state, forPlayer)`. */
  s: unknown;
}

export interface PlayerInfo {
  id: string;
  name: string;
}

/** Server → client on `events`. */
export type ServerEvent =
  | { welcome: { you: PlayerInfo; players: PlayerInfo[]; tickHz: number; rejoined: boolean } }
  /** The roster changed (someone joined or left). */
  | { players: PlayerInfo[] }
  /** An event from the game (`room.broadcast` / `room.send`). */
  | { event: unknown }
  /** Answer to a ping: the client's own timestamp back. */
  | { pong: number }
  /** Game over: `idle`, `time`, `stopped`, `error`, or the game's own reason. */
  | { over: { reason: string; results?: unknown } };

/** Client → server on `events`. */
export type ClientEvent = { event: unknown } | { ping: number } | { leave: true };

/** Snapshots above this many bytes are likely to be split across packets; the runtime warns once. */
export const SNAPSHOT_WARN_BYTES = 1200;
/** Snapshots above this are not sent at all. */
export const SNAPSHOT_MAX_BYTES = 16_000;
/** The largest message a client may send on either channel. */
export const CLIENT_MESSAGE_MAX_BYTES = 4096;
