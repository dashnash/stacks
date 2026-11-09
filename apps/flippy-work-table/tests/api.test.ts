import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@stacks/testing';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';
import { scoreOf } from '../api/tools';

const harness = () => createTestHarness({ manifest, routes });
const max = { email: 'max@x.dev', name: 'Max Power' };
const ann = { email: 'ann@x.dev', name: 'Ann' };
const flip = (t: ReturnType<typeof harness>, as: typeof max, body: Record<string, unknown>) => t.call('POST', '/flips', { as, role: 'FLIPPER', body });

describe('flips', () => {
  it('records a flip, scores it on the server and keeps best, total and count', async () => {
    const t = harness();
    const first = await flip(t, max, { damage: 1000, hangMs: 2000, tool: 'hand' });
    expect(first.status).toBe(201);
    expect(first.body.flip.score).toBe(scoreOf(1000, 2000));
    expect(first.body.newBest).toBe(true);
    const second = await flip(t, max, { damage: 100, hangMs: 500 });
    expect(second.body).toMatchObject({ best: 1200, total: 1200 + 150, flips: 2, newBest: false });
    const me = await t.call('GET', '/me', { as: max.email, role: 'FLIPPER' });
    expect(me.body).toMatchObject({ best: 1200, total: 1350, flips: 2, rank: 1, canModerate: false });
    expect(me.body.recent.map((f: { score: number }) => f.score)).toEqual([150, 1200]);
    expect(t.platform.audit.map((e) => e.action)).toEqual(['flip.record', 'flip.record']);
  });

  it('needs sign-in and valid numbers', async () => {
    const t = harness();
    expect((await t.call('POST', '/flips', { body: { damage: 1, hangMs: 1 } })).status).toBe(401);
    expect((await t.call('GET', '/me')).status).toBe(401);
    expect((await flip(t, max, { damage: -1, hangMs: 1 })).status).toBe(400);
    expect((await flip(t, max, { damage: 1, hangMs: 999_999 })).status).toBe(400);
    expect((await flip(t, max, { hangMs: 10 })).status).toBe(400);
    expect((await flip(t, max, { damage: 1, hangMs: 1, tool: 'nuke' })).status).toBe(400);
  });

  it('only lets you use tools you have unlocked, and reports new unlocks', async () => {
    const t = harness();
    expect((await flip(t, max, { damage: 10, hangMs: 10, tool: 'boot' })).status).toBe(403);
    const big = await flip(t, max, { damage: 1400, hangMs: 1000 });
    expect(big.body.newTools).toEqual(['boot']);
    expect((await flip(t, max, { damage: 10, hangMs: 10, tool: 'boot' })).status).toBe(201);
  });
});

describe('leaderboard', () => {
  it('is public, best first, first names only and never emails', async () => {
    const t = harness();
    await flip(t, max, { damage: 500, hangMs: 0 });
    await flip(t, ann, { damage: 900, hangMs: 0 });
    const res = await t.call('GET', '/public/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { name: string; best: number }) => [e.name, e.best])).toEqual([
      ['Ann', 900],
      ['Max', 500],
    ]);
    expect(JSON.stringify(res.body)).not.toContain('@');
  });

  it('lets only approvers remove an entry; the player keeps their coinz', async () => {
    const t = harness();
    await flip(t, max, { damage: 40_000, hangMs: 0 });
    const [entry] = (await t.call('GET', '/public/leaderboard')).body.entries;
    expect((await t.call('DELETE', `/leaderboard/${entry.playerId}`, { as: ann.email, role: 'FLIPPER' })).status).toBe(403);
    expect((await t.call('DELETE', `/leaderboard/${entry.playerId}`, { as: 'boss@x.dev', role: 'OWNER' })).status).toBe(200);
    expect((await t.call('DELETE', '/leaderboard/nobody', { as: 'boss@x.dev', role: 'OWNER' })).status).toBe(404);
    expect((await t.call('GET', '/public/leaderboard')).body.entries).toEqual([]);
    expect((await t.call('GET', '/me', { as: max.email, role: 'FLIPPER' })).body).toMatchObject({ best: 0, total: 40_000 });
    expect(t.platform.audit.map((e) => e.action)).toContain('leaderboard.remove');
  });
});
