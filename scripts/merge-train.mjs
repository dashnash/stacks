#!/usr/bin/env node
/**
 * Quiet waiters for the merge train (.claude/skills/merge-train/SKILL.md, docs/specs/merge-train.md).
 * A session starts one as a background command; when it exits, the finished command wakes the
 * session, so the train moves on without anyone saying "go". Each prints one line and exits.
 *
 *   node scripts/merge-train.mjs wait-approval <pr>   until the owner approves the current head
 *   node scripts/merge-train.mjs wait-deploy <sha>    until the Deploy run for a merge commit ends
 *
 * Exit codes: 0 approved / deploy green (or nothing to deploy) · 2 changes requested · 3 on hold · 4 PR closed or merged ·
 * 5 deploy failed or cancelled · 6 gave up waiting (re-arm) · 1 error.
 *
 * Waking up is all it does: the session still re-checks every gate in the skill right before it
 * merges. Only review *state* counts, never a comment's text.
 *
 * Env: MERGE_TRAIN_OWNER (default dashnash), GITHUB_REPOSITORY (default dashnash/stacks),
 * GITHUB_TOKEN or GH_TOKEN (else `gh auth token`, else unauthenticated, polled more slowly).
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const HOLD_LABEL = 'hold';
export const EXIT = { ok: 0, approved: 0, error: 1, changesRequested: 2, hold: 3, closed: 4, deployFailed: 5, timeout: 6 };

/** The owner's latest review that counts (COMMENTED ones don't), or undefined. */
export function latestOwnerReview(reviews, owner) {
  const login = owner.toLowerCase();
  return reviews
    .filter((r) => String(r.user?.login ?? '').toLowerCase() === login && r.state !== 'COMMENTED' && r.state !== 'PENDING')
    .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))
    .at(-1);
}

/**
 * What a poll of a PR means for the train: `{ done, code, line }`. `done: false` keeps waiting.
 * The same rule the skill applies before merging: approved means the owner's latest counting
 * review is APPROVED on the PR's current head commit.
 */
export function approvalVerdict(pr, reviews, owner) {
  const n = pr.number;
  if (pr.state !== 'open') return { done: true, code: EXIT.closed, line: `#${n} ${pr.merged ? 'was merged' : 'was closed'}` };
  if ((pr.labels ?? []).some((l) => String(l?.name ?? l).toLowerCase() === HOLD_LABEL)) return { done: true, code: EXIT.hold, line: `#${n} is on hold` };
  const head = pr.head.sha;
  const review = latestOwnerReview(reviews, owner);
  if (review?.state === 'CHANGES_REQUESTED') return { done: true, code: EXIT.changesRequested, line: `#${n}: ${owner} requested changes` };
  if (review?.state === 'APPROVED' && review.commit_id === head) return { done: true, code: EXIT.approved, line: `#${n} approved by ${owner} on ${head.slice(0, 7)}` };
  return { done: false };
}

/** The `Deploy` run (deploy.yml, push to main) for a commit, from a runs listing. */
export const deployRunFor = (runs, sha) => runs.find((r) => r.head_sha === sha);

/** The `changes` job's step that runs only when a push has nothing to deploy (docs only, deploy.yml). */
export const NOTHING_TO_DEPLOY = /^Nothing to deploy/;

/**
 * What a finished Deploy run means: `{ code, line }`. `jobs` from the run's jobs listing. Green
 * needs a successful run and every smoke step green, or, with no smoke step at all, the `changes`
 * job's "Nothing to deploy" step succeeded (a docs-only push: every deploy job skipped on purpose).
 */
export function deployVerdict(run, jobs) {
  const steps = jobs.flatMap((j) => (j.steps ?? []).map((s) => ({ job: j.name, ...s })));
  const smokes = steps.filter((s) => /smoke/i.test(s.name)).map((s) => `${s.job} ${s.conclusion}`);
  const nothing = !smokes.length && steps.some((s) => NOTHING_TO_DEPLOY.test(s.name) && s.conclusion === 'success');
  const smokesOk = smokes.length > 0 && smokes.every((s) => s.endsWith(' success'));
  const ok = run.conclusion === 'success' && (smokesOk || nothing);
  const detail = smokes.length ? ` (smoke: ${smokes.join(', ')})` : nothing ? ' (nothing to deploy: docs only)' : ' (no smoke steps found)';
  return {
    code: ok ? EXIT.ok : EXIT.deployFailed,
    line: `Deploy ${run.id} for ${run.head_sha.slice(0, 7)}: ${run.conclusion}${detail} ${run.html_url ?? ''}`.trim(),
  };
}

