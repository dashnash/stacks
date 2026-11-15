import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalStacks } from './auth';
import { GameRoomClient, hubSignaling, type GamePlayerInfo, type GameRoomSnapshot, type GameRoomStatus, type PeerLike, type StateMeta } from './gameRoom';
import { realtimeHub } from './realtime';

export interface UseGameRoomOptions<S = unknown, E = unknown> {
  /** The server's latest state for you, about `tickHz` times a second (raw: draw it, or feed `createStateBuffer`). */
  onState?: (state: S, meta: StateMeta) => void;
  /** An event from the game (reliable): a bump, "round over". */
  onEvent?: (event: E) => void;
}

export interface GameRoomHandle<I = unknown, E = unknown> {
  /**
   * `starting` (the server is coming up, up to a minute), `connecting`, `live`, `ended` (see `over`),
   * `offline` (signed out, no such room, full, or you left: see `error`).
   */
  status: GameRoomStatus;
  players: GamePlayerInfo[];
  you: GamePlayerInfo | null;
  /** Send input on the unreliable channel (dropped unless live; at most ~60 a second count). */
  sendInput(input: I): void;
  /** Send an event on the reliable channel. False when the room isn't live. */
  sendEvent(event: E): boolean;
  /** Round trip to the server in ms, or null. */
  rttMs: number | null;
  /** Give up your place. */
  leave(): Promise<void>;
  over: GameRoomSnapshot['over'];
  error: string | null;
}

const IDLE: GameRoomSnapshot = { status: 'offline', players: [], you: null, rttMs: null, over: null, error: null };

/**
 * Play in a game room (manifest module `gameServer`): joins, connects to the room's game server
 * over WebRTC, and reconnects (the server keeps your place for 20 s). With `roomId` null, or
 * signed out, it stays `offline`.
 */
export function useGameRoom<S = unknown, I = unknown, E = unknown>(roomId: string | null, opts: UseGameRoomOptions<S, E> = {}): GameRoomHandle<I, E> {
  const stacks = useOptionalStacks();
  const api = stacks?.api;
  const signedIn = stacks?.status === 'signedIn' && !!stacks.session;
  const who = stacks?.session ? `${stacks.session.user.id}:${stacks.session.role}` : '';
  const [snapshot, setSnapshot] = useState<GameRoomSnapshot>(signedIn && roomId ? { ...IDLE, status: 'starting' } : IDLE);
  const stateRef = useRef(opts.onState);
  stateRef.current = opts.onState;
  const eventRef = useRef(opts.onEvent);
  eventRef.current = opts.onEvent;
  const client = useRef<GameRoomClient | null>(null);

  useEffect(() => {
    if (!api || !signedIn || !roomId) {
      setSnapshot(signedIn || !roomId ? IDLE : { ...IDLE, error: 'signed_out' });
      return;
    }
    setSnapshot({ ...IDLE, status: 'starting' });
    const room = new GameRoomClient({
      roomId,
      api,
      signaling: hubSignaling(realtimeHub(api), who),
      createPeer: (config) => api.openPeer(config) as PeerLike,
      onState: (state, meta) => stateRef.current?.(state as S, meta),
      onEvent: (event) => eventRef.current?.(event as E),
      onChange: setSnapshot,
    });
    client.current = room;
    room.start();
    return () => {
      room.stop();
      if (client.current === room) client.current = null;
    };
  }, [api, signedIn, who, roomId]);

  const sendInput = useCallback((input: I) => client.current?.sendInput(input), []);
  const sendEvent = useCallback((event: E) => client.current?.sendEvent(event) ?? false, []);
  const leave = useCallback(async () => client.current?.leave(), []);

  return { status: snapshot.status, players: snapshot.players, you: snapshot.you, rttMs: snapshot.rttMs, over: snapshot.over, error: snapshot.error, sendInput, sendEvent, leave };
}
