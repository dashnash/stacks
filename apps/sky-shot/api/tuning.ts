/**
 * Your own aim settings and training runs.
 *
 * - `GET /tuning`: your saved default (null if you never saved one). The screen sends it to each new
 *   room, so a fit sticks.
 * - `PUT /tuning { tuning, source }`: save one (from a calibration, a training fit, or the panel's "Save as my default").
 * - `DELETE /tuning`: back to the game's defaults.
 * - `GET /training`: your training runs, newest first, without their raw motion; the owner sees
 *   everyone's (or one person's with `?user=`).
 * - `GET /training/:userId/:sk`: one run in full, raw motion included (yours, or anyone's for the owner).
 */
import { badRequest, forbidden, getPeople, notFound, userIds, type AppDeps, type AppRoutes } from '@stacks/api';
import { applyTune, DEFAULT_TUNING, type Tuning } from '../game/tuning';
import { keys, type TrainingItem, type TuningItem } from './keys';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const TRAINING_LIST = 50;

export type TrainingSummary = Omit<TrainingItem, 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK' | 'raw' | 'expiresAt'> & { userId: string; sk: string; samples: number; shooterName?: string };

const summary = (i: TrainingItem): TrainingSummary => {
  const { PK, SK: _sk, GSI1PK: _g1, GSI1SK: _g2, raw, expiresAt: _e, ...rest } = i;
  return { ...rest, userId: PK.slice('TRAINING#'.length), sk: i.SK, samples: raw?.length ?? 0 };
};

export function tuningRoutes(api: AppRoutes<AppDeps>) {
  api
    .member('GET', '/tuning', async (_req, v) => {
      const key = keys.tuning(v.user.id);
      const item = await v.deps.store.get<TuningItem>(key.PK, key.SK);
      return { body: item ? { tuning: applyTune(DEFAULT_TUNING, item.tuning), source: item.source, at: item.at } : { tuning: null } };
    })
    .member('PUT', '/tuning', async (req, v) => {
      const body = req.body as { tuning?: unknown; source?: unknown } | undefined;
      if (!isObj(body?.tuning)) throw badRequest('"tuning" is required');
      const tuning: Tuning = applyTune(DEFAULT_TUNING, body.tuning);
      const source = body.source === 'calibration' || body.source === 'training' ? body.source : 'manual';
      const at = v.deps.now().toISOString();
      await v.deps.store.put({ ...keys.tuning(v.user.id), userId: v.user.id, tuning, source, at } satisfies TuningItem);
      return { body: { tuning, source, at } };
    })
    .member('DELETE', '/tuning', async (_req, v) => {
      const key = keys.tuning(v.user.id);
      await v.deps.store.delete(key.PK, key.SK);
      return { body: { tuning: null } };
    })
    .member('GET', '/training', async (req, v) => {
      const { user } = req.query;
      if (user !== undefined && !v.canManageAccess) throw badRequest("Only the owner can look at other people's training");
      const now = Math.floor(v.deps.now().getTime() / 1000);
      let items: TrainingItem[];
      if (v.canManageAccess && user === undefined) items = await v.deps.store.queryGsi1<TrainingItem>('TRAINING', { descending: true });
      else {
        const ids = user !== undefined ? [user] : userIds(v.user);
        items = (await Promise.all(ids.map((id) => v.deps.store.query<TrainingItem>(`TRAINING#${id}`)))).flat();
        items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      }
      const runs = items.filter((i) => !i.expiresAt || i.expiresAt > now).slice(0, TRAINING_LIST).map(summary);
      const people = await getPeople(v.deps, [...new Set(runs.map((r) => r.userId))]);
      return { body: { runs: runs.map((r) => ({ ...r, shooterName: people.get(r.userId)?.name })), everyone: v.canManageAccess && user === undefined } };
    })
    .member('GET', '/training/:userId/:sk', async (req, v) => {
      const userId = req.params.userId!;
      if (!userIds(v.user).includes(userId) && !v.canManageAccess) throw forbidden("That's someone else's training run");
      const item = await v.deps.store.get<TrainingItem>(`TRAINING#${userId}`, req.params.sk!);
      if (!item || (item.expiresAt && item.expiresAt <= Math.floor(v.deps.now().getTime() / 1000))) throw notFound('No such training run');
      return { body: { run: { ...summary(item), raw: item.raw ?? [] } } };
    });
}
