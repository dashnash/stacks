/** The leaderboard: best Rounds score per member, top 20, first names only (public). */
import { notFound, type AppDeps, type AppRoutes } from '@stacks/api';
import { firstName, keys, LEADERBOARD_SIZE, type LeaderItem } from './keys';

export interface LeaderEntry {
  /** User id (for the owner's Remove button; never an email). */
  id: string;
  name: string;
  score: number;
  accuracy: number;
  rounds: number;
  at: string;
}

export async function leaderboard(deps: AppDeps): Promise<LeaderEntry[]> {
  const items = await deps.store.query<LeaderItem>('LEADER');
  return items
    .sort((a, b) => b.score - a.score || a.at.localeCompare(b.at))
    .slice(0, LEADERBOARD_SIZE)
    .map((i) => ({ id: i.userId, name: firstName(i.name), score: i.score, accuracy: i.accuracy, rounds: i.rounds, at: i.at }));
}

export function leaderboardRoutes(api: AppRoutes<AppDeps>) {
  api
    .public('GET', '/leaderboard', async (_req, ctx) => {
      const viewer = await ctx.viewer();
      const mine = viewer ? await ctx.deps.store.get<LeaderItem>(keys.leader(viewer.user.id).PK, keys.leader(viewer.user.id).SK) : undefined;
      return { body: { entries: await leaderboard(ctx.deps), best: mine ? { score: mine.score, rounds: mine.rounds, accuracy: mine.accuracy } : null, canRemove: !!viewer?.canManageAccess } };
    })
    .approver(
      'DELETE',
      '/leaderboard/:userId',
      async (req, v) => {
        const key = keys.leader(req.params.userId!);
        const found = await v.deps.store.get<LeaderItem>(key.PK, key.SK);
        if (!found) throw notFound('Not on the leaderboard');
        await v.deps.store.delete(key.PK, key.SK);
        return { body: { ok: true }, audit: { label: firstName(found.name), userId: found.userId, score: found.score } };
      },
      { audit: 'leaderboard.remove' },
    );
}
