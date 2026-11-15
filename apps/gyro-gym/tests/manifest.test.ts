import { describe, expect, it } from 'vitest';
import { validateManifest } from '@stacks/manifest';
import raw from '../app.manifest.json';

describe('app.manifest.json', () => {
  it('is valid', () => {
    expect(validateManifest(raw)).toMatchObject({ ok: true });
  });

  it('declares the Game kit it uses, and works signed out', () => {
    expect(raw.native).toEqual(['motion', 'haptics', 'screen']);
    expect(raw.visibility).toBe('public');
    expect(raw.publicRoutes).toEqual(['/']);
  });
});
