import { describe, expect, it } from 'vitest';
import { createTestHarness, memberFor } from '@stacks/testing';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';
import type { GameSummary, Results, ShotRecord } from '../game/protocol';
import { DEFAULT_TUNING } from '../game/tuning';

const harness = () => createTestHarness({ manifest, routes });
type Harness = ReturnType<typeof harness>;
const ANN = { email: 'ann@test.dev', name: 'Ann Archer' };
const BOB = { email: 'bob@test.dev', name: 'Bob Bow' };
const OWNER = { email: 'olive@test.dev', name: 'Olive' };
const ann = 'u_ann_test_dev';
const bob = 'u_bob_test_dev';

const game = (shooterId: string, score: number, extra: Partial<GameSummary> = {}): GameSummary => ({
  mode: 'rounds',
  score,
  rounds: 3,
  accuracy: 0.75,
  shots: 12,
  hits: 9,
  shooterId,
  shooterName: shooterId === ann ? 'Ann Archer' : 'Bob Bow',
  endedAt: 60_000,
  ...extra,
});
const shot = (shooterId: string, t: number, extra: Partial<ShotRecord> = {}): ShotRecord => ({
  t,
  shooterId,
  mode: 'rounds',
  configId: 'abc1234',
  trigger: 'tap',
  hit: true,
  missDist: 0,
  rewindMs: 120,
  latency: { gunRtt: 40, screenRtt: 30, shotToPixel: 170 },
  window: [[-300, 0, 0, 0, 1, 0, 0, 0.1, 0, 0, 0]],
  ...extra,
});
const results = (games: GameSummary[], shots: ShotRecord[] = []): Results => ({
  v: 1,
  startedAt: Date.parse('2026-11-20T12:00:00Z'),
  games,
  shots,
  droppedShots: 0,
  configs: { abc1234: { ...DEFAULT_TUNING, fovGain: 2 }, other12: DEFAULT_TUNING },
});

/** A room Ann started and played, ended by the server with these results. */
async function playedRoom(t: Harness, r: Results, as: typeof ANN = ANN) {
  const { body } = await t.call('POST', '/rooms', { as, body: {} });
  await t.games.open(body.room.id);
  await t.games.end(body.room.id, 'finished', r);
  return body.room.id as string;
}

describe('saving a session', () => {
  it('copies the best Rounds score per shooter to the leaderboard and the shots to telemetry, once', async () => {
    const t = harness();
    const id = await playedRoom(t, results([game(ann, 900), game(ann, 1500), game(ann, 4000, { mode: 'range' }), game(bob, 700)], [shot(ann, 1000), shot(ann, 2000, { hit: false, missDist: 0.02 })]));
    const res = await t.call('POST', `/sessions/${id}/save`, { as: ANN });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ saved: true, shots: 2 });
    expect(t.platform.audit.at(-1)).toMatchObject({ action: 'session.save' });

    const board = (await t.call('GET', '/leaderboard')).body;
    expect(board.entries).toEqual([
      expect.objectContaining({ id: ann, name: 'Ann', score: 1500, rounds: 3 }),
      expect.objectContaining({ id: bob, name: 'Bob', score: 700 }),
    ]);
    // Idempotent: a second save changes nothing.
    const again = await t.call('POST', `/sessions/${id}/save`, { as: ANN });
    expect([again.status, again.body.saved]).toEqual([200, false]);
    expect((await t.call('GET', '/telemetry', { as: ANN })).body.shots).toHaveLength(2);
  });

  it('keeps a better earlier score, and sets a 30-day TTL on shots and configs', async () => {
    const t = harness();
    await t.call('POST', `/sessions/${await playedRoom(t, results([game(ann, 2000)]))}/save`, { as: ANN });
    await t.call('POST', `/sessions/${await playedRoom(t, results([game(ann, 1000)], [shot(ann, 5)]))}/save`, { as: ANN });
    expect((await t.call('GET', '/leaderboard', { as: ANN })).body).toMatchObject({ entries: [expect.objectContaining({ score: 2000 })], best: { score: 2000 } });
    const items = await t.store.query<{ PK: string; SK: string; expiresAt?: number }>(`SHOTS#${ann}`);
    const config = await t.store.get<{ PK: string; SK: string; expiresAt: number }>('CONFIG#abc1234', 'META');
    const in30Days = Math.floor(t.deps.now().getTime() / 1000) + 30 * 86_400;
    // The harness clock moves a little with each call.
    expect(items).toHaveLength(1);
    expect(Math.abs(items[0]!.expiresAt! - in30Days)).toBeLessThan(60);
    expect(Math.abs(config!.expiresAt - in30Days)).toBeLessThan(60);
  });

  it('only the room\'s creator may save it, and only once it is over', async () => {
    const t = harness();
    const { body } = await t.call('POST', '/rooms', { as: ANN, body: {} });
    await t.games.open(body.room.id);
    expect((await t.call('POST', `/sessions/${body.room.id}/save`, { as: ANN })).body.code).toBe('NOT_OVER');
    await t.games.end(body.room.id, 'finished', results([game(ann, 100)]));
    expect((await t.call('POST', `/sessions/${body.room.id}/save`, { as: BOB })).status).toBe(403);
    expect((await t.call('POST', '/sessions/nope/save', { as: ANN })).status).toBe(404);
    expect((await t.call('POST', `/sessions/${body.room.id}/save`)).status).toBe(401);
  });

  it('stores nothing from malformed results, and still marks the room saved', async () => {
    const t = harness();
    const id = await playedRoom(t, { v: 9, games: 'x' } as never);
    expect((await t.call('POST', `/sessions/${id}/save`, { as: ANN })).body).toMatchObject({ saved: true, shots: 0, games: [] });
    expect((await t.call('GET', '/leaderboard')).body.entries).toEqual([]);
  });
});

