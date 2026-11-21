/**
 * Your own aim settings, kept between rooms.
 *
 * - `GET /tuning`: your saved default (null if you never saved one). The screen sends it to each new
 *   room, so a calibration sticks.
 * - `PUT /tuning { tuning, source }`: save one (after a calibration, or the panel's "Save as my default").
 * - `DELETE /tuning`: back to the game's defaults.
 */
import { badRequest, type AppDeps, type AppRoutes } from '@stacks/api';
import { applyTune, DEFAULT_TUNING, type Tuning } from '../game/tuning';
import { keys, type TuningItem } from './keys';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

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
      const source = body.source === 'calibration' ? 'calibration' : 'manual';
      const at = v.deps.now().toISOString();
      await v.deps.store.put({ ...keys.tuning(v.user.id), userId: v.user.id, tuning, source, at } satisfies TuningItem);
      return { body: { tuning, source, at } };
    })
    .member('DELETE', '/tuning', async (_req, v) => {
      const key = keys.tuning(v.user.id);
      await v.deps.store.delete(key.PK, key.SK);
      return { body: { tuning: null } };
    });
}
