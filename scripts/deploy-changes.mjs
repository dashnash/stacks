#!/usr/bin/env node
/**
 * deploy.yml's `changes` job: what does this push to main have to deploy? Prints the verdict and
 * writes `mode` (docs | app | full), `app` and `base` to $GITHUB_OUTPUT. The rules are
 * `classifyDeploy` in pr-paths.mjs (tested in tools/app-conformance).
 *
 *   node scripts/deploy-changes.mjs [<base sha>]
 *
 * The baseline is the commit of the last **successful** Deploy run (not the merge's first parent):
 * a failed run, or a queued run that a newer push replaced, may have deployed nothing or only part,
 * so its changes must count in the next run. The files of every run since the baseline that didn't
 * succeed count too: a revert of a failed change has no diff against the baseline, but the stacks
 * the failed run touched still need redeploying. Without a baseline (none found, the API failed,
 * not an ancestor of HEAD, or HEAD itself) it deploys everything.
 *
 * Env: GITHUB_REPOSITORY, GITHUB_TOKEN (actions: read), GITHUB_RUN_ID (this run, skipped),
 * GITHUB_OUTPUT, GITHUB_STEP_SUMMARY. Needs the full history (checkout fetch-depth: 0).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyDeploy, lockfileChanges } from './pr-paths.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });

/**
 * From the newest Deploy runs on main, other than this one, ordered by when they **finished**
 * (`updated_at`; a re-run of an old run deploys its old commit last): `base`, the head commit of
 * the run that last finished green (undefined if none in the page), and `unsettled`, the commits of
 * the completed runs that finished after it without succeeding.
 */
export function baselineFrom(runs, runId) {
  const done = runs.filter((r) => String(r.id) !== String(runId) && r.status === 'completed').sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
  const unsettled = [];
  for (const r of done) {
    if (r.conclusion === 'success') return { base: r.head_sha, unsettled };
    unsettled.push(r.head_sha);
  }
  return { base: undefined, unsettled };
}

/** `baselineFrom` for the repo's recent Deploy runs. */
export async function lastGreenDeploy({ repo, token, runId, fetch: f = globalThis.fetch, api = 'https://api.github.com' }) {
  const res = await f(`${api}/repos/${repo}/actions/workflows/deploy.yml/runs?branch=main&event=push&per_page=50`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`listing Deploy runs: ${res.status}`);
  const { workflow_runs: runs = [] } = await res.json();
  return baselineFrom(runs, runId);
}

/** App slugs (folders with an app.manifest.json) at a commit. */
export const appsAt = (sha, cwd) =>
  git(['ls-tree', '-r', '--name-only', sha, '--', 'apps'], cwd)
    .split('\n')
    .map((f) => /^apps\/([^/]+)\/app\.manifest\.json$/.exec(f)?.[1])
    .filter(Boolean);

/** Every environment's holdApps, from stacks.config.json at the pushed commit. */
export const heldApps = (config) => [...new Set(Object.values(config.environments ?? {}).flatMap((e) => e.holdApps ?? []))];

const isAncestor = (a, b, cwd) => {
  try {
    git(['merge-base', '--is-ancestor', a, b], cwd);
    return true;
  } catch {
    return false;
  }
};
// --no-renames: a moved file counts at both paths (and needs no blobs in a blob:none clone).
const diff = (a, b, cwd) => git(['diff', '--name-only', '--no-renames', a, b], cwd).split('\n').filter(Boolean);
const lockAt = (sha, cwd) => {
  try {
    return JSON.parse(git(['show', `${sha}:package-lock.json`], cwd));
  } catch {
    return undefined;
  }
};

/**
 * The verdict for `head` against `base` (undefined: full), also counting the files `base`..`sha`
 * for every commit in `unsettled` (runs since `base` that didn't succeed). Reads git in `cwd`.
 */
export function decide(base, head, config, cwd, unsettled = []) {
  if (!base) return { mode: 'full', reason: 'no earlier successful Deploy run found' };
  if (base === head) return { mode: 'full', reason: `the last green Deploy run is for ${head.slice(0, 7)} itself (a second run for one commit deploys everything)` };
  if (!isAncestor(base, head, cwd)) return { mode: 'full', reason: `the last green deploy (${base.slice(0, 7)}) isn't an ancestor of ${head.slice(0, 7)}` };
  const others = [...new Set(unsettled)].filter((s) => s !== head);
  const stray = others.find((s) => !isAncestor(base, s, cwd) || !isAncestor(s, head, cwd));
  if (stray) return { mode: 'full', reason: `a failed run's commit (${stray.slice(0, 7)}) isn't between the last green deploy and ${head.slice(0, 7)}` };
  const tips = [head, ...others];
  const changed = [...new Set(tips.flatMap((s) => diff(base, s, cwd)))].sort();
  // The app set at every tip: an app that a failed run added or removed is new or removed too.
  const appsAfter = tips.map((s) => appsAt(s, cwd)).reduce((a, b) => a.filter((x) => b.includes(x)));
  // A lockfile that can't be read at any side leaves `lockfile` undefined: classifyDeploy goes full.
  const locks = changed.includes('package-lock.json') ? [base, ...tips].map((s) => lockAt(s, cwd)) : [];
  const lockfile = locks.length && locks.every(Boolean) ? [...new Set(locks.slice(1).flatMap((l) => lockfileChanges(locks[0], l)))] : undefined;
  const v = classifyDeploy(changed, { appsBefore: appsAt(base, cwd), appsAfter, heldApps: heldApps(config), lockfile });
  return { ...v, base, changed: changed.length, ...(others.length ? { unsettled: others.length } : {}) };
}

async function main() {
  const head = git(['rev-parse', 'HEAD']).trim();
  let base = process.argv[2];
  let source = 'given';
  let unsettled = [];
  if (!base) {
    source = 'last green Deploy';
    try {
      ({ base, unsettled } = await lastGreenDeploy({ repo: process.env.GITHUB_REPOSITORY || 'dashnash/stacks', token: process.env.GITHUB_TOKEN, runId: process.env.GITHUB_RUN_ID }));
    } catch (err) {
      console.log(`::warning title=Deploy changes::${err.message}; deploying everything`);
    }
  }
  const v = decide(base, head, JSON.parse(readFileSync('stacks.config.json', 'utf8')), undefined, unsettled);
  const since = v.base ? ` since ${v.base.slice(0, 7)} (${source}${v.unsettled ? `, plus ${v.unsettled} run(s) since that didn't succeed` : ''})` : '';
  const line = `${v.mode === 'docs' ? 'Nothing to deploy' : v.mode === 'app' ? `Deploying only ${v.app}` : 'Deploying everything'}: ${v.reason}${since}.`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${v.mode}\napp=${v.app ?? ''}\nbase=${v.base ?? ''}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Deploy: ${v.mode}\n\n${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
