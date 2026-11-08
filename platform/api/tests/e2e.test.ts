import { describe, expect, it } from 'vitest';
import {
  createStacksApp,
  endUserSessions,
  MemoryStore,
  PlatformError,
  type AppDeps,
  type AppRoutes,
  type PlatformClient,
} from '@stacks/api';
import type { AppManifest } from '@stacks/manifest';
import { createPlatformHarness, event, privateApp, publicApp, toRes, type Res } from './helpers';

/**
 * The Phase 2 gate, in memory: two real apps on different subdomains and the real platform, with
 * a browser that keeps cookies per host and follows redirects between them.
 */
function world() {
  const appDeps = new Map<string, AppDeps>();
  const platform = createPlatformHarness({
    revoke: async (slug, email) => {
      await endUserSessions(appDeps.get(slug)!, email);
    },
  });

  const routes = (api: AppRoutes<AppDeps>) =>
    api.member('GET', '/whoami', async (_req, v) => ({ body: { email: v.user.email, name: v.user.name, role: v.role } }));

  const apps = new Map<string, ReturnType<typeof createStacksApp>>();
  for (const manifest of [privateApp, publicApp] as AppManifest[]) {
    const slug = manifest.slug;
    // The app's platform client calls the platform's handler as its server would over HTTPS.
    const client: PlatformClient = {
      async exchangeCode(input) {
        const res = toRes(await platform.app(event('POST', `/api/apps/${slug}/token`, { body: input, headers: { authorization: `Bearer cred-${slug}` } })));
        if (res.status !== 200) throw new PlatformError(res.status, res.body.error);
        return res.body;
      },
      async recordAudit(e) {
        await platform.app(event('POST', `/api/apps/${slug}/audit`, { body: e, headers: { authorization: `Bearer cred-${slug}` } }));
      },
      async portalBar(email) {
        return toRes(await platform.app(event('GET', `/api/apps/${slug}/bar`, { query: { email }, headers: { authorization: `Bearer cred-${slug}` } }))).body;
      },
    };
    let n = 0;
    const deps: AppDeps = {
      store: new MemoryStore(),
      platform: client,
      config: { appOrigin: `https://${slug}.stacks.test`, authOrigin: 'https://auth.stacks.test' },
      now: () => platform.deps.now(),
      newId: () => `${slug}-${++n}`,
    };
    appDeps.set(slug, deps);
    apps.set(slug, createStacksApp({ manifest, deps, routes }));
  }

  /** A browser: one cookie jar per host, follows redirects. */
  class Browser {
    jar = new Map<string, Map<string, string>>();
    visited: string[] = [];

    async request(method: string, url: string, body?: unknown): Promise<Res & { url: string }> {
      const u = new URL(url);
      const cookies = Object.fromEntries(this.jar.get(u.host) ?? []);
      const handler = u.host === 'auth.stacks.test' ? platform.app : apps.get(u.host.split('.')[0]!);
      if (!handler) throw new Error(`no server for ${u.host}`);
      this.visited.push(`${method} ${u.host}${u.pathname}`);
      const res = toRes(await handler(event(method, u.pathname, { cookies, body, query: Object.fromEntries(u.searchParams) })));
      const jar = this.jar.get(u.host) ?? new Map<string, string>();
      for (const c of res.cookies) {
        const [pair] = c.split(';');
        const [name, value] = [pair!.slice(0, pair!.indexOf('=')), decodeURIComponent(pair!.slice(pair!.indexOf('=') + 1))];
        if (/Max-Age=0/.test(c)) jar.delete(name);
        else jar.set(name, value);
      }
      this.jar.set(u.host, jar);
      return { ...res, url };
    }

    /** Navigate, following 302s. Lands on a portal page (hash route) or app page. */
    async go(url: string): Promise<string> {
      for (let i = 0; i < 10; i++) {
        const res = await this.request('GET', url);
        if (!res.location) return url;
        url = new URL(res.location, url).toString();
        if (url.includes('#')) return url; // an SPA page: the browser stops here
      }
      throw new Error('redirect loop');
    }

    /** What the portal SPA does on its sign-in page: Google sign-in, then continue to `next`. */
    async signInOnPortal(pageUrl: string, email: string): Promise<string> {
      await this.request('POST', 'https://auth.stacks.test/api/auth/google', { credential: `test:${email}` });
      const next = decodeURIComponent(new URL(pageUrl).hash.replace('#/signin?next=', ''));
      return this.go(`https://auth.stacks.test${next}`);
    }

    async api(url: string) {
      return this.request('GET', url);
    }
  }

  return { platform, apps, appDeps, Browser };
}

