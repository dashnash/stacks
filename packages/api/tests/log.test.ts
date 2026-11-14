import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogs, createTestHarness } from '@stacks/testing';
import { log, logClientError, runInLogScope, serializeError, setLogUser, writeLog, type LogLine } from '../src/log';
import { Router } from '../src/router';
import { manifest, routes } from './fixtures';

let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.stop());

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
const event = (method: string, path: string, extra: Record<string, unknown> = {}) =>
  ({ rawPath: path, requestContext: { http: { method }, requestId: 'abcd1234-rest-of-the-id' }, headers: {}, ...extra }) as unknown as APIGatewayProxyEventV2;
const ofType = (type: string) => logs.lines.filter((l) => l.type === type);

describe('log', () => {
  it('writes the base fields on every line, and the request fields inside a request', () => {
    log.info('outside', { n: 1 });
    expect(logs.lines[0]).toEqual({ type: 'app', level: 'info', message: 'outside', app: expect.any(String), env: 'dev', build: 'dev', n: 1 });

    runInLogScope({ app: 'notes', requestId: 'abcd1234-xyz', ref: 'abcd1234', route: '/api/notes/:id' }, () => {
      setLogUser('u_ann');
      log.warn('inside');
      writeLog('error', 'error', 'Unhandled error', new Error('boom'));
      writeLog('client-error', 'error', 'x is not a function', { source: 'error' });
    });
    const [, app, error, client] = logs.lines;
    const request = { app: 'notes', env: 'dev', build: 'dev', requestId: 'abcd1234-xyz', ref: 'abcd1234', route: '/api/notes/:id', userId: 'u_ann' };
    expect(app).toEqual({ type: 'app', level: 'warn', message: 'inside', ...request });
    expect(error).toEqual({ type: 'error', level: 'error', message: 'Unhandled error', ...request, error: { name: 'Error', message: 'boom', stack: expect.stringContaining('log.test.ts') } });
    expect(client).toEqual({ type: 'client-error', level: 'error', message: 'x is not a function', ...request, source: 'error' });
  });

  it('reads the environment and build from the stack', () => {
    vi.stubEnv('STACKS_ENV_TAG', 'test');
    vi.stubEnv('STACKS_BUILD_SHA', 'abc1234');
    log.info('x');
    expect(logs.lines[0]).toMatchObject({ env: 'test', build: 'abc1234' });
    vi.unstubAllEnvs();
  });

  it('carries the request context into nested async calls', async () => {
    const deep = async () => {
      await tick();
      await Promise.all([tick(), tick()]);
      log.info('deep');
    };
    await runInLogScope({ requestId: 'r-1', ref: 'r-1' }, async () => {
      await tick();
      await deep();
    });
    expect(logs.lines[0]).toMatchObject({ message: 'deep', requestId: 'r-1' });
    log.info('after');
    expect(logs.lines[1]).not.toHaveProperty('requestId');
  });

  it('keeps two interleaved requests apart', async () => {
    const request = (id: string, user: string) =>
      runInLogScope({ requestId: id, ref: id }, async () => {
        await tick();
        setLogUser(user);
        for (let i = 0; i < 3; i++) {
          await tick();
          log.info(`step ${i}`, { expect: id });
        }
      });
    await Promise.all([request('one', 'u_one'), request('two', 'u_two')]);
    expect(logs.lines).toHaveLength(6);
    for (const line of logs.lines) expect(line).toMatchObject({ requestId: line.expect, userId: `u_${String(line.expect)}` });
  });

  it('serializes errors, as the argument or as a field, and never lets fields replace the standard ones', () => {
    class Odd extends Error {
      name = 'OddError';
    }
    expect(serializeError(new Odd('strange'))).toEqual({ name: 'OddError', message: 'strange', stack: expect.any(String) });
    expect(serializeError('just text')).toEqual({ name: 'NonError', message: 'just text' });
    expect(serializeError({ code: 7 })).toEqual({ name: 'NonError', message: '{"code":7}' });

    log.error('failed', new Odd('strange'));
    log.error('failed', { error: new Error('inner'), listId: 'l1', type: 'request', app: 'spoof', userId: 'u_spoof' });
    log.error('failed', 'a string was thrown');
    expect(logs.lines[0]!.error).toMatchObject({ name: 'OddError', message: 'strange' });
    expect(logs.lines[1]).toMatchObject({ type: 'app', listId: 'l1', error: { name: 'Error', message: 'inner' } });
    expect(logs.lines[1]!.app).not.toBe('spoof');
    expect(logs.lines[1]).not.toHaveProperty('userId');
    expect(logs.lines[2]!.error).toEqual({ name: 'NonError', message: 'a string was thrown' });
  });

  it('never throws, even for fields that cannot be read', () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('no'); } });
    expect(() => log.info('x', hostile)).not.toThrow();
  });

  it('prints warnings and errors outside Lambda, and everything (as objects) inside it', () => {
    logs.stop();
    const out = { log: vi.spyOn(console, 'log').mockImplementation(() => undefined), warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined), error: vi.spyOn(console, 'error').mockImplementation(() => undefined) };
    log.info('quiet');
    log.warn('w');
    log.error('e');
    expect(out.log).not.toHaveBeenCalled();
    expect(out.warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'w', level: 'warn' }));
    expect(out.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'e', level: 'error' }));
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'fn');
    log.info('loud');
    expect(out.log).toHaveBeenCalledWith(expect.objectContaining({ message: 'loud', type: 'app' }));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
});

