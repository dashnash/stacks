import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@stacks/testing';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';

describe(`${manifest.name} API`, () => {
  it('has no routes of its own: nothing is stored on the server', async () => {
    const t = createTestHarness({ manifest, routes });
    expect((await t.call('GET', '/notes', { as: 'max@x.dev', role: manifest.defaultRole })).status).toBe(404);
  });
});
