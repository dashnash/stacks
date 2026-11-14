import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogs } from '@stacks/testing';
import { createPlatformHarness } from './helpers';

let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.stop());
const ofType = (type: string) => logs.lines.filter((l) => l.type === type);

describe('platform logging', () => {
  it('writes one request line per request as app "platform", with the user id and never the email or name', async () => {
    const h = createPlatformHarness();
    await h.signIn('ann.private@test.dev', 'Ann Private');
    await h.call('GET', '/api/me', { as: 'ann.private@test.dev' });
    await h.call('GET', '/api/nope');
    const id = await h.idOf('ann.private@test.dev');
    expect(ofType('request').map((l) => [l.app, l.method, l.route, l.status, l.userId])).toEqual([
      ['platform', 'POST', '/api/auth/google', 200, undefined],
      ['platform', 'GET', '/api/me', 200, id],
      ['platform', 'GET', 'unmatched', 404, undefined],
    ]);
    expect(JSON.stringify(logs.lines)).not.toMatch(/ann\.private|Ann Private|stp_|test:/);
  });

  it('answers an unhandled error with a ref that finds the error line and the request line', async () => {
    const h = createPlatformHarness();
    h.deps.registry.list = async () => {
      throw new Error('registry down');
    };
    const res = await h.call('GET', '/api/public/catalog');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error', code: 'INTERNAL', ref: expect.stringMatching(/^.{8}$/) });
    expect(ofType('error')).toEqual([expect.objectContaining({ app: 'platform', ref: res.body.ref, route: '/api/public/catalog', error: expect.objectContaining({ message: 'registry down', stack: expect.any(String) }) })]);
    expect(ofType('request')[0]).toMatchObject({ ref: res.body.ref, status: 500 });
  });

  it('logs portal browser errors, signed out or in, and needs the CSRF header', async () => {
    const h = createPlatformHarness();
    const body = { message: 'portal broke', stack: 'Error: portal broke\n    at p.js:1:1', source: 'render', path: '/#/profile', build: 'abc1234', email: 'ann.private@test.dev' };
    expect((await h.call('POST', '/api/stacks/client-error', { body })).status).toBe(204);
    expect((await h.call('POST', '/api/stacks/client-error', { body, as: 'ann.private@test.dev' })).status).toBe(204);
    expect((await h.call('POST', '/api/stacks/client-error', { body, headers: { 'x-stacks-request': '0' } })).status).toBe(403);
    expect((await h.call('POST', '/api/stacks/client-error', { body: { message: 'x'.repeat(9000) } })).status).toBe(400);
    const lines = ofType('client-error');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ app: 'platform', message: 'portal broke', source: 'render', path: '/#/profile', clientBuild: 'abc1234' });
    expect(lines[0]).not.toHaveProperty('userId');
    expect(lines[0]).not.toHaveProperty('email');
    expect(lines[1]!.userId).toBe(await h.idOf('ann.private@test.dev'));
  });
});
