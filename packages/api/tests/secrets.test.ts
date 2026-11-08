import { describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@stacks/testing';
import type { AppManifest } from '@stacks/manifest';
import { appSecrets } from '../src/lambda';
import { manifest as base, routes } from './fixtures';

const manifest: AppManifest = {
  ...base,
  secrets: [{ name: 'MAPS_KEY' }, { name: 'BOOKS_KEY', optional: true }],
};

describe('appSecrets', () => {
  const fakeSsm = (values: Record<string, string>) => {
    const send = vi.fn(async (cmd: { input: { Name: string; WithDecryption?: boolean } }) => {
      const value = values[cmd.input.Name];
      if (value === undefined) throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      return { Parameter: { Value: value } };
    });
    return { send } as unknown as { send: typeof send };
  };

  it('reads decrypted values under the app prefix and caches them for five minutes', async () => {
    let now = 0;
    const client = fakeSsm({ '/stacks/test/secrets/club/MAPS_KEY': 'm-1' });
    const secret = appSecrets(manifest, { client: client as never, prefix: '/stacks/test/secrets/club/', now: () => now });
    expect(await secret('MAPS_KEY')).toBe('m-1');
    expect(await secret('MAPS_KEY')).toBe('m-1');
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0]![0].input).toEqual({ Name: '/stacks/test/secrets/club/MAPS_KEY', WithDecryption: true });
    now += 5 * 60_000 + 1;
    await secret('MAPS_KEY');
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('reads an unset secret as undefined and refuses names the manifest does not declare', async () => {
    const secret = appSecrets(manifest, { client: fakeSsm({}) as never, prefix: '/p/' });
    expect(await secret('BOOKS_KEY')).toBeUndefined();
    await expect(secret('AWS_SECRET_ACCESS_KEY')).rejects.toThrow(/not declared/);
  });

  it('does not cache failures other than "not found"', async () => {
    const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error('throttled'), { name: 'ThrottlingException' })).mockResolvedValue({ Parameter: { Value: 'ok' } });
    const secret = appSecrets(manifest, { client: { send } as never, prefix: '/p/' });
    await expect(secret('MAPS_KEY')).rejects.toThrow('throttled');
    expect(await secret('MAPS_KEY')).toBe('ok');
  });
});

describe('/health and secrets', () => {
  it('lists required secrets nobody has set (names only), ignoring optional ones', async () => {
    const missing = createTestHarness({ manifest, routes });
    expect((await missing.call('GET', '/health')).body).toEqual({ ok: true, app: manifest.slug, missingSecrets: ['MAPS_KEY'] });
    const set = createTestHarness({ manifest, routes, secrets: { MAPS_KEY: 'shh' } });
    const body = (await set.call('GET', '/health')).body;
    expect(body).toEqual({ ok: true, app: manifest.slug });
    expect(JSON.stringify(body)).not.toContain('shh');
  });
});
