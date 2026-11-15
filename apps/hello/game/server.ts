/**
 * Live dots: the reference game for the `gameServer` module. Everyone in the room has a dot that
 * follows their pointer. The server owns every position: browsers send where they point, the
 * server moves each dot toward its target and sends everyone the result 20 times a second.
 */
import { defineGame, type GamePlayer, type GameRoom } from '@stacks/game-server';

export interface Dot {
  id: string;
  name: string;
  /** Position on the board, 0-1 on both axes. */
  x: number;
  y: number;
  /** Index into the UI's palette. */
  color: number;
}

/** What the server sends each player every tick. */
export interface DotsState {
  dots: Dot[];
}

/** What a browser sends: where its pointer is, 0-1 on both axes. */
export interface DotsInput {
  x: number;
  y: number;
}

/** The one event a browser sends, and the one the server sends back to everyone. */
export const BUMP = 'bump';
export interface ShakeEvent {
  shake: { by: string };
}

interface Tracked extends Dot {
  targetX: number;
  targetY: number;
}

interface State {
  room: GameRoom<ShakeEvent>;
  dots: Map<string, Tracked>;
  joined: number;
}

export const MAX_PLAYERS = 8;
export const TICK_HZ = 20;
/** Pointer positions accepted per player per second. */
export const INPUT_HZ = 30;
/** How quickly a dot closes on its target: it covers ~63 % of the gap every 1 / SMOOTHING seconds. */
export const SMOOTHING = 12;
/** Where each newcomer starts, so nobody lands on top of anyone. */
const STARTS: [number, number][] = [
  [0.3, 0.3],
  [0.7, 0.3],
  [0.3, 0.7],
  [0.7, 0.7],
  [0.5, 0.2],
  [0.5, 0.8],
  [0.2, 0.5],
  [0.8, 0.5],
];

const clamp = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number) => Math.round(n * 10_000) / 10_000;

export default defineGame<State, ShakeEvent, DotsState>({
  tickHz: TICK_HZ,
  maxPlayers: MAX_PLAYERS,
  inputsPerSecond: INPUT_HZ,
  eventsPerSecond: 4,

  init: (room) => ({ room, dots: new Map(), joined: 0 }),

  onJoin(state, player: GamePlayer) {
    const [x, y] = STARTS[state.joined % STARTS.length]!;
    state.dots.set(player.id, { id: player.id, name: player.name, x, y, targetX: x, targetY: y, color: state.joined % MAX_PLAYERS });
    state.joined++;
  },

  onLeave(state, player) {
    state.dots.delete(player.id);
  },

  // From a browser: anything that isn't two finite numbers is ignored, and the board has edges.
  onInput(state, player, input) {
    const dot = state.dots.get(player.id);
    const { x, y } = (input ?? {}) as Partial<DotsInput>;
    if (!dot || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    dot.targetX = clamp(x);
    dot.targetY = clamp(y);
  },

  onEvent(state, player, event) {
    if (event === BUMP) state.room.broadcast({ shake: { by: player.name } });
  },

  tick(state, dt) {
    // Exponential smoothing: the same motion whatever the tick rate.
    const pull = 1 - Math.exp(-SMOOTHING * dt);
    for (const dot of state.dots.values()) {
      dot.x = clamp(dot.x + (dot.targetX - dot.x) * pull);
      dot.y = clamp(dot.y + (dot.targetY - dot.y) * pull);
    }
  },

  snapshot: (state) => ({ dots: [...state.dots.values()].map(({ id, name, x, y, color }) => ({ id, name, x: round(x), y: round(y), color })) }),

  results: (state) => ({ players: state.joined }),
});
