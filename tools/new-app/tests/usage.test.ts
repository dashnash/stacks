import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const slug = 'zz-usage-check';
const dir = path.join(repoRoot, 'apps', slug);
const run = (...args: string[]) => execFileSync('npx', ['tsx', path.join(repoRoot, 'tools/new-app/src/usage.ts'), slug, ...args], { encoding: 'utf8', stdio: 'pipe' });

describe('app-usage', () => {
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('appends one entry per step with files changed, time since the last entry, and tokens when given', () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.join(dir, 'api'), { recursive: true });
    writeFileSync(path.join(dir, 'app.manifest.json'), '{}');
    writeFileSync(path.join(dir, 'api/routes.ts'), '');
    run('interview', '--note', 'six questions');
    run('build', '--tokens', '1500');
    const { entries } = JSON.parse(readFileSync(path.join(dir, '.stacks/usage.json'), 'utf8'));
    expect(entries).toEqual([
      expect.objectContaining({ step: 'interview', filesChanged: 2, note: 'six questions' }),
      expect.objectContaining({ step: 'build', tokens: 1500, minutes: expect.any(Number) }),
    ]);
    expect(() => run('lunch')).toThrow();
  });
});
