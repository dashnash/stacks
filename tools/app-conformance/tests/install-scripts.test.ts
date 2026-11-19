import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { installScriptProblems, namesWithInstallScripts, packageName, workspacePaths } from '../../../scripts/install-scripts.mjs';

const root = join(__dirname, '../../..');
const read = (f: string) => JSON.parse(readFileSync(join(root, f), 'utf8'));
const allowlist = { packages: { esbuild: 'why', fsevents: 'why' } };
const lock = (extra: Record<string, unknown> = {}) => ({
  packages: {
    '': { name: 'stacks' },
    'apps/hello': { name: '@stacks/hello' },
    'node_modules/esbuild': { hasInstallScript: true },
    'packages/infra/node_modules/esbuild': { hasInstallScript: true },
    'node_modules/fsevents': { hasInstallScript: true, optional: true },
    'node_modules/react': {},
    ...extra,
  },
});

describe('install scripts (#104)', () => {
  it('passes on the real lockfile and allowlist', () => {
    const real = read('package-lock.json');
    const manifests = Object.fromEntries(
      workspacePaths(real)
        .filter((ws: string) => existsSync(join(root, ws, 'package.json')))
        .map((ws: string) => [ws, read(join(ws, 'package.json'))]),
    );
    expect(installScriptProblems(real, read('scripts/install-scripts-allowlist.json'), manifests)).toEqual([]);
  });

  it('maps lockfile paths to package names', () => {
    expect(packageName('node_modules/esbuild')).toBe('esbuild');
    expect(packageName('packages/x/node_modules/esbuild')).toBe('esbuild');
    expect(packageName('node_modules/@scope/pkg')).toBe('@scope/pkg');
    expect(packageName('node_modules/a/node_modules/@scope/pkg')).toBe('@scope/pkg');
    expect(packageName('apps/hello')).toBeNull();
    expect(namesWithInstallScripts(lock())).toEqual(['esbuild', 'fsevents']);
    expect(workspacePaths(lock())).toEqual(['', 'apps/hello']);
  });

  it('passes when the set matches the allowlist', () => {
    expect(installScriptProblems(lock(), allowlist)).toEqual([]);
  });

  it('fails on a new package with an install script, naming it', () => {
    const problems = installScriptProblems(lock({ 'node_modules/@evil/pkg': { hasInstallScript: true } }), allowlist);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^@evil\/pkg has an install script/);
  });

  it('fails on an allowlist entry that no longer has an install script', () => {
    const problems = installScriptProblems(lock(), { packages: { ...allowlist.packages, sharp: 'why' } });
    expect(problems).toEqual([expect.stringMatching(/^sharp is in .* remove it$/)]);
  });

  it('fails when a workspace has an install lifecycle script', () => {
    const problems = installScriptProblems(lock(), allowlist, { 'apps/hello': { scripts: { postinstall: 'node x.js', test: 'vitest' } }, '': { scripts: { prepare: 'husky' } } });
    expect(problems).toEqual([expect.stringMatching(/^apps\/hello .*"postinstall"/), expect.stringMatching(/^the root .*"prepare"/)]);
  });
});
