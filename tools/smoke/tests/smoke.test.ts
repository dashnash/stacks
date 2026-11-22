import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs script, no types
import { escapeCommand, plan, runChecks, summary, targetsFromOutputs } from '../smoke.mjs';

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
  [`${portal}/api/public/catalog`]: { status: 200, body: { apps: [{ slug: 'hello' }, { slug: 'pantry' }, { slug: 'old' }] } },
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

  it('fails a catalog listing none of the deployed apps, but allows archived ones to be missing', async () => {
    const { results } = await run({ ...green(), [`${portal}/api/public/catalog`]: { status: 200, body: { apps: [] } } });
    expect(results[3]).toMatchObject({ ok: false, error: expect.stringContaining('lists none of the deployed apps (hello, pantry)') });
    const { results: some } = await run({ ...green(), [`${portal}/api/public/catalog`]: { status: 200, body: { apps: [{ slug: 'hello' }] } } });
    expect(some[3]).toMatchObject({ ok: true });
  });

  it('probes sign-in on the reference app even when another sorts first', async () => {
    const withAardvark = { ...outputs, 'stacks-test-app-aardvark': { SiteURL: 'https://aardvark.test.example' } };
    const checks = plan(targetsFromOutputs(withAardvark));
    expect(checks.at(-1).name).toBe('hello sign-in redirects to the portal');
    const noHello = plan(targetsFromOutputs({ 'stacks-test-platform': { PortalURL: portal }, 'stacks-test-app-pantry': { SiteURL: 'https://pantry.test.example' } }));
    expect(noHello.at(-1).name).toBe('pantry sign-in redirects to the portal');
  });

  describe('after an app-only deploy (--portal)', () => {
    const appOnly = { 'stacks-test-app-pantry': { SiteURL: 'https://pantry.test.example' } };
    const runAppOnly = (routes: Record<string, Reply | Reply[]>) => {
      const s = stub(routes);
      return runChecks(plan(targetsFromOutputs(appOnly, { portal: `${portal}/` }), { appsOnly: true }), { fetch: s.fetch, sleep: async () => {}, delayMs: 0 });
    };

    it('checks the given portal, the one app and its sign-in', async () => {
      expect(targetsFromOutputs(appOnly, { portal: `${portal}/` })).toEqual({ portal, apps: [{ slug: 'pantry', url: 'https://pantry.test.example' }] });
      const results = await runAppOnly({
        ...green(),
        'https://pantry.test.example/api/auth/login': { status: 302, location: `${portal}/authorize?app=pantry&state=s` },
      });
      expect(results.map((r: any) => [r.name, r.ok])).toEqual([
        ['portal /api/health', true],
        ['pantry /api/health', true],
        ['portal /api/public/catalog', true],
        ['pantry sign-in redirects to the portal', true],
      ]);
    });

    it('accepts a catalog without the one app (it may be archived), never an empty one', async () => {
      const login = { 'https://pantry.test.example/api/auth/login': { status: 302, location: `${portal}/authorize?app=pantry&state=s` } };
      const without = await runAppOnly({ ...green(), ...login, [`${portal}/api/public/catalog`]: { status: 200, body: { apps: [{ slug: 'hello' }] } } });
      expect(without[2]).toMatchObject({ ok: true });
      const empty = await runAppOnly({ ...green(), ...login, [`${portal}/api/public/catalog`]: { status: 200, body: { apps: [] } } });
      expect(empty[2]).toMatchObject({ ok: false, error: expect.stringContaining('lists no apps') });
    });

    it('doesn\'t warn that the portal is on another commit (it wasn\'t deployed), but still checks the app', async () => {
      const sha = 'a'.repeat(40);
      const s = stub({
        ...green(),
        [`${portal}/api/health`]: healthy({ build: 'b'.repeat(40) }),
        'https://pantry.test.example/api/health': healthy({ build: 'c'.repeat(40) }),
        'https://pantry.test.example/api/auth/login': { status: 302, location: `${portal}/authorize?app=pantry&state=s` },
      });
      const results = await runChecks(plan(targetsFromOutputs(appOnly, { portal }), { appsOnly: true, sha }), { fetch: s.fetch, sleep: async () => {}, delayMs: 0 });
      expect(results[0]).toMatchObject({ ok: true, warnings: [] });
      expect(results[1].warnings[0]).toMatch(/mixed versions/);
    });

    it('doesn\'t count malformed catalog entries as apps', async () => {
      const login = { 'https://pantry.test.example/api/auth/login': { status: 302, location: `${portal}/authorize?app=pantry&state=s` } };
      const results = await runAppOnly({ ...green(), ...login, [`${portal}/api/public/catalog`]: { status: 200, body: { apps: [{}, null] } } });
      expect(results[2]).toMatchObject({ ok: false, error: expect.stringContaining('lists no apps') });
    });

    it('still needs a portal: no PortalURL and no --portal fails', () => {
      expect(() => targetsFromOutputs(appOnly)).toThrow(/--portal/);
    });
  });

  it('escapes workflow command messages', () => {
    expect(escapeCommand('next=%2Fa\nline')).toBe('next=%252Fa%0Aline');
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

  describe('which commit each stack runs (#105)', () => {
    const sha = 'a'.repeat(40);
    const other = 'b'.repeat(40);
    const withBuild = (build?: string) => ({
      ...green(),
      [`${portal}/api/health`]: healthy({ platform: true, build: sha }),
      'https://hello.test.example/api/health': healthy({ app: 'hello', build: sha }),
      'https://pantry.test.example/api/health': healthy({ app: 'pantry', ...(build ? { build } : {}) }),
    });
    const runSha = async (routes: Record<string, Reply | Reply[]>, opts: { sha?: string } = {}) => {
      const { fetch } = stub(routes);
      return runChecks(plan(targetsFromOutputs(outputs), opts), { fetch, sleep: async () => {}, delayMs: 0 });
    };

    it('shows each stack\'s build in the table', async () => {
      const results = await runSha(withBuild(sha), { sha });
      expect(results.every((r: any) => r.ok && !r.warnings.length)).toBe(true);
      expect(summary('staging', results)).toContain('| ✅ | hello /api/health | build aaaaaaa |');
    });

    it('warns, and still passes, when a stack runs another commit', async () => {
      const results = await runSha(withBuild(other), { sha });
      const pantry = results.find((r: any) => r.name === 'pantry /api/health');
      expect(pantry.ok).toBe(true);
      expect(pantry.warnings).toEqual(['runs bbbbbbb, not aaaaaaa: mixed versions (docs/ROLLBACK.md)']);
    });

    it('warns "unknown" for a stack that doesn\'t say (deployed before #105)', async () => {
      const results = await runSha(withBuild(undefined), { sha });
      expect(results.find((r: any) => r.name === 'pantry /api/health').warnings).toEqual(['build unknown (no "build" in /api/health), expected aaaaaaa']);
    });

    it('says nothing about builds without --sha', async () => {
      const results = await runSha(withBuild(other));
      expect(results.every((r: any) => !r.warnings.length)).toBe(true);
    });
  });
});
