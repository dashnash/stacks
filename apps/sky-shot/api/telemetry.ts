/**
 * Shot telemetry: your own shots, or (the owner) anyone's. Newest first, paged with `from` (the
 * `next` of the previous page), filtered by `configId`, `theme` (a `themeTag`) and, for the owner,
 * `user`. The web page turns pages into a CSV or JSON download.
 */
import { badRequest, getPeople, userIds, type AppDeps, type AppRoutes } from '@stacks/api';
import type { ShotRecord } from '../game/protocol';
import type { Tuning } from '../game/tuning';
import { keys, type ConfigItem, type ShotItem } from './keys';

export const PAGE_SIZE = 200;
export const MAX_PAGE = 1000;

export type TelemetryShot = ShotRecord & { roomId: string; at: string; cursor: string; shooterName?: string };

export function telemetryRoutes(api: AppRoutes<AppDeps>) {
  api.member('GET', '/telemetry', async (req, v) => {
    const { configId, from, user, theme } = req.query;
    const limit = req.query.limit === undefined ? PAGE_SIZE : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw badRequest(`"limit" must be 1-${MAX_PAGE}`);
    if (configId !== undefined && !/^[0-9a-z]{1,12}$/.test(configId)) throw badRequest('"configId" is not a config id');
    if (theme !== undefined && !/^[a-z]{1,16}\/[a-z]{1,16}$/.test(theme)) throw badRequest('"theme" is not a theme');
    if (user !== undefined && !v.canManageAccess) throw badRequest('Only the owner can look at other people\'s shots');

    // Cursor: the sort key (GSI1SK for everyone's, SK for one person's), newest first.
    let items: (ShotItem & { cursor: string })[];
    if (v.canManageAccess && user === undefined) {
      items = (await v.deps.store.queryGsi1<ShotItem>('SHOTS', { descending: true })).map((i) => ({ ...i, cursor: i.GSI1SK! }));
    } else {
      const ids = user !== undefined ? [user] : userIds(v.user);
      items = (await Promise.all(ids.map((id) => v.deps.store.query<ShotItem>(`SHOTS#${id}`)))).flat().map((i) => ({ ...i, cursor: `${i.SK}#${i.PK}` }));
      items.sort((a, b) => (a.cursor < b.cursor ? 1 : a.cursor > b.cursor ? -1 : 0));
    }
    const now = Math.floor(v.deps.now().getTime() / 1000);
    const matching = items.filter((i) => (!configId || i.configId === configId) && (!theme || i.theme === theme) && (!from || i.cursor < from) && (!i.expiresAt || i.expiresAt > now));
    const page = matching.slice(0, limit);
    const people = await getPeople(v.deps, [...new Set(page.map((i) => i.shooterId))]);
    const shots: TelemetryShot[] = page.map(({ PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g2, expiresAt: _e, ...rest }) => ({ ...(rest as TelemetryShot), shooterName: people.get(rest.shooterId as string)?.name }));
    const configs: Record<string, Tuning> = {};
    for (const id of new Set(shots.map((s) => s.configId))) {
      const c = await v.deps.store.get<ConfigItem>(keys.config(id).PK, keys.config(id).SK);
      if (c) configs[id] = c.tuning;
    }
    return { body: { shots, configs, next: matching.length > limit ? page[page.length - 1]!.cursor : null, everyone: v.canManageAccess && user === undefined } };
  });
}