describe('the leaderboard', () => {
  it('is public (first names, no emails), top 20; the owner can remove a row', async () => {
    const t = harness();
    await t.call('POST', `/sessions/${await playedRoom(t, results([game(ann, 500), game(bob, 900)]))}/save`, { as: ANN });
    const pub = await t.call('GET', '/leaderboard');
    expect(JSON.stringify(pub.body)).not.toContain('@');
    expect(pub.body).toMatchObject({ best: null, canRemove: false });
    expect(pub.body.entries.map((e: { name: string }) => e.name)).toEqual(['Bob', 'Ann']);

    expect((await t.call('DELETE', `/leaderboard/${bob}`, { as: ANN })).status).toBe(403);
    expect((await t.call('GET', '/leaderboard', { as: OWNER, role: 'OWNER' })).body.canRemove).toBe(true);
    expect((await t.call('DELETE', `/leaderboard/${bob}`, { as: OWNER, role: 'OWNER' })).status).toBe(200);
    expect(t.platform.audit.at(-1)).toMatchObject({ action: 'leaderboard.remove' });
    expect((await t.call('GET', '/leaderboard')).body.entries.map((e: { id: string }) => e.id)).toEqual([ann]);
    expect((await t.call('DELETE', `/leaderboard/${bob}`, { as: OWNER, role: 'OWNER' })).status).toBe(404);
  });
});

describe('telemetry', () => {
  async function twoShooters(t: Harness) {
    const shots = [shot(ann, 1000), shot(ann, 2000, { configId: 'other12' }), shot(bob, 3000)];
    await t.call('POST', `/sessions/${await playedRoom(t, results([], shots))}/save`, { as: ANN });
  }

  it('shows you your own shots, newest first, with the configs they used', async () => {
    const t = harness();
    await twoShooters(t);
    const mine = (await t.call('GET', '/telemetry', { as: ANN })).body;
    expect(mine.shots.map((s: ShotRecord) => s.t)).toEqual([2000, 1000]);
    expect(mine.shots[0]).toMatchObject({ at: '2026-11-20T12:00:02.000Z', roomId: expect.any(String) });
    expect(Object.keys(mine.configs).sort()).toEqual(['abc1234', 'other12']);
    expect(mine.configs.abc1234.fovGain).toBe(2);
    expect(mine.everyone).toBe(false);
    expect((await t.call('GET', '/telemetry', { as: BOB })).body.shots).toHaveLength(1);
    // Not anyone else's.
    expect((await t.call('GET', '/telemetry', { as: BOB, query: { user: ann } })).status).toBe(400);
    expect((await t.call('GET', '/telemetry')).status).toBe(401);
  });

  it('shows the owner everyone\'s, or one person\'s; filters by config; pages with next', async () => {
    const t = harness();
    t.platform.members = [memberFor(ANN.email, 'SHOOTER', ANN.name), memberFor(BOB.email, 'SHOOTER', BOB.name)];
    await twoShooters(t);
    const all = (await t.call('GET', '/telemetry', { as: OWNER, role: 'OWNER' })).body;
    expect(all.shots.map((s: ShotRecord) => s.shooterId)).toEqual([bob, ann, ann]);
    expect(all.everyone).toBe(true);
    expect(all.shots.map((s: { shooterName?: string }) => s.shooterName)).toEqual(['Bob Bow', 'Ann Archer', 'Ann Archer']);
    expect((await t.call('GET', '/telemetry', { as: OWNER, role: 'OWNER', query: { user: bob } })).body.shots).toHaveLength(1);
    expect((await t.call('GET', '/telemetry', { as: ANN, query: { configId: 'other12' } })).body.shots.map((s: ShotRecord) => s.t)).toEqual([2000]);

    const first = (await t.call('GET', '/telemetry', { as: OWNER, role: 'OWNER', query: { limit: '2' } })).body;
    expect(first.shots).toHaveLength(2);
    const rest = (await t.call('GET', '/telemetry', { as: OWNER, role: 'OWNER', query: { limit: '2', from: first.next } })).body;
    expect(rest.shots.map((s: ShotRecord) => s.t)).toEqual([1000]);
    expect(rest.next).toBeNull();
    expect((await t.call('GET', '/telemetry', { as: ANN, query: { limit: '0' } })).status).toBe(400);
    expect((await t.call('GET', '/telemetry', { as: ANN, query: { configId: 'Bad!' } })).status).toBe(400);
  });

  it('hides shots past their 30 days even before DynamoDB deletes them', async () => {
    const t = harness();
    await twoShooters(t);
    t.advance(31 * 86_400_000);
    expect((await t.call('GET', '/telemetry', { as: ANN })).body.shots).toEqual([]);
  });
});

