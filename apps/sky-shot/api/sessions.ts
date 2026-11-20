/**
 * Saving a played room: the screen calls this after the room ends. It copies the best Rounds score of
 * each shooter to the leaderboard and the shots (with their configs) to the table for 30 days. The
 * room's `results` are written by the game server, so they are trusted in shape but checked anyway.
 */
import { ConditionFailedError, forbidden, gameRooms, HttpError, isUser, notFound, type AppDeps, type AppRoutes } from '@stacks/api';
import type { GameSummary, Results, ShotRecord } from '../game/protocol';
import { applyTune, DEFAULT_TUNING } from '../game/tuning';
import { keys, TELEMETRY_DAYS, type LeaderItem, type SessionItem } from './keys';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** What we keep from a room's results: anything malformed is dropped, not stored. */
export function readResults(raw: unknown): Results | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  const games = (Array.isArray(raw.games) ? raw.games : []).filter(isObj).map(
    (g): GameSummary => ({
      mode: g.mode === 'range' ? 'range' : 'rounds',
      score: num(g.score),
      rounds: num(g.rounds),
      accuracy: num(g.accuracy),
      shots: num(g.shots),
      hits: num(g.hits),
      shooterId: typeof g.shooterId === 'string' ? g.shooterId : null,
      shooterName: typeof g.shooterName === 'string' ? g.shooterName.slice(0, 60) : null,
      endedAt: num(g.endedAt),
    }),
  );
  const shots = (Array.isArray(raw.shots) ? raw.shots : []).filter((s): s is ShotRecord => isObj(s) && typeof s.shooterId === 'string' && typeof s.configId === 'string').slice(-500);
  const configs: Results['configs'] = {};
  if (isObj(raw.configs)) for (const [id, t] of Object.entries(raw.configs)) if (/^[0-9a-z]{1,12}$/.test(id)) configs[id] = applyTune(DEFAULT_TUNING, t);
  return { v: 1, startedAt: num(raw.startedAt), games, shots, droppedShots: num(raw.droppedShots), configs };
}

/** Best Rounds game per shooter. */
function bestPerShooter(games: GameSummary[]): GameSummary[] {
  const best = new Map<string, GameSummary>();
  for (const g of games) {
    if (g.mode !== 'rounds' || !g.shooterId || !g.shots) continue;
    const had = best.get(g.shooterId);
    if (!had || g.score > had.score) best.set(g.shooterId, g);
  }
  return [...best.values()];
}

async function save(deps: AppDeps, roomId: string, userId: string, results: Results): Promise<{ games: GameSummary[]; shots: number }> {
  const now = deps.now();
  const savedAt = now.toISOString();
  const expiresAt = Math.floor(now.getTime() / 1000) + TELEMETRY_DAYS * 86_400;
  for (const g of bestPerShooter(results.games)) {
    const key = keys.leader(g.shooterId!);
    const had = await deps.store.get<LeaderItem>(key.PK, key.SK);
    if (had && had.score >= g.score) continue;
    await deps.store.put({ ...key, userId: g.shooterId!, name: g.shooterName ?? 'Someone', score: g.score, accuracy: g.accuracy, rounds: g.rounds, at: savedAt, roomId } satisfies LeaderItem);
  }
  for (const [id, tuning] of Object.entries(results.configs)) await deps.store.put({ ...keys.config(id), id, tuning, expiresAt });
  let n = 0;
  for (const shot of results.shots) {
    const at = new Date((results.startedAt || now.getTime()) + num(shot.t)).toISOString();
    await deps.store.put({ ...keys.shot(shot.shooterId, at, roomId, n++), ...shot, roomId, at, expiresAt });
  }
  return { games: results.games, shots: n };
}

export function sessionRoutes(api: AppRoutes<AppDeps>) {
  api.member(
    'POST',
    '/sessions/:roomId/save',
    async (req, v) => {
      const roomId = req.params.roomId!;
      const room = await gameRooms(v.deps, v.manifest).get(roomId);
      if (!room) throw notFound('No such game');
      if (!isUser(v.user, room.createdBy.id)) throw forbidden('Only whoever started this game can save it');
      if (room.status !== 'ended') throw new HttpError(409, 'This game is still going', 'NOT_OVER');
      const key = keys.session(roomId);
      const done = await v.deps.store.get<SessionItem>(key.PK, key.SK);
      if (done) return { body: { saved: false, games: done.games, shots: done.shots } };
      const results = readResults(room.results) ?? { v: 1 as const, startedAt: 0, games: [], shots: [], droppedShots: 0, configs: {} };
      try {
        // Claim the room first, so two saves at once don't both copy the shots.
        await v.deps.store.put({ ...key, roomId, userId: v.user.id, savedAt: v.deps.now().toISOString(), games: results.games, shots: results.shots.length } satisfies SessionItem, { ifNotExists: true });
      } catch (err) {
        if (err instanceof ConditionFailedError) return { body: { saved: false, games: results.games, shots: results.shots.length } };
        throw err;
      }
      const saved = await save(v.deps, roomId, v.user.id, results);
      return { status: 201, body: { saved: true, ...saved }, audit: { label: room.name, roomId, shots: saved.shots } };
    },
    { audit: 'session.save' },
  );
}
