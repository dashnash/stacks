import { createHash, createHmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { describe, expect, it, vi } from 'vitest';
import { createTestHarness } from '@stacks/testing';
import type { AppManifest } from '@stacks/manifest';
import {
  authorizeRealtime,
  ChannelRegistry,
  MAX_TOKEN_CHANNELS,
  openEnvelope,
  signRealtimeToken,
  verifyRealtimeToken,
  type AppDeps,
  type AppRoutes,
  type RealtimeClaims,
} from '../src/index';
import { appSyncRealtime, signRequest } from '../src/realtime-aws';
import { manifest as base, routes as baseRoutes } from './fixtures';

const manifest: AppManifest = { ...base, modules: ['realtime'] };

const seen: { id: string; user: string }[] = [];
function routes(api: AppRoutes<AppDeps>) {
  baseRoutes(api);
  api.realtime
    .channel('list/*', {
      subscribe: (v, id) => {
        seen.push({ id, user: v.user.id });
        return id !== 'secret';
      },
      publish: false,
    })
    .channel('room/*', { subscribe: () => true, publish: (v) => v.role !== 'READER' })
    .channel('counter/main', { subscribe: true });
  api.member('POST', '/bump', async (_req, v) => {
    await v.deps.realtime.publish('counter/main', { n: 1 });
    return { body: { ok: true } };
  });
}

const harness = () => createTestHarness({ manifest, routes });
const token = (t: ReturnType<typeof harness>, body: unknown, as: string | null = 'ed@test.dev', role = 'EDITOR') =>
  t.call('POST', '/realtime/token', { ...(as ? { as } : {}), role, body });

describe('POST /realtime/token', () => {
  it('signs a 15-minute token for exactly the channels asked for, with where to connect', async () => {
    const t = harness();
    const res = await token(t, { subscribe: ['list/42', 'room/lobby'], publish: ['room/lobby'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ endpoint: 'wss://realtime.stacks.test/event/realtime', host: 'events.stacks.test', namespace: 'app' });
    const now = t.deps.now().getTime();
    const claims = await verifyRealtimeToken(t.realtime.key, res.body.token, now);
    expect(claims).toMatchObject({ u: 'u_ed_test_dev', s: ['list/42', 'room/lobby'], p: ['room/lobby'] });
    expect(Date.parse(res.body.expiresAt) - now).toBeGreaterThan(14 * 60_000);
    expect(Date.parse(res.body.expiresAt) - now).toBeLessThanOrEqual(15 * 60_000);
  });

  it('passes the matched id to the guard', async () => {
    const t = harness();
    seen.length = 0;
    await token(t, { subscribe: ['list/abc-1'] });
    expect(seen).toEqual([{ id: 'abc-1', user: 'u_ed_test_dev' }]);
  });

  it('refuses an undeclared channel, a guard that says no, publishing on a subscribe-only channel, too many channels and signed-out callers', async () => {
    const t = harness();
    expect((await token(t, { subscribe: ['nope/1'] })).body.code).toBe('REALTIME_UNDECLARED');
    expect((await token(t, { subscribe: ['list/secret'] })).body.code).toBe('REALTIME_REFUSED');
    expect((await token(t, { subscribe: ['room/1'], publish: ['room/1'] }, 'rita@test.dev', 'READER')).body.code).toBe('REALTIME_REFUSED');
    expect((await token(t, { publish: ['list/42'] })).body.code).toBe('REALTIME_SUBSCRIBE_ONLY');
    expect((await token(t, { publish: ['counter/main'] })).body.code).toBe('REALTIME_SUBSCRIBE_ONLY');
    const many = Array.from({ length: MAX_TOKEN_CHANNELS + 1 }, (_, i) => `room/r${i}`);
    expect((await token(t, { subscribe: many })).body.code).toBe('REALTIME_TOO_MANY');
    expect((await token(t, { subscribe: many.slice(0, 15), publish: many.slice(0, 6) })).status).toBe(400);
    expect((await token(t, { subscribe: ['room/1'] }, null)).status).toBe(401);
    expect((await token(t, { subscribe: ['room/*'] })).status).toBe(400);
    expect((await token(t, { subscribe: ['room/-x'] })).status).toBe(400);
    expect((await token(t, { subscribe: ['room/x-'] })).status).toBe(400);
    expect((await token(t, { subscribe: ['room/' + 'a'.repeat(51)] })).status).toBe(400);
    expect((await token(t, { subscribe: ['room/a-b'] })).status).toBe(200);
    expect((await token(t, { subscribe: 'room/1' })).status).toBe(400);
    expect((await token(t, {})).status).toBe(400);
    for (const res of [await token(t, { subscribe: ['nope/1'] }), await token(t, { publish: ['list/42'] })]) expect(res.status).toBe(403);
  });

  it('only exists with the module, and channels can only be declared with it', async () => {
    const off = createTestHarness({ manifest: base, routes: baseRoutes });
    expect((await off.call('POST', '/realtime/token', { as: 'ed@test.dev', body: { subscribe: ['x'] } })).status).toBe(404);
    expect(() => createTestHarness({ manifest: base, routes: (api) => api.realtime.channel('x', { subscribe: true }) })).toThrow(/add "realtime" to "modules"/);
    await expect(off.deps.realtime.publish('x', 1)).rejects.toThrow(/does not have the realtime module/);
  });

  it('lets routes publish, recorded by FakeRealtime', async () => {
    const t = harness();
    await t.call('POST', '/bump', { as: 'ed@test.dev' });
    expect(t.realtime.on('counter/main')).toEqual([{ n: 1 }]);
    await expect(t.deps.realtime.publish('counter/main', { big: 'x'.repeat(5000) })).rejects.toThrow(/limit is 4096/);
  });
});

describe('ChannelRegistry', () => {
  it('rejects bad patterns and prefers literal matches', () => {
    const r = new ChannelRegistry();
    expect(() => r.channel('bad pattern', { subscribe: true })).toThrow(/segments/);
    expect(() => r.channel('a/b/c/d/e', { subscribe: true })).toThrow(/segments/);
    r.channel('room/*', { subscribe: true }).channel('room/lobby', { subscribe: false });
    expect(() => r.channel('room/*', { subscribe: true })).toThrow(/twice/);
    expect(r.match('room/lobby')?.declaration.pattern).toBe('room/lobby');
    expect(r.match('room/x')).toMatchObject({ id: 'x' });
    expect(r.match('room')).toBeNull();
  });
});

describe('authorizeRealtime (the Event API Lambda authorizer)', () => {
  const key = 'k'.repeat(48);
  const now = Date.parse('2026-06-01T00:00:00Z');
  const claims: RealtimeClaims = { v: 1, u: 'u_ed', s: ['counter/main', 'room/lobby'], p: ['room/lobby'], exp: now / 1000 + 900 };
  const ev = (authorizationToken: string, operation: string, channel?: string) => ({
    authorizationToken,
    requestContext: { apiId: 'api', accountId: '1', requestId: 'r', operation, channelNamespaceName: 'app', ...(channel ? { channel } : {}) },
    requestHeaders: {},
  });

  it('allows a valid token to connect, and to subscribe and publish on its own channels, never caching', async () => {
    const t = await signRealtimeToken(key, claims);
    expect(await authorizeRealtime(ev(t, 'EVENT_CONNECT'), key, now)).toEqual({ isAuthorized: true, ttlOverride: 0, handlerContext: { userId: 'u_ed' } });
    expect((await authorizeRealtime(ev(t, 'EVENT_SUBSCRIBE', '/app/counter/main'), key, now)).isAuthorized).toBe(true);
    expect((await authorizeRealtime(ev(t, 'EVENT_PUBLISH', '/app/room/lobby'), key, now)).isAuthorized).toBe(true);
  });

  it('denies an expired token, a bad signature, a channel not in the claims and publishing without a publish claim', async () => {
    const t = await signRealtimeToken(key, claims);
    const deny = { isAuthorized: false, ttlOverride: 0 };
    expect(await authorizeRealtime(ev(t, 'EVENT_CONNECT'), key, now + 901_000)).toEqual(deny);
    expect(await authorizeRealtime(ev(t, 'EVENT_CONNECT'), 'another-key', now)).toEqual(deny);
    const [p, body] = t.split('.');
    const forged = `${p}.${btoa(JSON.stringify({ ...claims, s: ['list/secret'] })).replace(/=+$/, '')}.${t.split('.')[2]}`;
    expect(body).not.toBe(forged.split('.')[1]);
    expect(await authorizeRealtime(ev(forged, 'EVENT_SUBSCRIBE', '/app/list/secret'), key, now)).toEqual(deny);
    expect(await authorizeRealtime(ev(t, 'EVENT_SUBSCRIBE', '/app/list/secret'), key, now)).toEqual(deny);
    expect(await authorizeRealtime(ev(t, 'EVENT_SUBSCRIBE', '/app/*'), key, now)).toEqual(deny);
    expect(await authorizeRealtime(ev(t, 'EVENT_PUBLISH', '/app/counter/main'), key, now)).toEqual(deny);
    expect(await authorizeRealtime(ev(t, 'EVENT_SUBSCRIBE', '/other/counter/main'), key, now)).toEqual(deny);
    // Can't see the channel or the operation: fail closed.
    expect(await authorizeRealtime(ev(t, 'EVENT_SUBSCRIBE'), key, now)).toEqual(deny);
    expect(await authorizeRealtime(ev(t, 'SOMETHING_NEW', '/app/counter/main'), key, now)).toEqual(deny);
    expect(await authorizeRealtime(ev('garbage', 'EVENT_CONNECT'), key, now)).toEqual(deny);
    expect(await authorizeRealtime({}, key, now)).toEqual(deny);
  });
});

describe('appSyncRealtime (server publish)', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'session' };
  const now = new Date('2026-06-01T12:34:56Z');

  it('signs exactly like the AWS SDK signer', async () => {
    const body = JSON.stringify({ channel: '/app/counter/main', events: ['{"d":1,"f":"server"}'] });
    const url = 'https://abc.appsync-api.us-east-1.amazonaws.com/event';
    const ours = signRequest({ url, body, region: 'us-east-1', service: 'appsync', credentials, now });
    class Sha256 {
      private h;
      constructor(secret?: string | Uint8Array) {
        this.h = secret ? createHmac('sha256', secret) : createHash('sha256');
      }
      update(data: string | Uint8Array) {
        this.h.update(data);
      }
      async digest() {
        return new Uint8Array(this.h.digest());
      }
    }
    const signer = new SignatureV4({ credentials, region: 'us-east-1', service: 'appsync', sha256: Sha256 as never, applyChecksum: false, uriEscapePath: true });
    const theirs = await signer.sign(
      { method: 'POST', protocol: 'https:', hostname: 'abc.appsync-api.us-east-1.amazonaws.com', path: '/event', headers: { 'content-type': 'application/json', host: 'abc.appsync-api.us-east-1.amazonaws.com' }, body },
      { signingDate: now },
    );
    expect(ours.authorization).toBe(theirs.headers.authorization);
    expect(ours['x-amz-security-token']).toBe('session');
  });

  it('publishes signed batches of at most five events, in envelopes, and rejects over-4 KB data before sending', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ successful: [], failed: [] }), { status: 200 }));
    const rt = appSyncRealtime({ httpHost: 'abc.appsync-api.us-east-1.amazonaws.com', realtimeHost: 'abc.appsync-realtime-api.us-east-1.amazonaws.com', region: 'us-east-1', key: async () => 'k', credentials: () => credentials, fetch: fetch as never, now: () => now });
    await rt.publish('counter/main', [1, 2, 3, 4, 5, 6, 7]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://abc.appsync-api.us-east-1.amazonaws.com/event');
    expect((init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260601\/us-east-1\/appsync\/aws4_request/);
    const first = JSON.parse(init.body as string);
    expect(first.channel).toBe('/app/counter/main');
    expect(first.events.map((e: string) => openEnvelope(e))).toEqual([1, 2, 3, 4, 5].map((d) => ({ d, f: 'server', i: expect.stringMatching(/^[\w-]{12}$/) })));
    expect(JSON.parse(fetch.mock.calls[1]![1].body as string).events).toHaveLength(2);

    fetch.mockClear();
    await expect(rt.publish('counter/main', [1, 'x'.repeat(4100)])).rejects.toThrow(/limit is 4096/);
    await expect(rt.publish('bad channel', 1)).rejects.toThrow(/not a channel name/);
    expect(fetch).not.toHaveBeenCalled();
    expect(await rt.connection()).toEqual({ key: 'k', endpoint: 'wss://abc.appsync-realtime-api.us-east-1.amazonaws.com/event/realtime', host: 'abc.appsync-api.us-east-1.amazonaws.com', namespace: 'app' });
  });

  it('throws when AppSync reports failed events', async () => {
    const fetch = async () => new Response(JSON.stringify({ failed: [{ identifier: 'x', code: 400 }] }), { status: 200 });
    const rt = appSyncRealtime({ httpHost: 'h', realtimeHost: 'r', region: 'us-east-1', key: async () => 'k', credentials: () => credentials, fetch: fetch as never });
    await expect(rt.publish('counter/main', 1)).rejects.toThrow(/failed/);
  });
});
