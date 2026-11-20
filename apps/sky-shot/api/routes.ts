import type { AppDeps, AppRoutes } from '@stacks/api';
import { leaderboardRoutes } from './leaderboard';
import { sessionRoutes } from './sessions';
import { telemetryRoutes } from './telemetry';

/**
 * Sky Shot's API. Rooms, joining and the game itself come from the `gameServer` module (`/rooms…`
 * and `game/server.ts`); these routes keep what lasts after a room: the leaderboard and telemetry.
 */
export function routes(api: AppRoutes<AppDeps>) {
  sessionRoutes(api);
  leaderboardRoutes(api);
  telemetryRoutes(api);
}
