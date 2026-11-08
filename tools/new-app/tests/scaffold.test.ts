import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateManifest, type AppManifest } from '@stacks/manifest';
import { manifestFromFlags, personasFor, scaffold } from '../src/scaffold';

const repoRoot = path.resolve(__dirname, '../../..');

/** A throwaway repo root with just the template, for the fast tests. */
function fakeRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stacks-new-app-'));
  cpSync(path.join(repoRoot, 'templates'), path.join(root, 'templates'), { recursive: true });
  mkdirSync(path.join(root, 'apps'));
  return root;
}

const threeRoles: AppManifest = {
  ...manifestFromFlags('potluck', { owner: 'host@x.dev', name: 'Potluck' }),
  roles: [
    { id: 'GUEST', label: 'Guest' },
    { id: 'HOST', label: 'Host', canManageAccess: true, canManageApprovers: true },
    { id: 'COOK', label: 'Cook' },
  ],
  topRole: 'HOST',
  defaultRole: 'GUEST',
};

describe('scaffold (fast)', () => {
  it('makes a valid starting manifest from flags, private by default, and needs an owner', () => {
    const m = manifestFromFlags('pickup-games', { owner: 'Me@X.dev' });
    expect(validateManifest(m)).toMatchObject({ ok: true });
    expect(m).toMatchObject({ name: 'Pickup Games', visibility: 'private', topRole: 'OWNER', owners: ['me@x.dev'] });
    expect(() => manifestFromFlags('x-app', {})).toThrow(/--owner/);
  });

  it('gives every role one demo persona, the top role first', () => {
    expect(personasFor(threeRoles).map((p) => [p.role, p.name])).toEqual([
      ['HOST', 'Olive'],
      ['GUEST', 'Max'],
      ['COOK', 'Priya'],
    ]);
  });

  it("uses the interview's manifest and BRIEF.md, fills placeholders, and leaves none behind", () => {
    const root = fakeRepo();
    const dir = path.join(root, 'apps', 'potluck');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'app.manifest.json'), JSON.stringify({ ...threeRoles, name: 'Pot <luck>' }));
    writeFileSync(path.join(dir, 'BRIEF.md'), '# Our brief');
    const result = scaffold({ repoRoot: root, slug: 'potluck' });
    expect(result.kept.sort()).toEqual(['BRIEF.md', 'app.manifest.json']);
    expect(readFileSync(path.join(dir, 'BRIEF.md'), 'utf8')).toBe('# Our brief');
    expect(readFileSync(path.join(dir, 'web/index.html'), 'utf8')).toContain('<title>Pot &lt;luck&gt;</title>');
    expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name).toBe('@stacks-apps/potluck');
    expect(readFileSync(path.join(dir, 'api/demo-data.ts'), 'utf8')).toContain('role: "COOK"');
    const leftovers = result.created.filter((f) => /__SLUG__|__TITLE__|__PERSONAS__/.test(readFileSync(path.join(dir, f), 'utf8')));
    expect(leftovers).toEqual([]);
    expect(result.created).not.toContain('README.md');
  });

  it('refuses reserved slugs, invalid manifests and folders that already have an app', () => {
    const root = fakeRepo();
    expect(() => scaffold({ repoRoot: root, slug: 'admin', flags: { owner: 'a@b.dev' } })).toThrow(/reserved/);
    const dir = path.join(root, 'apps', 'bad');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'app.manifest.json'), JSON.stringify({ slug: 'bad' }));
    expect(() => scaffold({ repoRoot: root, slug: 'bad' })).toThrow(/"name" is required/);
    scaffold({ repoRoot: root, slug: 'twice', flags: { owner: 'a@b.dev' } });
    expect(() => scaffold({ repoRoot: root, slug: 'twice', flags: { owner: 'a@b.dev' } })).toThrow(/already has files/);
  });
});

// The real guarantee (spec: "scaffold to green tests with 0 Claude tokens"): a new app in this repo
// typechecks, passes its own tests and the platform conformance test, builds (app and demo) and synthesizes.
describe('scaffold (end to end, in the repo)', () => {
  const slug = 'zz-scaffold-check';
  const dir = path.join(repoRoot, 'apps', slug);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('produces an app that typechecks, passes its tests and conformance, builds and synthesizes', () => {
    rmSync(dir, { recursive: true, force: true });
    scaffold({ repoRoot, slug, flags: { owner: 'check@x.dev', visibility: 'public' } });
    const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' } });
    run('npx', ['tsc', '-p', 'tsconfig.json'], dir);
    expect(run('npx', ['vitest', 'run'], dir)).toMatch(/Tests\s+\d+ passed/);
    expect(run('npx', ['vitest', 'run', '-t', slug], path.join(repoRoot, 'tools/app-conformance'))).toMatch(/Tests\s+\d+ passed/);
    run('npx', ['vite', 'build', '--config', 'web/vite.config.ts'], dir);
    run('npx', ['vite', 'build', '--config', 'web/vite.demo.config.ts'], dir);
    run('npx', ['cdk', 'synth', '-c', 'env=staging', '-c', `app=${slug}`, '-q', '-o', path.join(os.tmpdir(), `cdk-${slug}`)], path.join(repoRoot, 'infra'));
    expect(existsSync(path.join(os.tmpdir(), `cdk-${slug}`, `stacks-test-app-${slug}.template.json`))).toBe(true);
  });
});
