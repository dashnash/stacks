import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs script, no types
import { baselineFrom, decide, heldApps, lastGreenDeploy } from '../../../scripts/deploy-changes.mjs';
// @ts-expect-error: plain .mjs script, no types
import { classifyDeploy, isDocsFile, lockfileChanges } from '../../../scripts/pr-paths.mjs';

const known = { appsBefore: ['hello', 'potluck'], appsAfter: ['hello', 'potluck'] };

describe('what a push to main deploys (classifyDeploy)', () => {
  it('deploys nothing for docs/ and Markdown outside apps', () => {
    expect(classifyDeploy(['docs/specs/167-whee-camera.md'], known)).toMatchObject({ mode: 'docs' });
    expect(classifyDeploy(['README.md', 'CLAUDE.md', '.claude/skills/merge-train/SKILL.md', 'packages/api/README.md', 'docs/reviews/x.png'], known)).toMatchObject({ mode: 'docs' });
    expect(classifyDeploy([], known)).toMatchObject({ mode: 'docs', reason: 'nothing changed' });
  });

  it('counts Markdown inside an app folder as that app', () => {
    expect(isDocsFile('apps/hello/BRIEF.md')).toBe(false);
    expect(isDocsFile('apps/README.md')).toBe(true);
    expect(classifyDeploy(['apps/hello/BRIEF.md'], known)).toEqual({ mode: 'app', app: 'hello', reason: 'only apps/hello/ changed' });
  });

  it('deploys just the app when only one app (and the lockfile, and docs) changed', () => {
    expect(classifyDeploy(['apps/potluck/api/routes.ts', 'package-lock.json'], { ...known, lockfile: ['apps/potluck'] })).toMatchObject({ mode: 'app', app: 'potluck' });
    expect(classifyDeploy(['apps/potluck/web/src/App.tsx', 'docs/specs/1-potluck.md'], known)).toMatchObject({ mode: 'app', app: 'potluck' });
  });

  it('deploys everything for platform files, two apps, or only the lockfile', () => {
    expect(classifyDeploy(['packages/api/src/app.ts', 'apps/hello/api/routes.ts'], known)).toMatchObject({ mode: 'full', reason: '1 file(s) outside apps/ changed' });
    expect(classifyDeploy(['.github/workflows/deploy.yml'], known)).toMatchObject({ mode: 'full' });
    expect(classifyDeploy(['stacks.config.json'], known)).toMatchObject({ mode: 'full' });
    expect(classifyDeploy(['apps/hello/a.ts', 'apps/potluck/b.ts'], known)).toMatchObject({ mode: 'full', reason: '2 apps changed (hello, potluck)' });
    expect(classifyDeploy(['package-lock.json'], known)).toMatchObject({ mode: 'full', reason: 'only package-lock.json changed' });
  });

  it('deploys everything for a new or removed app (the platform dashboard lists every app)', () => {
    expect(classifyDeploy(['apps/pantry/app.manifest.json'], { appsBefore: ['hello'], appsAfter: ['hello', 'pantry'] })).toMatchObject({ mode: 'full', reason: expect.stringContaining('is new') });
    expect(classifyDeploy(['apps/pantry/app.manifest.json'], { appsBefore: ['hello', 'pantry'], appsAfter: ['hello'] })).toMatchObject({ mode: 'full', reason: expect.stringContaining('was removed') });
    // A file at apps/ itself is no app folder.
    expect(classifyDeploy(['apps/.gitkeep'], known)).toMatchObject({ mode: 'full' });
  });

  it('allows package-lock.json in an app deploy only for that app\'s own entries', () => {
    const files = ['apps/hello/package.json', 'package-lock.json'];
    expect(classifyDeploy(files, { ...known, lockfile: ['apps/hello', 'apps/hello/node_modules/left-pad'] })).toMatchObject({ mode: 'app', app: 'hello' });
    expect(classifyDeploy(files, { ...known, lockfile: ['apps/hello', 'node_modules/zod'] })).toMatchObject({ mode: 'full', reason: expect.stringContaining('node_modules/zod') });
    expect(classifyDeploy(files, { ...known, lockfile: ['apps/potluck/node_modules/x'] })).toMatchObject({ mode: 'full' });
    // Not told what changed in it: full.
    expect(classifyDeploy(files, known)).toMatchObject({ mode: 'full' });
    const before = { packages: { '': { name: 'root' }, 'apps/hello': { version: '1' }, 'node_modules/zod': { version: '3.0.0' } } };
    const after = { packages: { '': { name: 'root' }, 'apps/hello': { version: '2' }, 'node_modules/zod': { version: '3.0.0' }, 'apps/hello/node_modules/x': { version: '1' } } };
    expect(lockfileChanges(before, after)).toEqual(['apps/hello', 'apps/hello/node_modules/x']);
  });

  it('deploys everything when the app is on hold somewhere (the full deploy leaves it out there)', () => {
    expect(classifyDeploy(['apps/hello/a.ts'], { ...known, heldApps: ['hello'] })).toMatchObject({ mode: 'full', reason: expect.stringContaining('on hold') });
    expect(heldApps({ environments: { staging: { holdApps: ['a'] }, production: { holdApps: ['a', 'b'] } } })).toEqual(['a', 'b']);
    expect(heldApps({ environments: { staging: {} } })).toEqual([]);
  });
});

