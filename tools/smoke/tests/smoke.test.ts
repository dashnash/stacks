import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs script, no types
import { plan, runChecks, summary, targetsFromOutputs } from '../smoke.mjs';

const portal = 'https://auth.test.example';
const outputs = {
  'stacks-test-platform': { PortalURL: `${portal}/` },
  'stacks-test-app-pantry': { SiteURL: 'https://pantry.test.example', ContentBucketName: 'x' },
  'stacks-test-app-hello': { SiteURL: 'https://hello.test.example' },
  'stacks-test-legacy-redirect': {},
};

type Reply = { status: number; body?: unknown; location?: string } | Error;
/** A fetch stub: `routes[url]` is one reply, or a list replayed in order (the last one repeats). */
function stub(routes: Record<string, Reply | Reply[]>) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url === k || (k.endsWith('*') && url.startsWith(k.slice(0, -1))));
    if (!key) throw new Error(`unexpected ${url}`);
    const list = [routes[key]].flat();
    const n = calls.filter((c) => c === url).length - 1;
    const r = list[Math.min(n, list.length - 1)]!;
    if (r instanceof Error) throw r;
    return {
      status: r.status,
      headers: { get: (h: string) => (h.toLowerCase() === 'location' ? (r.location ?? null) : null) },
      json: async () => r.body,
    };
  };
  return { fetch, calls };
}

const healthy = (extra = {}) => ({ status: 200, body: { ok: true, ...extra } });
const green = (): Record<string, Reply | Reply[]> => ({
  [`${portal}/api/health`]: healthy({ platform: true }),
  'https://hello.test.example/api/health': healthy({ app: 'hello' }),
  'https://pantry.test.example/api/health': healthy({ app: 'pantry' }),
  [`${portal}/api/public/catalog`]: { status: 200, body: { apps: [] } },
  'https://hello.test.example/api/auth/login': { status: 302, location: `${portal}/authorize?app=hello&state=s` },
  [`${portal}/authorize?*`]: { status: 302, location: `${portal}/#/signin?next=%2Fauthorize%3Fapp%3Dhello` },
});
const run = (routes: Record<string, Reply | Reply[]>, opts = {}) => {
  const s = stub(routes);
  return runChecks(plan(targetsFromOutputs(outputs), opts), { fetch: s.fetch, sleep: async () => {}, ...opts }).then((results: any[]) => ({ results, calls: s.calls }));
};

describe('smoke check (#100)', () => {
  it('reads the portal and every app from the CDK outputs', () => {
    expect(targetsFromOutputs(outputs)).toEqual({
      portal,
      apps: [
        { slug: 'hello', url: 'https://hello.test.example' },
        { slug: 'pantry', url: 'https://pantry.test.example' },
      ],
    });
    expect(() => targetsFromOutputs({ 'stacks-test-app-hello': { SiteURL: 'x' } })).toThrow(/PortalURL/);
  });

  it('passes when everything answers', async () => {
    const { results } = await run(green());
    expect(results.map((r: any) => [r.name, r.ok])).toEqual([
      ['portal /api/health', true],
      ['hello /api/health', true],
      ['pantry /api/health', true],
      ['portal /api/public/catalog', true],
      ['hello sign-in redirects to the portal', true],
    ]);
  });

  it('fails an app answering 500, after retrying', async () => {
    const { results, calls } = await run({ ...green(), 'https://pantry.test.example/api/health': { status: 500, body: {} } });
    const pantry = results.find((r: any) => r.name === 'pantry /api/health');
    expect(pantry).toMatchObject({ ok: false, attempts: 4, error: expect.stringContaining('500, expected 200') });
    expect(calls.filter((c) => c.startsWith('https://pantry')).length).toBe(4);
  });

  it('recovers when a check fails once (warm-up)', async () => {
    const { results } = await run({ ...green(), [`${portal}/api/health`]: [new Error('ECONNRESET'), healthy()] });
    expect(results[0]).toMatchObject({ ok: true, attempts: 2 });
  });

  it('fails when sign-in redirects somewhere else', async () => {
    const { results } = await run({ ...green(), 'https://hello.test.example/api/auth/login': { status: 302, location: 'https://evil.example/authorize?x' } });
    expect(results.at(-1)).toMatchObject({ ok: false, error: expect.stringContaining('expected 302 to https://auth.test.example/authorize?') });
    const { results: r2 } = await run({ ...green(), [`${portal}/authorize?*`]: { status: 500 } });
    expect(r2.at(-1)).toMatchObject({ ok: false, error: expect.stringContaining('/#/signin?next=') });
  });

  it('only warns about missing secrets', async () => {
    const { results } = await run({ ...green(), 'https://hello.test.example/api/health': healthy({ missingSecrets: ['API_KEY'], missingPlatformKeys: ['CLOUDFLARE_TURN_KEY_ID'] }) });
    expect(results[1]).toMatchObject({ ok: true, warnings: ['missing secrets: API_KEY', 'missing platform keys: CLOUDFLARE_TURN_KEY_ID'] });
    expect(summary('staging', results)).toContain('⚠️ | hello /api/health | missing secrets: API_KEY');
  });

  it('runs only health checks in maintenance', async () => {
    const { results, calls } = await run(green(), { maintenance: true });
    expect(results).toHaveLength(3);
    expect(calls.some((c) => c.includes('catalog') || c.includes('login'))).toBe(false);
  });

  it('fails a health body without ok: true, and a catalog without apps', async () => {
    const { results } = await run({ ...green(), [`${portal}/api/health`]: { status: 200, body: { ok: false } }, [`${portal}/api/public/catalog`]: { status: 200, body: {} } });
    expect(results[0]).toMatchObject({ ok: false, error: expect.stringContaining('"ok": true') });
    expect(results[3]).toMatchObject({ ok: false, error: expect.stringContaining('"apps"') });
    expect(summary('production', results)).toMatch(/^### Smoke check \(production\): 2 failed/);
  });
});