describe('your aim settings', () => {
  it('saves a default per person (clamped, by user id), reads it back, and resets it', async () => {
    const t = harness();
    expect((await t.call('GET', '/tuning', { as: ANN })).body).toEqual({ tuning: null });
    const put = await t.call('PUT', '/tuning', { as: ANN, body: { tuning: { mode: 'relative', sensitivity: 0.7, accelCurve: 99, bogus: 1 }, source: 'calibration' } });
    expect(put.status).toBe(200);
    const mine = (await t.call('GET', '/tuning', { as: ANN })).body;
    expect(mine).toMatchObject({ source: 'calibration', tuning: { mode: 'relative', sensitivity: 0.7, accelCurve: 2.5 } });
    expect(mine.tuning).not.toHaveProperty('bogus');
    expect(await t.store.get(`TUNING#${ann}`, 'CURRENT')).toBeTruthy();
    // Bob's is his own.
    expect((await t.call('GET', '/tuning', { as: BOB })).body).toEqual({ tuning: null });
    expect((await t.call('PUT', '/tuning', { as: ANN, body: {} })).status).toBe(400);
    await t.call('DELETE', '/tuning', { as: ANN });
    expect((await t.call('GET', '/tuning', { as: ANN })).body).toEqual({ tuning: null });
    expect((await t.call('GET', '/tuning')).status).toBe(401);
  });
});

describe('training runs', () => {
  const run = (shooterId: string, t: number): NonNullable<Results['training']>[number] => ({
    t,
    shooterId,
    aspect: 1.6,
    report: {
      v: 1,
      base: DEFAULT_TUNING,
      fitted: { ...DEFAULT_TUNING, mode: 'relative', sensitivity: 0.7, beta: 50 },
      before: { jumpErr: 0.1, gain: 1.6, jitter: 0.001, lagMs: 140 },
      after: { jumpErr: 0.03, gain: 1, jitter: 0.001, lagMs: 60 },
      usedJumps: 22,
      totalJumps: 24,
      latencyMs: 60,
      jumps: [],
    },
    trials: [{ kind: 'hold', a: [0.5, 0.5], t0: 600, end: 4600 }],
    raw: [[0, 0, 0, 0, 1, 0, 0, 0.1], [40, 0, 0, 0, 1, 0, 0, 0.1]],
  });

  it('saving a room keeps its runs for 90 days; you list yours (no raw) and fetch one in full', async () => {
    const t = harness();
    const r = { ...results([]), training: [run(ann, 1000), run(bob, 5000)] };
    const saved = await t.call('POST', `/sessions/${await playedRoom(t, r)}/save`, { as: ANN });
    expect(saved.body).toMatchObject({ saved: true, training: 2 });
    const [item] = await t.store.query<{ PK: string; SK: string; expiresAt: number }>(`TRAINING#${ann}`);
    expect(Math.abs(item!.expiresAt - (Math.floor(t.deps.now().getTime() / 1000) + 90 * 86_400))).toBeLessThan(60);

    const mine = (await t.call('GET', '/training', { as: ANN })).body;
    expect(mine.runs).toHaveLength(1);
    expect(mine.runs[0]).toMatchObject({ userId: ann, samples: 2, report: { usedJumps: 22 } });
    expect(mine.runs[0]).not.toHaveProperty('raw');
    // Stored tunings are clamped like any other.
    expect(mine.runs[0].report.fitted.beta).toBe(10);
    const full = await t.call('GET', `/training/${ann}/${encodeURIComponent(mine.runs[0].sk)}`, { as: ANN });
    expect(full.body.run.raw).toHaveLength(2);
    expect((await t.call('GET', `/training/${ann}/${encodeURIComponent(mine.runs[0].sk)}`, { as: BOB })).status).toBe(403);
    expect((await t.call('GET', '/training', { as: BOB, query: { user: ann } })).status).toBe(400);

    // The owner sees everyone's.
    const all = (await t.call('GET', '/training', { as: OWNER, role: 'OWNER' })).body;
    expect(all.runs.map((x: { userId: string }) => x.userId)).toEqual([bob, ann]);
    expect((await t.call('GET', `/training/${ann}/${encodeURIComponent(mine.runs[0].sk)}`, { as: OWNER, role: 'OWNER' })).status).toBe(200);
    t.advance(91 * 86_400_000);
    expect((await t.call('GET', '/training', { as: ANN })).body.runs).toEqual([]);
  });
});
