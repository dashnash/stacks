#!/usr/bin/env node
/**
 * deploy.yml's `changes` job: what does this push to main have to deploy? Prints the verdict and
 * writes `mode` (docs | app | full), `app` and `base` to $GITHUB_OUTPUT. The rules are
 * `classifyDeploy` in pr-paths.mjs (tested in tools/app-conformance).
 *
 *   node scripts/deploy-changes.mjs [<base sha>]
 *
 * The baseline is the commit of the last **successful** Deploy run (not the merge's first parent):
 * a failed run, or a queued run that a newer push replaced, deploys nothing, so its changes must
 * count in the next run. Without a baseline (none found, the API failed, not an ancestor of HEAD,
 * or HEAD itself) it deploys everything.
 *
 * Env: GITHUB_REPOSITORY, GITHUB_TOKEN (actions: read), GITHUB_RUN_ID (this run, skipped),
 * GITHUB_OUTPUT, GITHUB_STEP_SUMMARY. Needs the full history (checkout fetch-depth: 0).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyDeploy } from './pr-paths.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** The head commit of the newest successful Deploy run on main other than this one, or undefined. */
export async function lastGreenDeploy({ repo, token, runId, fetch: f = globalThis.fetch, api = 'https://api.github.com' }) {
  const res = await f(`${api}/repos/${repo}/actions/workflows/deploy.yml/runs?branch=main&event=push&status=success&per_page=10`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`listing Deploy runs: ${res.status}`);
  const { workflow_runs: runs = [] } = await res.json();
  return runs.find((r) => String(r.id) !== String(runId) && r.conclusion === 'success')?.head_sha;
}

/** App slugs (folders with an app.manifest.json) at a commit. */
export const appsAt = (sha, cwd) =>
  git(['ls-tree', '-r', '--name-only', sha, '--', 'apps'], cwd)
    .split('\n')
    .map((f) => /^apps\/([^/]+)\/app\.manifest\.json$/.exec(f)?.[1])
    .filter(Boolean);

/** Every environment's holdApps, from stacks.config.json at the pushed commit. */
export const heldApps = (config) => [...new Set(Object.values(config.environments ?? {}).flatMap((e) => e.holdApps ?? []))];

/** The verdict for `head` against `base` (undefined: full). Reads git in `cwd`; no network. */
export function decide(base, head, config, cwd) {
  if (!base) return { mode: 'full', reason: 'no earlier successful Deploy run found' };
  if (base === head) return { mode: 'full', reason: `${head.slice(0, 7)} already deployed green: a re-run deploys everything` };
  try {
    git(['merge-base', '--is-ancestor', base, head], cwd);
  } catch {
    return { mode: 'full', reason: `the last green deploy (${base.slice(0, 7)}) isn't an ancestor of ${head.slice(0, 7)}` };
  }
  // --no-renames: a moved file counts at both paths (and needs no blobs in a blob:none clone).
  const changed = git(['diff', '--name-only', '--no-renames', base, head], cwd).split('\n').filter(Boolean);
  return { ...classifyDeploy(changed, { appsBefore: appsAt(base, cwd), appsAfter: appsAt(head, cwd), heldApps: heldApps(config) }), base, changed: changed.length };
}

async function main() {
  const head = git(['rev-parse', 'HEAD']).trim();
  let base = process.argv[2];
  let source = 'given';
  if (!base) {
    source = 'last green Deploy';
    try {
      base = await lastGreenDeploy({ repo: process.env.GITHUB_REPOSITORY || 'dashnash/stacks', token: process.env.GITHUB_TOKEN, runId: process.env.GITHUB_RUN_ID });
    } catch (err) {
      console.log(`::warning title=Deploy changes::${err.message}; deploying everything`);
    }
  }
  const v = decide(base, head, JSON.parse(readFileSync('stacks.config.json', 'utf8')));
  const since = v.base ? ` since ${v.base.slice(0, 7)} (${source})` : '';
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
