import { badRequest, forbidden, notFound, optionalInt, optionalString, strip, type AppDeps, type AppRoutes, type Item } from '@stacks/api';
import { scoreOf, toolById, unlockedTools } from './tools';

/** One finished flip by a signed-in player. PK `FLIPS#<email>`, SK `<iso>#<id>`. */
export interface Flip {
  id: string;
  score: number;
  damage: number;
  hangMs: number;
  tool: string;
  createdAt: string;
}

/** Per-player totals. PK `PLAYER`, SK `<email>`: the leaderboard reads the whole partition. */
export interface PlayerStats {
  playerId: string;
  email: string;
  name: string;
  best: number;
  total: number;
  flips: number;
  updatedAt: string;
}

/** What the public leaderboard shows: first names only, never emails. */
export interface BoardEntry {
  playerId: string;
  name: string;
  best: number;
  flips: number;
}

export const MAX_DAMAGE = 50_000;
export const MAX_HANG_MS = 15_000;
export const BOARD_SIZE = 20;
const PLAYER = 'PLAYER';

const firstName = (name: string) => name.trim().split(/\s+/)[0] || 'Anonymous';

async function getStats(deps: AppDeps, email: string): Promise<PlayerStats | undefined> {
  const found = await deps.store.get<Item & PlayerStats>(PLAYER, email);
  return found ? strip(found) : undefined;
}

export async function leaderboard(deps: AppDeps): Promise<BoardEntry[]> {
  const all = await deps.store.query<Item & PlayerStats>(PLAYER);
  return all
    .filter((p) => p.best > 0)
    .sort((a, b) => b.best - a.best || a.updatedAt.localeCompare(b.updatedAt))
    .slice(0, BOARD_SIZE)
    .map((p) => ({ playerId: p.playerId, name: firstName(p.name), best: p.best, flips: p.flips }));
}

export function flipRoutes(api: AppRoutes<AppDeps>) {
  api
    .public('GET', '/public/leaderboard', async (_req, ctx) => ({ body: { entries: await leaderboard(ctx.deps) } }))
    .member('GET', '/me', async (_req, v) => {
      const stats = await getStats(v.deps, v.user.email);
      const recent = (await v.deps.store.query<Item & Flip>(`FLIPS#${v.user.email}`)).reverse().slice(0, 5).map((f) => strip(f));
      const board = await leaderboard(v.deps);
      const rank = stats ? board.findIndex((e) => e.playerId === stats.playerId) + 1 || null : null;
      return {
        body: {
          best: stats?.best ?? 0,
          total: stats?.total ?? 0,
          flips: stats?.flips ?? 0,
          rank,
          recent,
          canModerate: v.canManageAccess,
        },
      };
    })
    .member(
      'POST',
      '/flips',
      async (req, v) => {
        const damage = optionalInt(req.body, 'damage', 0, MAX_DAMAGE);
        const hangMs = optionalInt(req.body, 'hangMs', 0, MAX_HANG_MS);
        if (damage === undefined || hangMs === undefined) throw badRequest('damage and hangMs are required');
        const toolId = optionalString(req.body, 'tool', 20) ?? 'hand';
        const tool = toolById(toolId);
        if (!tool) throw badRequest('Unknown tool');
        const before = await getStats(v.deps, v.user.email);
        if (!unlockedTools(before?.total ?? 0).includes(tool)) throw forbidden(`${tool.name} is not unlocked yet`);

        const now = v.deps.now().toISOString();
        const flip: Flip = { id: v.deps.newId(), score: scoreOf(damage, hangMs), damage, hangMs, tool: tool.id, createdAt: now };
        await v.deps.store.put({ PK: `FLIPS#${v.user.email}`, SK: `${now}#${flip.id}`, ...flip });
        const stats: PlayerStats = {
          playerId: before?.playerId ?? v.deps.newId(),
          email: v.user.email,
          name: v.user.name,
          best: Math.max(before?.best ?? 0, flip.score),
          total: (before?.total ?? 0) + flip.score,
          flips: (before?.flips ?? 0) + 1,
          updatedAt: now,
        };
        await v.deps.store.put({ PK: PLAYER, SK: v.user.email, ...stats });
        const newTools = unlockedTools(stats.total).filter((t) => !unlockedTools(before?.total ?? 0).includes(t));
        return {
          status: 201,
          body: { flip, best: stats.best, total: stats.total, flips: stats.flips, newBest: flip.score > (before?.best ?? 0), newTools: newTools.map((t) => t.id) },
          audit: { label: `${flip.score} points with ${tool.id}` },
        };
      },
      { audit: 'flip.record' },
    )
    // Approvers take a (cheating) entry off the board: their best goes back to 0; coinz are kept.
    .approver(
      'DELETE',
      '/leaderboard/:playerId',
      async (req, v) => {
        const found = (await v.deps.store.query<Item & PlayerStats>(PLAYER)).find((p) => p.playerId === req.params.playerId);
        if (!found) throw notFound('That player is not on the board');
        await v.deps.store.put({ ...found, best: 0, updatedAt: v.deps.now().toISOString() });
        return { body: { ok: true }, audit: { label: `${firstName(found.name)} (was ${found.best})`, player: found.email } };
      },
      { audit: 'leaderboard.remove' },
    );
}