describe('request lines', () => {
  const router = new Router({ app: 'notes' })
    .add('GET', '/items/:id', async () => {
      await tick();
      log.info('reading');
      return { body: { ok: true } };
    })
    .add('POST', '/items', async () => ({ status: 201 }))
    .add('GET', '/boom', async () => {
      await tick();
      throw new TypeError('kaput');
    })
    .add('GET', '/authorize', async () => ({ redirect: 'https://elsewhere.test/' }));

  it('writes one line per request with the route pattern, never the raw path', async () => {
    await router.handle(event('GET', '/api/items/secret-id-42', { queryStringParameters: { q: 'private' } }));
    expect(ofType('request')).toEqual([
      { type: 'request', level: 'info', message: 'request', app: 'notes', env: 'dev', build: 'dev', requestId: 'abcd1234-rest-of-the-id', ref: 'abcd1234', route: '/api/items/:id', method: 'GET', status: 200, durationMs: expect.any(Number) },
    ]);
    expect(ofType('app')[0]).toMatchObject({ message: 'reading', ref: 'abcd1234', route: '/api/items/:id' });
    expect(JSON.stringify(logs.lines)).not.toMatch(/secret-id-42|private/);
  });

  it('logs the status of other answers, routes outside /api, and "unmatched" when nothing matches', async () => {
    await router.handle(event('POST', '/api/items'));
    await router.handle(event('GET', '/authorize'));
    await router.handle(event('GET', '/api/nothing/here'));
    await router.handle(event('DELETE', '/api/items'));
    expect(ofType('request').map((l) => [l.method, l.route, l.status])).toEqual([
      ['POST', '/api/items', 201],
      ['GET', '/authorize', 302],
      ['GET', 'unmatched', 404],
      ['DELETE', '/api/items', 405],
    ]);
    expect(ofType('error')).toEqual([]);
  });

  it('answers an unhandled error with a 500 whose ref is on the error line and the request line', async () => {
    const res = (await router.handle(event('GET', '/api/boom'))) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal server error', code: 'INTERNAL', ref: 'abcd1234' });
    const [error] = ofType('error');
    const [request] = ofType('request');
    expect(error).toMatchObject({ ref: 'abcd1234', route: '/api/boom', app: 'notes', error: { name: 'TypeError', message: 'kaput', stack: expect.stringContaining('kaput') } });
    expect(request).toMatchObject({ ref: 'abcd1234', route: '/api/boom', status: 500 });
  });

  it('makes up a request id when API Gateway gave none (tests, the demo)', async () => {
    const res = (await router.handle({ rawPath: '/api/boom', requestContext: { http: { method: 'GET' } }, headers: {} } as unknown as APIGatewayProxyEventV2)) as { body: string };
    const { ref } = JSON.parse(res.body) as { ref: string };
    expect(ref).toMatch(/^[0-9a-f]{8}$/);
    expect(ofType('request')[0]!.ref).toBe(ref);
  });
});

