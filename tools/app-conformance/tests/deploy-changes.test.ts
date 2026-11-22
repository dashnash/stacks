import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs script, no types
import { decide, heldApps, lastGreenDeploy } from '../../../scripts/deploy-changes.mjs';
// @ts-expect-error: plain .mjs script, no types
import { classifyDeploy, isDocsFile } from '../../../scripts/pr-paths.mjs';

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
    expect(classifyDeploy(['apps/potluck/api/routes.ts', 'package-lock.json'], known)).toMatchObject({ mode: 'app', app: 'potluck' });
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

  it('sees a new app, and a move within an app', () => {
    expect(decide(c2, c3, config, dir)).toMatchObject({ mode: 'full', reason: expect.stringContaining('apps/pantry is new') });
    expect(decide(c3, c4, config, dir)).toMatchObject({ mode: 'app', app: 'hello' });
  });

  it('deploys everything without a usable baseline', () => {
    expect(decide(undefined, c2, config, dir)).toMatchObject({ mode: 'full', reason: expect.stringContaining('no earlier') });
    expect(decide(c2, c2, config, dir)).toMatchObject({ mode: 'full', reason: expect.stringContaining('re-run') });
    // Not an ancestor (a newer commit as the "baseline").
    expect(decide(c4, c2, config, dir)).toMatchObject({ mode: 'full', reason: expect.stringContaining("isn't an ancestor") });
  });

  it('finds the newest green Deploy run other than this one', async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ workflow_runs: [{ id: 7, conclusion: 'success', head_sha: 'this' }, { id: 6, conclusion: 'success', head_sha: 'prev' }] }) };
    };
    expect(await lastGreenDeploy({ repo: 'o/r', runId: '7', fetch })).toBe('prev');
    expect(calls[0]).toContain('/repos/o/r/actions/workflows/deploy.yml/runs?branch=main&event=push&status=success');
    expect(await lastGreenDeploy({ repo: 'o/r', runId: '1', fetch: async () => ({ ok: true, json: async () => ({ workflow_runs: [] }) }) })).toBeUndefined();
    await expect(lastGreenDeploy({ repo: 'o/r', fetch: async () => ({ ok: false, status: 403 }) })).rejects.toThrow('403');
  });
});
