#!/usr/bin/env node
/**
 * Smoke check after a deploy (#100): is every API up, does the catalog answer, does sign-in start?
 *
 *   node tools/smoke/smoke.mjs <outputs.json> --env staging|production [--sha <commit>]
 *
 * `outputs.json` is `cdk deploy --outputs-file`: the platform stack's `PortalURL` and each app
 * stack's `SiteURL` (held apps aren't deployed, so they aren't checked). Fails on network errors,
 * 5xx, a wrong status or a wrong redirect. Missing secrets in a health body are warnings. While the
 * environment is in maintenance (stacks.config.json) only the health checks run.
 *
 * Every `/api/health` names the commit it runs (`build`, #105); the table shows it. With `--sha`
 * (the commit just deployed) a stack on another commit, or one that doesn't say, is a warning, never
 * a failure: after a partly failed `cdk deploy --all` that is how mixed versions show (docs/ROLLBACK.md).
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** `{ portal, apps: [{ slug, url }] }` from a CDK outputs file's parsed JSON. */
export function targetsFromOutputs(outputs) {
  let portal;
  const apps = [];
  for (const [stack, values] of Object.entries(outputs ?? {})) {
    if (values?.PortalURL) portal = trim(values.PortalURL);
    const app = /-app-(.+)$/.exec(stack)?.[1];
    if (app && values?.SiteURL) apps.push({ slug: app, url: trim(values.SiteURL) });
  }
  if (!portal) throw new Error('No PortalURL in the outputs file (did the platform stack deploy?)');
  apps.sort((a, b) => a.slug.localeCompare(b.slug));
  return { portal, apps };
}
const trim = (url) => String(url).replace(/\/+$/, '');

/** The app whose sign-in is probed: the reference app when deployed (stable), else the first. */
export const SIGN_IN_PROBE = 'hello';
export const probeApp = (apps) => apps.find((a) => a.slug === SIGN_IN_PROBE) ?? apps[0];

/** The checks to run, in order. Each `run(fetch)` resolves to `{ warnings? }` or throws with the reason. */
export function plan({ portal, apps }, { maintenance = false, sha } = {}) {
  const checks = [
    { name: 'portal /api/health', run: (f) => health(f, `${portal}/api/health`, sha) },
    ...apps.map((a) => ({ name: `${a.slug} /api/health`, run: (f) => health(f, `${a.url}/api/health`, sha) })),
  ];
  if (maintenance) return checks;
  checks.push({ name: 'portal /api/public/catalog', run: (f) => catalog(f, `${portal}/api/public/catalog`, apps.map((a) => a.slug)) });
  const probe = probeApp(apps);
  if (probe) checks.push({ name: `${probe.slug} sign-in redirects to the portal`, run: (f) => signIn(f, probe.url, portal) });
  return checks;
}

async function json(res, url) {
  try {
    return await res.json();
  } catch {
    throw new Error(`${url}: not JSON (${res.status})`);
  }
}

/** The short form of a commit for the table (`dev` and other non-hex values stay as they are). */
export const shortSha = (sha) => (/^[0-9a-f]{40}$/.test(String(sha)) ? String(sha).slice(0, 7) : String(sha));

async function health(f, url, sha) {
  const res = await f(url, { redirect: 'manual' });
  if (res.status !== 200) throw new Error(`${url}: ${res.status}, expected 200`);
  const body = await json(res, url);
  if (body?.ok !== true) throw new Error(`${url}: body has no "ok": true`);
  const warnings = [];
  if (body.missingSecrets?.length) warnings.push(`missing secrets: ${body.missingSecrets.join(', ')}`);
  if (body.missingPlatformKeys?.length) warnings.push(`missing platform keys: ${body.missingPlatformKeys.join(', ')}`);
  const build = typeof body.build === 'string' ? body.build : undefined;
  if (sha && !build) warnings.push(`build unknown (no "build" in /api/health), expected ${shortSha(sha)}`);
  else if (sha && build !== sha) warnings.push(`runs ${shortSha(build)}, not ${shortSha(sha)}: mixed versions (docs/ROLLBACK.md)`);
  return { warnings, build };
}

/**
 * The catalog must list at least one of the apps just deployed: an empty list means the registry
 * read broke. (Not all of them: an archived app stays deployed but leaves the catalog.)
 */