describe('an app', () => {
  const harness = () => createTestHarness({ manifest: { ...manifest, needsEmail: true }, routes });
  const ann = { email: 'ann.private@test.dev', name: 'Ann Private' };

  it('logs the signed-in user by id, and no email, name, cookie or body', async () => {
    const t = harness();
    const res = await t.call('POST', '/notes', { as: ann, role: 'EDITOR', body: { text: 'body-secret-text' }, query: { q: 'query-secret' }, headers: { 'x-custom': 'header-secret' }, cookies: { other: 'cookie-secret' } });
    expect(res.status).toBe(201);
    const [request] = ofType('request');
    expect(request).toMatchObject({ app: 'notes', method: 'POST', route: '/api/notes', status: 201, userId: 'u_ann_private_test_dev' });
    const all = JSON.stringify(logs.lines);
    expect(all).not.toMatch(/ann\.private@test\.dev|Ann Private|body-secret-text|query-secret|header-secret|cookie-secret|stk_/);
    for (const line of logs.lines) for (const key of Object.keys(line)) expect(key).not.toMatch(/email|cookie|body|header|query|name/i);
  });

  it('writes no error line for an HttpError (4xx)', async () => {
    const t = harness();
    expect((await t.call('POST', '/boom', { as: ann })).status).toBe(400);
    expect((await t.call('GET', '/notes')).status).toBe(401);
    expect(ofType('request').map((l) => l.status)).toEqual([400, 401]);
    expect(ofType('error')).toEqual([]);
    expect(ofType('request')[1]).not.toHaveProperty('userId');
  });

  describe('POST /stacks/client-error', () => {
    const report = { message: 'x is not a function', stack: 'TypeError: x is not a function\n    at a.js:1:1', source: 'unhandledrejection', path: '/#/notes/7?tab=secret', build: 'abc1234' };

    it('is accepted signed out and signed in (with the user id), and stores nothing', async () => {
      const t = harness();
      const out = await t.call('POST', '/stacks/client-error', { body: report });
      expect(out.status).toBe(204);
      expect(out.body).toBeUndefined();
      expect((await t.call('POST', '/stacks/client-error', { as: ann, body: report })).status).toBe(204);
      const [signedOut, signedIn] = ofType('client-error') as [LogLine, LogLine];
      expect(signedOut).toMatchObject({ level: 'error', app: 'notes', message: 'x is not a function', stack: report.stack, source: 'unhandledrejection', path: '/#/notes/7', clientBuild: 'abc1234', route: '/api/stacks/client-error', ref: expect.any(String) });
      expect(signedOut).not.toHaveProperty('userId');
      expect(signedIn.userId).toBe('u_ann_private_test_dev');
      expect([...t.store.items.values()].filter((i) => !i.PK.startsWith('SESSION#') && !i.PK.startsWith('USERSESSIONS#'))).toEqual([]);
      expect(t.platform.audit).toEqual([]);
    });

    it('shortens long text, drops unknown fields and falls back for a bad source', async () => {
      const t = harness();
      await t.call('POST', '/stacks/client-error', { body: { message: 'm'.repeat(900), stack: 's'.repeat(5000), source: 'made-up', email: 'ann.private@test.dev', extra: { nested: true } } });
      const [line] = ofType('client-error') as [LogLine];
      expect(line.message).toHaveLength(500);
      expect(line.stack).toHaveLength(4000);
      expect(line).toMatchObject({ source: 'error', clientBuild: 'dev' });
      expect(line).not.toHaveProperty('email');
      expect(line).not.toHaveProperty('extra');
      expect(line).not.toHaveProperty('path');
    });

    it('refuses a body over 8 KB and a call without the CSRF header', async () => {
      const t = harness();
      expect((await t.call('POST', '/stacks/client-error', { body: { message: 'x', stack: 's'.repeat(9000) } })).status).toBe(400);
      expect((await t.call('POST', '/stacks/client-error', { body: report, noCsrf: true })).body.code).toBe('CSRF');
      expect(ofType('client-error')).toEqual([]);
      expect(logClientError({ message: 'x' })).toBe(true);
    });
  });
});
