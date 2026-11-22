import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs script, no types
import { approvalVerdict, client, deployVerdict, EXIT, latestOwnerReview, usableToken, waitApproval, waitDeploy } from '../../../scripts/merge-train.mjs';

const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const owner = 'dashnash';
const pr = (extra = {}) => ({ number: 7, state: 'open', merged: false, labels: [], head: { sha: head }, ...extra });
const review = (state: string, commit_id = head, at = '2026-11-22T10:00:00Z', login = owner) => ({ user: { login }, state, commit_id, submitted_at: at });

describe('merge train waiters', () => {
  describe('approvalVerdict (the same rule the skill checks before merging)', () => {
    it('is done when the owner approved the current head', () => {
      expect(approvalVerdict(pr(), [review('APPROVED')], owner)).toEqual({ done: true, code: EXIT.approved, line: '#7 approved by dashnash on aaaaaaa' });
    });

    it('keeps waiting for an approval of an older commit, or from someone else', () => {
      expect(approvalVerdict(pr(), [review('APPROVED', old)], owner).done).toBe(false);
      expect(approvalVerdict(pr(), [review('APPROVED', head, undefined, 'someone')], owner).done).toBe(false);
      expect(approvalVerdict(pr(), [], owner).done).toBe(false);
    });

    it('ignores a COMMENTED review after an approval', () => {
      const reviews = [review('APPROVED', head, '2026-11-22T10:00:00Z'), review('COMMENTED', head, '2026-11-22T11:00:00Z')];
      expect(latestOwnerReview(reviews, owner).state).toBe('APPROVED');
      expect(approvalVerdict(pr(), reviews, owner).code).toBe(EXIT.approved);
    });

    it('stops on changes requested, even after an earlier approval', () => {
      const reviews = [review('APPROVED', head, '2026-11-22T10:00:00Z'), review('CHANGES_REQUESTED', head, '2026-11-22T11:00:00Z')];
      expect(approvalVerdict(pr(), reviews, owner)).toMatchObject({ done: true, code: EXIT.changesRequested });
    });

    it('stops on hold and on a closed or merged PR, before looking at reviews', () => {
      expect(approvalVerdict(pr({ labels: [{ name: 'Hold' }] }), [review('APPROVED')], owner)).toMatchObject({ code: EXIT.hold });
      expect(approvalVerdict(pr({ state: 'closed', merged: true }), [], owner)).toEqual({ done: true, code: EXIT.closed, line: '#7 was merged' });
      expect(approvalVerdict(pr({ state: 'closed' }), [], owner).line).toBe('#7 was closed');
    });
  });

  describe('deployVerdict', () => {
    const run = (conclusion: string) => ({ id: 9, head_sha: head, conclusion, html_url: 'https://x/9' });
    const jobs = (smoke = 'success') => [
      { name: 'staging', steps: [{ name: 'Smoke check', conclusion: 'success' }] },
      { name: 'production', steps: [{ name: 'Smoke check', conclusion: smoke }] },
    ];
    it('is green only with a successful run and every smoke check green', () => {
      expect(deployVerdict(run('success'), jobs())).toMatchObject({ code: EXIT.ok });
      expect(deployVerdict(run('success'), jobs('failure'))).toMatchObject({ code: EXIT.deployFailed });
      expect(deployVerdict(run('failure'), jobs())).toMatchObject({ code: EXIT.deployFailed });
      expect(deployVerdict(run('cancelled'), [])).toMatchObject({ code: EXIT.deployFailed, line: expect.stringContaining('no smoke steps found') });
    });

    // deploy.yml's `changes` job: a docs-only push skips every deploy job on purpose.
    const docsOnly = (nothing = 'success') => [
      { name: 'changes', steps: [{ name: 'Classify', conclusion: 'success' }, { name: 'Nothing to deploy (docs only)', conclusion: nothing }] },
      { name: 'zones', conclusion: 'skipped', steps: [] },
      { name: 'build', conclusion: 'skipped', steps: [] },
      { name: 'staging', conclusion: 'skipped', steps: [] },
      { name: 'production', conclusion: 'skipped', steps: [] },
    ];
    it('is green for a docs-only run that deployed nothing on purpose', () => {
      expect(deployVerdict(run('success'), docsOnly())).toEqual({ code: EXIT.ok, line: 'Deploy 9 for aaaaaaa: success (nothing to deploy: docs only) https://x/9' });
    });

    it('is red when the deploy jobs were skipped without the "Nothing to deploy" step', () => {
      expect(deployVerdict(run('success'), docsOnly('skipped'))).toMatchObject({ code: EXIT.deployFailed, line: expect.stringContaining('no smoke steps found') });
      expect(deployVerdict(run('failure'), docsOnly())).toMatchObject({ code: EXIT.deployFailed });
    });

    it('reads a one-app run like any other: both smoke checks must be green', () => {
      const appRun = [{ name: 'changes', steps: [{ name: 'Classify', conclusion: 'success' }, { name: 'Nothing to deploy (docs only)', conclusion: 'skipped' }] }, ...jobs()];
      expect(deployVerdict(run('success'), appRun)).toMatchObject({ code: EXIT.ok, line: expect.stringContaining('smoke: staging success, production success') });
      expect(deployVerdict(run('success'), [appRun[0]!, ...jobs('skipped')])).toMatchObject({ code: EXIT.deployFailed });
    });
  });

  // A fake GitHub: `routes` maps a path prefix to a list of bodies, one per call (the last repeats).
  const fakeGet = (routes: Record<string, unknown[]>) => {
    const counts: Record<string, number> = {};
    return async (path: string) => {
      const key = Object.keys(routes).find((k) => path.startsWith(k))!;
      const n = (counts[key] = (counts[key] ?? 0) + 1) - 1;
      const list = routes[key]!;
      return list[Math.min(n, list.length - 1)];
    };
  };
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it('wait-approval polls until the approval lands', async () => {
    const get = fakeGet({ '/repos/o/r/pulls/7/reviews': [[], [], [review('APPROVED')]], '/repos/o/r/pulls/7': [pr()] });
    const c = clock();
    const v = await waitApproval(get, { repo: 'o/r', pr: 7, owner, intervalMs: 30_000, maxWaitMs: 600_000, ...c });
    expect(v).toMatchObject({ code: EXIT.approved });
    expect(c.now()).toBe(60_000);
  });

  it('wait-approval gives up after the max wait so the session can re-arm', async () => {
    const get = fakeGet({ '/repos/o/r/pulls/7/reviews': [[]], '/repos/o/r/pulls/7': [pr()] });
    const v = await waitApproval(get, { repo: 'o/r', pr: 7, owner, intervalMs: 30_000, maxWaitMs: 100_000, ...clock() });
    expect(v).toEqual({ done: true, code: EXIT.timeout, line: "#7 still waiting for dashnash's approval: start the waiter again" });
  });

  it('wait-deploy waits for the run of that commit to complete', async () => {
    const running = { id: 9, head_sha: head, status: 'in_progress' };
    const done = { ...running, status: 'completed', conclusion: 'success', html_url: 'u' };
    const other = { id: 8, head_sha: old, status: 'completed', conclusion: 'success' };
    const get = fakeGet({
      '/repos/o/r/actions/workflows/deploy.yml/runs': [{ workflow_runs: [other] }, { workflow_runs: [running, other] }, { workflow_runs: [done, other] }],
      '/repos/o/r/actions/runs/9/jobs': [{ jobs: [{ name: 'staging', steps: [{ name: 'Smoke check', conclusion: 'success' }] }] }],
    });
    const v = await waitDeploy(get, { repo: 'o/r', sha: head, intervalMs: 30_000, maxWaitMs: 600_000, ...clock() });
    expect(v).toMatchObject({ code: EXIT.ok, line: expect.stringContaining('Deploy 9 for aaaaaaa: success (smoke: staging success)') });
  });

  it('the client waits out a rate limit instead of failing', async () => {
    const replies = [
      { ok: false, status: 403, headers: new Map([['x-ratelimit-remaining', '0'], ['x-ratelimit-reset', '0']]) },
      { ok: true, status: 200, headers: new Map(), json: async () => ({ fine: true }) },
    ];
    let slept = 0;
    const get = client({ fetch: async () => replies.shift(), auth: 'T', sleep: async (ms: number) => void (slept += ms) });
    expect(await get('/x')).toEqual({ fine: true });
    expect(slept).toBeGreaterThanOrEqual(5_000);
    const failing = client({ fetch: async () => ({ ok: false, status: 404, headers: new Map() }), auth: 'T', sleep: async () => {} });
    await expect(failing('/missing')).rejects.toThrow('GET /missing: 404');
  });

  it('drops a token GitHub rejects, and keeps one it accepts or that can\'t be checked', async () => {
    expect(await usableToken('T', async () => ({ status: 401 }))).toBeUndefined();
    expect(await usableToken('T', async () => ({ status: 200 }))).toBe('T');
    expect(await usableToken('T', async () => { throw new Error('offline'); })).toBe('T');
    expect(await usableToken(undefined)).toBeUndefined();
  });
});