async function catalog(f, url, slugs) {
  const res = await f(url, { redirect: 'manual' });
  if (res.status !== 200) throw new Error(`${url}: ${res.status}, expected 200`);
  const body = await json(res, url);
  if (!Array.isArray(body?.apps)) throw new Error(`${url}: no "apps" list`);
  const listed = new Set(body.apps.map((a) => a?.slug));
  if (slugs.length && !slugs.some((s) => listed.has(s))) throw new Error(`${url}: lists none of the deployed apps (${slugs.join(', ')})`);
  return { warnings: [] };
}

/** App login → the platform's /authorize → (signed out) the portal's sign-in page. */
async function signIn(f, appUrl, portal) {
  const start = `${appUrl}/api/auth/login`;
  const first = await f(start, { redirect: 'manual' });
  const authorize = first.headers.get('location') ?? '';
  if (first.status !== 302 || !authorize.startsWith(`${portal}/authorize?`)) {
    throw new Error(`${start}: ${first.status} to "${authorize}", expected 302 to ${portal}/authorize?…`);
  }
  const second = await f(authorize, { redirect: 'manual' });
  const signin = second.headers.get('location') ?? '';
  if (second.status !== 302 || !signin.startsWith(`${portal}/#/signin?next=`)) {
    throw new Error(`${portal}/authorize: ${second.status} to "${signin}", expected 302 to ${portal}/#/signin?next=…`);
  }
  return { warnings: [] };
}

/** Runs every check with retries; never throws. Returns one result per check. */
export async function runChecks(checks, { fetch: f = globalThis.fetch, attempts = 4, delayMs = 10_000, timeoutMs = 10_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const timed = (url, init) => f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const results = [];
  for (const check of checks) {
    let error;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const { warnings = [], build } = (await check.run(timed)) ?? {};
        results.push({ name: check.name, ok: true, attempts: attempt, warnings, ...(build ? { build } : {}) });
        error = undefined;
        break;
      } catch (err) {
        error = err;
        if (attempt < attempts) await sleep(delayMs);
      }
    }
    if (error) results.push({ name: check.name, ok: false, attempts, warnings: [], error: error.message ?? String(error) });
  }
  return results;
}

/** Escapes a GitHub workflow command message (`%`, CR, LF). */
export const escapeCommand = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** A Markdown table for the job summary. */
export function summary(env, results) {
  const failed = results.filter((r) => !r.ok).length;
  const notes = (r) => [...r.warnings, ...(r.build ? [`build ${shortSha(r.build)}`] : []), ...(r.attempts > 1 ? [`ok after ${r.attempts} tries`] : [])].join('; ');
  const rows = results.map((r) => `| ${r.ok ? (r.warnings.length ? '⚠️' : '✅') : '❌'} | ${r.name} | ${r.ok ? notes(r) : r.error} |`);
  return [`### Smoke check (${env}): ${failed ? `${failed} failed` : 'all passed'}`, '', '| | Check | Notes |', '| --- | --- | --- |', ...rows, ''].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const env = args[args.indexOf('--env') + 1];
  if (!file || !['staging', 'production'].includes(env)) {
    console.error('Usage: smoke.mjs <outputs.json> --env staging|production [--sha <commit>]');
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(new URL('../../stacks.config.json', import.meta.url), 'utf8'));
  const maintenance = config.environments?.[env]?.maintenance === true;
  const targets = targetsFromOutputs(JSON.parse(readFileSync(file, 'utf8')));
  const sha = args.includes('--sha') ? args[args.indexOf('--sha') + 1] : undefined;
  const results = await runChecks(plan(targets, { maintenance, sha }));
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.build ? ` (build ${shortSha(r.build)})` : ''}${r.ok ? r.warnings.map((w) => `\n     warning: ${w}`).join('') : `\n     ${r.error}`}`);
    for (const w of r.warnings) console.log(`::warning title=Smoke ${escapeCommand(r.name)}::${escapeCommand(w)}`);
    if (!r.ok) console.log(`::error title=Smoke check failed (${env})::${escapeCommand(`${r.name}: ${r.error}`)}`);
  }
  if (maintenance) console.log(`${env} is in maintenance: only health checks ran.`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(env, results));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