describe('Phase 2 gate: one sign-in across apps', () => {
  it('signs in once, then opens a second app on another subdomain with no second prompt', async () => {
    const w = world();
    const b = new w.Browser();

    // A deep link into the public app while signed out.
    const page = await b.go('https://hello.stacks.test/api/auth/login?return=%2F%23%2Fnotes%2F7');
    expect(page).toMatch(/^https:\/\/auth\.stacks\.test\/#\/signin\?next=/);
    const landed = await b.signInOnPortal(page, 'max@test.dev');
    expect(landed).toBe('https://hello.stacks.test/#/notes/7');
    expect((await b.api('https://hello.stacks.test/api/whoami')).body).toEqual({ email: 'max@test.dev', name: 'max', role: 'MEMBER' });

    // The private app: no sign-in prompt (the portal session is reused), but access must be requested.
    b.visited = [];
    const club = await b.go('https://club.stacks.test/api/auth/login?return=%2F');
    expect(club).toBe('https://club.stacks.test/?stacks_access=access_pending');
    expect(b.visited.some((v) => v.includes('/auth/google'))).toBe(false);
    expect((await b.api('https://club.stacks.test/api/whoami')).status).toBe(401);

    // The owner approves from the grid; the user gets in, again without signing in.
    await w.platform.call('PUT', '/admin/access/club/max@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } });
    expect(await b.go('https://club.stacks.test/api/auth/login?return=%2F')).toBe('https://club.stacks.test/');
    expect((await b.api('https://club.stacks.test/api/whoami')).body.role).toBe('MEMBER');

    // The portal bar inside an app lists the user's apps.
    const bar = await b.api('https://club.stacks.test/api/stacks/bar');
    expect(bar.body.apps.map((a: { slug: string }) => a.slug)).toEqual(['club', 'hello']);
    expect(bar.body.portalUrl).toBe('https://auth.stacks.test/#/');

    // Each app holds its own session cookie; neither can see the other's or the portal's.
    expect([...b.jar.get('club.stacks.test')!.keys()]).toEqual(['__Host-stacks-session']);
    expect(b.jar.get('club.stacks.test')!.get('__Host-stacks-session')).not.toBe(b.jar.get('hello.stacks.test')!.get('__Host-stacks-session'));
  });

  it('revoking access ends the app session within one request; a role change takes effect on the next sign-in', async () => {
    const w = world();
    const b = new w.Browser();
    await w.platform.call('PUT', '/admin/access/club/max@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } });
    const page = await b.go('https://club.stacks.test/api/auth/login?return=%2F');
    await b.signInOnPortal(page, 'max@test.dev');
    expect((await b.api('https://club.stacks.test/api/whoami')).status).toBe(200);

    await w.platform.call('PUT', '/admin/access/club/max@test.dev', { as: 'owner@test.dev', body: { role: 'ADMIN' } });
    expect((await b.api('https://club.stacks.test/api/whoami')).status).toBe(401);
    await b.go('https://club.stacks.test/api/auth/login?return=%2F');
    expect((await b.api('https://club.stacks.test/api/whoami')).body.role).toBe('ADMIN');

    await w.platform.call('PUT', '/admin/access/club/max@test.dev', { as: 'owner@test.dev', body: { role: null } });
    expect((await b.api('https://club.stacks.test/api/whoami')).status).toBe(401);
  });

  it('signing out of one app signs out of the platform and every app', async () => {
    const w = world();
    const b = new w.Browser();
    await w.platform.call('PUT', '/admin/access/club/max@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } });
    await b.signInOnPortal(await b.go('https://hello.stacks.test/api/auth/login?return=%2F'), 'max@test.dev');
    await b.go('https://club.stacks.test/api/auth/login?return=%2F');

    const out = await b.request('POST', 'https://hello.stacks.test/api/auth/logout');
    // (the web SDK adds the CSRF header; the test event helper does too for non-GET)
    expect(out.body.platformLogoutUrl).toBe('https://auth.stacks.test/logout');
    await b.go(out.body.platformLogoutUrl);
    expect((await b.api('https://club.stacks.test/api/whoami')).status).toBe(401);
    expect((await b.api('https://hello.stacks.test/api/whoami')).status).toBe(401);
    expect(await b.go('https://club.stacks.test/api/auth/login?return=%2F')).toMatch(/#\/signin/);
  });

  it('mirrors app activity into the central audit feed', async () => {
    const w = world();
    const b = new w.Browser();
    await b.signInOnPortal(await b.go('https://hello.stacks.test/api/auth/login?return=%2F'), 'max@test.dev');
    const feed = await w.platform.call('GET', '/admin/audit', { as: 'root@test.dev', query: { app: 'hello' } });
    expect(feed.body.events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['auth.login', 'grant.auto']));
  });
});
