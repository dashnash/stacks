/**
 * The Fargate entry: `runGameServer(game)` runs one room of the app's game from the environment
 * `AppStack` and the API's RunTask give the task, then exits. The image's bundle is this file
 * plus the app's `game/server.ts` (see `scripts/build-image.mjs`).
 */
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { DynamoStore } from '@stacks/api/dynamo-store';
import { realtimeKeyReader } from '@stacks/api/realtime-aws';
import type { GameDefinition } from '../game';
import { RoomServer } from '../room-server';
import { appSyncSignaling } from './appsync-signaling';
import { weriftPeers } from './werift-peers';

export { appSyncSignaling } from './appsync-signaling';
export type { AppSyncSignalingOptions, ServerSocket } from './appsync-signaling';
export { DEFAULT_STUN_URLS, vpcAddress, weriftPeers } from './werift-peers';
export type { WeriftPeerOptions } from './werift-peers';

/** How often the server logs a heartbeat (the long-running-task alarm reads `uptimeSeconds` from it). */
export const HEARTBEAT_MS = 60_000;
/** Past the time limit by this much, the process exits whatever state it is in. */
const HARD_STOP_AFTER_MS = 2 * 60_000;

/** What the task's environment says, checked. */
export function readEnvironment(env: Record<string, string | undefined> = process.env) {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  const number = (name: string, fallback: number) => {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    return value;
  };
  return {
    roomId: need('STACKS_ROOM_ID'),
    app: need('STACKS_APP'),
    tableName: need('TABLE_NAME'),
    region: env.AWS_REGION ?? 'us-east-1',
    httpHost: need('STACKS_REALTIME_HTTP_HOST'),
    realtimeHost: need('STACKS_REALTIME_WS_HOST'),
    namespace: env.STACKS_REALTIME_NAMESPACE || 'app',
    keyArn: need('STACKS_GAME_KEY_ARN'),
    maxPlayers: number('STACKS_GAME_MAX_PLAYERS', 8),
    idleMs: number('STACKS_GAME_IDLE_MINUTES', 10) * 60_000,
    maxMs: number('STACKS_GAME_MAX_HOURS', 2) * 3_600_000,
    portRange: [number('STACKS_GAME_PORT_MIN', 40000), number('STACKS_GAME_PORT_MAX', 40019)] as [number, number],
  };
}

/** One JSON line per log entry (CloudWatch metric filters read them). */
const logLine = (room: string) => (message: string, detail?: unknown) =>
  console.log(JSON.stringify({ room, message, ...(detail === undefined ? {} : { detail: detail instanceof Error ? (detail.stack ?? detail.message) : detail }) }));

/** Run this task's room to the end, then exit the process. */
export async function runGameServer<S, E, V>(game: GameDefinition<S, E, V>): Promise<void> {
  const started = Date.now();
  let config: ReturnType<typeof readEnvironment>;
  try {
    config = readEnvironment();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
  const log = logLine(config.roomId);
  const credentials = defaultProvider();
  const signaling = appSyncSignaling({
    httpHost: config.httpHost,
    realtimeHost: config.realtimeHost,
    namespace: config.namespace,
    region: config.region,
    credentials,
    log,
  });
  const server = new RoomServer({
    roomId: config.roomId,
    game,
    store: new DynamoStore(config.tableName),
    signaling,
    peers: weriftPeers({ portRange: config.portRange, log }),
    key: realtimeKeyReader({ secretId: config.keyArn }),
    maxPlayers: config.maxPlayers,
    idleMs: config.idleMs,
    maxMs: config.maxMs,
    log,
  });

  const heartbeat = setInterval(
    () => console.log(JSON.stringify({ room: config.roomId, app: config.app, message: 'heartbeat', uptimeSeconds: Math.round((Date.now() - started) / 1000), players: server.host?.connected ?? 0 })),
    HEARTBEAT_MS,
  );
  // Whatever goes wrong on the way out, the task does not outlive its room by much.
  setTimeout(() => {
    log('hard stop: still running past the time limit');
    process.exit(1);
  }, config.maxMs + HARD_STOP_AFTER_MS).unref();
  // ECS sends SIGTERM when the API stops the task (the room was ended): say "game over", write up, go.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.stop('stopped'));

  let code = 0;
  try {
    if (await server.start()) await server.done;
  } catch (err) {
    log('game server failed', err);
    server.stop('error');
    await Promise.race([server.done, new Promise((resolve) => setTimeout(resolve, 3000))]);
    code = 1;
  }
  clearInterval(heartbeat);
  signaling.close();
  process.exit(code);
}