function token() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The token, if GitHub accepts it (some environments hold one meant for a proxy); else undefined. */
export async function usableToken(auth, f = globalThis.fetch, api = 'https://api.github.com') {
  if (!auth) return undefined;
  try {
    const res = await f(`${api}/rate_limit`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${auth}` } });
    if (res.status === 401) {
      console.error('GitHub rejected the token; polling unauthenticated (every 2 minutes).');
      return undefined;
    }
  } catch {
    // A network hiccup isn't a verdict on the token.
  }
  return auth;
}

/** A small GitHub client. On a rate limit it waits for the reset instead of failing. */
export function client({ fetch: f = globalThis.fetch, auth = token(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), api = 'https://api.github.com' } = {}) {
  return async function get(path) {
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${api}${path}`, {
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      });
      if (res.ok) return res.json();
      const limited = (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0';
      if (limited && attempt < 3) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        await sleep(Math.max(5_000, Math.min(reset - Date.now() + 1_000, 30 * 60_000)));
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(15_000);
        continue;
      }
      throw new Error(`GET ${path}: ${res.status}`);
    }
  };
}

/** Polls until `poll()` returns `{ done: true }` or `maxWaitMs` passes. */
export async function waitFor(poll, { intervalMs, maxWaitMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const until = now() + maxWaitMs;
  for (;;) {
    const v = await poll();
    if (v.done) return v;
    if (now() + intervalMs > until) return { done: true, code: EXIT.timeout, line: v.timeoutLine ?? 'gave up waiting: start the waiter again' };
    await sleep(intervalMs);
  }
}

export async function waitApproval(get, { repo, pr, owner, intervalMs, maxWaitMs, sleep, now }) {
  return waitFor(
    async () => {
      const [p, reviews] = await Promise.all([get(`/repos/${repo}/pulls/${pr}`), get(`/repos/${repo}/pulls/${pr}/reviews?per_page=100`)]);
      return { ...approvalVerdict(p, reviews, owner), timeoutLine: `#${pr} still waiting for ${owner}'s approval: start the waiter again` };
    },
    { intervalMs, maxWaitMs, sleep, now },
  );
}

export async function waitDeploy(get, { repo, sha, intervalMs, maxWaitMs, sleep, now }) {
  return waitFor(
    async () => {
      const { workflow_runs: runs = [] } = await get(`/repos/${repo}/actions/workflows/deploy.yml/runs?branch=main&event=push&per_page=20`);
      const run = deployRunFor(runs, sha);
      if (!run || run.status !== 'completed') return { done: false, timeoutLine: `Deploy for ${sha.slice(0, 7)} ${run ? `still ${run.status}` : 'not started'}: start the waiter again` };
      const { jobs = [] } = await get(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=50`);
      return { done: true, ...deployVerdict(run, jobs) };
    },
    { intervalMs, maxWaitMs, sleep, now },
  );
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY || 'dashnash/stacks';
  const owner = process.env.MERGE_TRAIN_OWNER || 'dashnash';
  const auth = await usableToken(token());
  const get = client({ auth });
  // Unauthenticated callers get 60 requests an hour, shared by IP: poll gently.
  const intervalMs = (auth ? 30 : 120) * 1000;
  // Background commands in a session are stopped after two hours; exit before that so it can re-arm.
  const maxWaitMs = Number(process.env.MERGE_TRAIN_MAX_WAIT_MS) || 110 * 60_000;
  let result;
  if (cmd === 'wait-approval' && /^\d+$/.test(arg ?? '')) result = await waitApproval(get, { repo, pr: Number(arg), owner, intervalMs, maxWaitMs });
  else if (cmd === 'wait-deploy' && /^[0-9a-f]{40}$/.test(arg ?? '')) result = await waitDeploy(get, { repo, sha: arg, intervalMs, maxWaitMs });
  else {
    console.error('Usage: merge-train.mjs wait-approval <pr number> | wait-deploy <40-hex merge commit sha>');
    process.exit(EXIT.error);
  }
  console.log(result.line);
  process.exit(result.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set at startup (cloud sessions
  // reach GitHub only through their proxy): re-run once with it.
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
    });
    process.exit(r.status ?? EXIT.error);
  }
  main().catch((err) => {
    console.error(err.message);
    process.exit(EXIT.error);
  });
}
