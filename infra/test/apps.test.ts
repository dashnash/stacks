import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverApps } from '../lib/apps';

describe('discoverApps', () => {
  it('finds and validates every app manifest in the repo', () => {
    const apps = discoverApps(path.resolve(__dirname, '../..'));
    expect(apps.map((a) => a.manifest.slug)).toContain('hello');
  });
});
