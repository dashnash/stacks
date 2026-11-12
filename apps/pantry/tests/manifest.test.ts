import { describe, expect, it } from 'vitest';
import { validateManifest } from '@stacks/manifest';
import raw from '../app.manifest.json';

describe('app.manifest.json', () => {
  it('is valid', () => {
    expect(validateManifest(raw)).toMatchObject({ ok: true });
  });
});