describe('deploy-changes against a git history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-changes-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (files: Record<string, string>, remove: string[] = []) => {
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    if (remove.length) git('rm', '-q', ...remove);
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'c');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  const config = { environments: { staging: {}, production: {} } };
  const c0 = commit({ 'apps/hello/app.manifest.json': '{}', 'apps/hello/a.ts': '1', 'packages/api/x.ts': '1' });
  const c1 = commit({ 'docs/a.md': 'x' });
  const c2 = commit({ 'apps/hello/a.ts': '2' });
  const c3 = commit({ 'apps/pantry/app.manifest.json': '{}' });
  const c4 = commit({ 'apps/hello/b.ts': 'moved' }, ['apps/hello/a.ts']);

  it('diffs against the last green deploy, so skipped or failed runs count in the next one', () => {
    expect(decide(c0, c1, config, dir)).toMatchObject({ mode: 'docs', base: c0 });
    expect(decide(c1, c2, config, dir)).toMatchObject({ mode: 'app', app: 'hello' });
    // c2's run was replaced or failed: c1 is still the last green one, and hello's change is not lost.
    expect(decide(c1, c3, config, dir)).toMatchObject({ mode: 'full', reason: expect.stringContaining('2 apps') });
    // A docs merge after a failed app deploy redeploys the app.
    expect(decide(c0, c2, config, dir)).toMatchObject({ mode: 'app', app: 'hello' });
  });

  it('redeploys what a failed run touched, even when a revert undid it (no diff against the baseline)', () => {
    // c5 changes the platform and its run fails; c6 reverts it.
    const c5 = commit({ 'packages/api/x.ts': '2' });
    const c6 = commit({ 'packages/api/x.ts': '1' });
    expect(decide(c4, c6, config, dir)).toMatchObject({ mode: 'docs', reason: 'nothing changed' });
    expect(decide(c4, c6, config, dir, [c5])).toMatchObject({ mode: 'full', unsettled: 1 });
    // A failed run that isn't between the baseline and HEAD: full.
    expect(decide(c5, c6, config, dir, [c2])).toMatchObject({ mode: 'full', reason: expect.stringContaining("isn't between") });
  });

  it('reads the lockfile at each side for an app deploy', () => {
    const l = (hello: string, zod: string) => JSON.stringify({ packages: { 'apps/hello': { version: hello }, 'node_modules/zod': { version: zod } } });
    const a = commit({ 'package-lock.json': l('1', '3') });
    const b = commit({ 'package-lock.json': l('2', '3'), 'apps/hello/c.ts': '1' });
    const c = commit({ 'package-lock.json': l('2', '4'), 'apps/hello/c.ts': '2' });
    expect(decide(a, b, config, dir)).toMatchObject({ mode: 'app', app: 'hello' });
    expect(decide(b, c, config, dir)).toMatchObject({ mode: 'full', reason: expect.stringContaining('node_modules/zod') });
  });

  it('sees a new app, and a move within an app', () => {
    expect(decide(c2, c3, config, dir)).toMatchObject({ mode: 'full', reason: expect.stringContaining('apps/pantry is new') });
    expect(decide(c3, c4, config, dir)).toMatchObject({ mode: 'app', app: 'hello' });
  });

  it('deploys everything without a usable baseline', () => {
    expect(decide(undefined, c2, config, dir)).toMatchObject({ mode: 'full', reason: expect.stringContaining('no earlier') });
    expect(decide(c2, c2, config, dir)).toMatchObject({ mode: 'full', reason: expect.stringContaining('second run for one commit') });
    // Not an ancestor (a newer commit as the "baseline").
    expect(decide(c4, c2, config, dir)).toMatchObject({ mode: 'full', reason: expect.stringContaining("isn't an ancestor") });
  });

  it('finds the newest green Deploy run other than this one, and the failed ones after it', async () => {
    const run = (id: number, head_sha: string, conclusion: string | null, status = 'completed') => ({ id, head_sha, status, conclusion });
    const runs = [run(9, 'this', null, 'in_progress'), run(8, 'cancelled', 'cancelled'), run(7, 'failed', 'failure'), run(6, 'green', 'success'), run(5, 'older', 'failure')];
    expect(baselineFrom(runs, 9)).toEqual({ base: 'green', unsettled: ['cancelled', 'failed'] });
    // A re-run keeps its id: it skips itself, even once green.
    expect(baselineFrom([run(6, 'green', 'success'), run(5, 'prev', 'success')], '6')).toEqual({ base: 'prev', unsettled: [] });
    expect(baselineFrom([run(5, 'older', 'failure')], 9)).toEqual({ base: undefined, unsettled: ['older'] });
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ workflow_runs: runs }) };
    };
    expect(await lastGreenDeploy({ repo: 'o/r', runId: '9', fetch })).toEqual({ base: 'green', unsettled: ['cancelled', 'failed'] });
    expect(calls[0]).toContain('/repos/o/r/actions/workflows/deploy.yml/runs?branch=main&event=push&per_page=50');
    await expect(lastGreenDeploy({ repo: 'o/r', fetch: async () => ({ ok: false, status: 403 }) })).rejects.toThrow('403');
  });
});
