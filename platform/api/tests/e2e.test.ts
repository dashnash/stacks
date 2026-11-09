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
    revoke: async (slug, userId) => {
      await endUserSessions(appDeps.get(slug)!, userId);
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
      async access() {
        return toRes(await platform.app(event('GET', `/api/apps/${slug}/access`, { headers: { authorization: `Bearer cred-${slug}` } }))).body;
      },
      async setAccess(actorId, userId, role) {
        const res = toRes(await platform.app(event('PUT', `/api/apps/${slug}/access/${encodeURIComponent(userId)}`, { body: { actorId, role }, headers: { authorization: `Bearer cred-${slug}` } })));
        if (res.status !== 200) throw new PlatformError(res.status, res.body.error, res.body.code);
      },
      async notify(userId, text, link) {
        const res = toRes(await platform.app(event('POST', `/api/apps/${slug}/notify`, { body: { userId, text, link }, headers: { authorization: `Bearer cred-${slug}` } })));
        if (res.status !== 200) throw new PlatformError(res.status, res.body.error, res.body.code);
      },
      async account(userId) {
        return toRes(await platform.app(event('GET', `/api/apps/${slug}/account`, { query: { user: userId }, headers: { authorization: `Bearer cred-${slug}` } }))).body;
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

    async request(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<Res & { url: string }> {
      const u = new URL(url);
      const cookies = Object.fromEntries(this.jar.get(u.host) ?? []);
      const handler = u.host === 'auth.stacks.test' ? platform.app : apps.get(u.host.split('.')[0]!);
      if (!handler) throw new Error(`no server for ${u.host}`);
      this.visited.push(`${method} ${u.host}${u.pathname}`);
      const res = toRes(await handler(event(method, u.pathname, { cookies, body, query: Object.fromEntries(u.searchParams), headers })));
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

    /** What @stacks/web does when an app page loads without a session: ask the platform in the background. */
    async silentSignIn(appOrigin: string): Promise<{ error?: string; signedIn: boolean }> {
      const start = await this.request('GET', `${appOrigin}/api/auth/silent-start`);
      const answer = await this.request('GET', start.body.url, undefined, { origin: appOrigin });
      if (!answer.body.code) return { error: answer.body.error, signedIn: false };
      const done = await this.request('POST', `${appOrigin}/api/auth/silent-finish`, { code: answer.body.code, state: start.body.state });
      return { signedIn: done.status === 200 };
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
    await w.platform.setRole('club', 'max@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } });
    expect(await b.go('https://club.stacks.test/api/auth/login?return=%2F')).toBe('https://club.stacks.test/');
    expect((await b.api('https://club.stacks.test/api/whoami')).body.role).toBe('MEMBER');

    // The account menu inside an app: the user's apps, role here, links back to the portal.
    const account = await b.api('https://club.stacks.test/api/stacks/account');
    expect(account.body.apps.map((a: { slug: string }) => a.slug)).toEqual(['club', 'hello']);
    expect(account.body).toMatchObject({
      portalUrl: 'https://auth.stacks.test/#/',
      profileUrl: 'https://auth.stacks.test/#/profile?from=club',
      app: { slug: 'club', name: 'Book Club', roleLabel: 'Member' },
      manage: null,
    });

    // Each app holds its own session cookie; neither can see the other's or the portal's.
    expect([...b.jar.get('club.stacks.test')!.keys()]).toEqual(['__Host-stacks-session']);
    expect(b.jar.get('club.stacks.test')!.get('__Host-stacks-session')).not.toBe(b.jar.get('hello.stacks.test')!.get('__Host-stacks-session'));
  });

  it('revoking access ends the app session within one request; a role change takes effect on the next sign-in', async () => {
    const w = world();
    const b = new w.Browser();
    await w.platform.setRole('club', 'max@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } });
    const page = await b.go('https://club.stacks.test/api/auth/login?return=%2F');
    await b.signInOnPortal(page, 'max@test.dev');
    expect((await b.api('https://club.stacks.test/api/whoami')).status).toBe(200);

    await w.platform.setRole('club', 'max@test.dev', { as: 'owner@test.dev', body: { role: 'ADMIN' } });
    expect((await b.api('https://club.stacks.test/api/whoami')).status).toBe(401);
    await b.go('https://club.stacks.test/api/auth/login?return=%2F');
    expect((await b.api('https://club.stacks.test/api/whoami')).body.role).toBe('ADMIN');

    await w.platform.setRole('club', 'max@test.dev', { as: 'owner@test.dev', body: { role: null } });
    expect((await b.api('https://club.stacks.test/api/whoami')).status).toBe(401);
  });

  it('signing out of one app signs out of the platform and every app', async () => {
    const w = world();
    const b = new w.Browser();
    await w.platform.setRole('club', 'max@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } });
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

  it('lets an approver manage access from inside the app, with the platform\'s rules', async () => {
    const w = world();
    const owner = new w.Browser();
    const ann = new w.Browser();
    // Ann asks for access to the private app.
    await ann.signInOnPortal(await ann.go('https://club.stacks.test/api/auth/login?return=%2F'), 'ann@test.dev');
    // The owner signs in to the app and sees her request on the app's own admin page.
    await owner.signInOnPortal(await owner.go('https://club.stacks.test/api/auth/login?return=%2F'), 'owner@test.dev');
    const access = await owner.api('https://club.stacks.test/api/stacks/access');
    expect(access.body.pending.map((p: { email: string }) => p.email)).toEqual(['ann@test.dev']);
    expect(access.body.roles.map((r: { id: string }) => r.id)).toEqual(['OWNER', 'ADMIN', 'MEMBER']);

    expect((await owner.request('PUT', `https://club.stacks.test/api/stacks/access/${await w.platform.idOf('ann@test.dev')}`, { role: 'MEMBER' })).status).toBe(200);
    expect(await ann.go('https://club.stacks.test/api/auth/login?return=%2F')).toBe('https://club.stacks.test/');
    expect((await ann.api('https://club.stacks.test/api/stacks/members')).body.members.map((m: { email: string; role: string }) => `${m.email}:${m.role}`)).toEqual([
      'ann@test.dev:MEMBER',
      'owner@test.dev:OWNER',
    ]);
    // Ann (a member) cannot use the access page; the owner cannot demote the last owner.
    expect((await ann.api('https://club.stacks.test/api/stacks/access')).status).toBe(403);
    expect((await owner.request('PUT', `https://club.stacks.test/api/stacks/access/${await w.platform.idOf('owner@test.dev')}`, { role: 'MEMBER' })).status).toBe(409);
    // The change is in the central feed with the owner as actor.
    const feed = await w.platform.call('GET', '/admin/audit', { as: 'root@test.dev', query: { app: 'club', action: 'grant' } });
    expect(feed.body.events.find((e: { action: string; label: string }) => e.action === 'grant.set' && e.label === 'ann').actorId).toBe(await w.platform.idOf('owner@test.dev'));
  });

  it('lets apps notify their own members only', async () => {
    const w = world();
    const b = new w.Browser();
    await b.signInOnPortal(await b.go('https://hello.stacks.test/api/auth/login?return=%2F'), 'max@test.dev');
    const deps = w.appDeps.get('hello')!;
    await deps.platform.notify(await w.platform.idOf('max@test.dev'), 'Your greeting got a reply', 'https://hello.stacks.test/#/x');
    await w.platform.signIn('stranger@test.dev');
    await expect(deps.platform.notify(await w.platform.idOf('stranger@test.dev'), 'spam')).rejects.toMatchObject({ status: 403 });
    const inbox = await w.platform.call('GET', '/notifications', { as: 'max@test.dev' });
    expect(inbox.body.notifications[0]).toMatchObject({ text: 'Your greeting got a reply', link: 'https://hello.stacks.test/#/x', app: 'hello' });
  });

  it('signing in on the portal signs you in to every app, with no click or redirect', async () => {
    const w = world();
    const b = new w.Browser();
    await w.platform.setRole('club', 'max@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } });
    await b.request('POST', 'https://auth.stacks.test/api/auth/google', { credential: 'test:max@test.dev' });
    b.visited = [];
    expect(await b.silentSignIn('https://hello.stacks.test')).toEqual({ signedIn: true });
    expect(await b.silentSignIn('https://club.stacks.test')).toEqual({ signedIn: true });
    expect((await b.api('https://club.stacks.test/api/whoami')).body.role).toBe('MEMBER');
    expect(b.visited.some((v) => v.includes('/authorize') || v.includes('/auth/callback'))).toBe(false);
  });

  it('silent sign-in never files a request for a private app; it answers access_required', async () => {
    const w = world();
    const b = new w.Browser();
    await b.request('POST', 'https://auth.stacks.test/api/auth/google', { credential: 'test:ann@test.dev' });
    expect(await b.silentSignIn('https://club.stacks.test')).toEqual({ error: 'access_required', signedIn: false });
    const grid = await w.platform.call('GET', '/admin/access', { as: 'owner@test.dev' });
    const annId = await w.platform.idOf('ann@test.dev');
    expect(grid.body.grants.filter((g: { userId: string }) => g.userId === annId)).toEqual([]);
    // Without a portal session, the answer is login_required.
    const stranger = new w.Browser();
    expect(await stranger.silentSignIn('https://club.stacks.test')).toEqual({ error: 'login_required', signedIn: false });
  });

  it('silent sign-in tells a blocked person access_denied and does not auto-grant a public app', async () => {
    const w = world();
    await w.platform.setRole('hello', 'troll@test.dev', { as: 'owner@test.dev', body: { role: 'BLOCKED' } });
    const b = new w.Browser();
    await b.request('POST', 'https://auth.stacks.test/api/auth/google', { credential: 'test:troll@test.dev' });
    expect(await b.silentSignIn('https://hello.stacks.test')).toEqual({ error: 'access_denied', signedIn: false });
    const res = await b.go('https://hello.stacks.test/api/auth/login?return=%2F');
    expect(res).toContain('stacks_access=access_denied');
  });

  it('only the app\'s own origin can read the silent answer', async () => {
    const w = world();
    const b = new w.Browser();
    await b.request('POST', 'https://auth.stacks.test/api/auth/google', { credential: 'test:max@test.dev' });
    const start = await b.request('GET', 'https://hello.stacks.test/api/auth/silent-start');
    expect((await b.request('GET', start.body.url, undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await b.request('GET', start.body.url, undefined, { origin: 'https://club.stacks.test' })).status).toBe(403);
    const ok = await b.request('GET', start.body.url, undefined, { origin: 'https://hello.stacks.test' });
    expect(ok.status).toBe(200);
  });

  it('signing out in an app signs you out everywhere and returns you to that app page', async () => {
    const w = world();
    const b = new w.Browser();
    await b.signInOnPortal(await b.go('https://hello.stacks.test/api/auth/login?return=%2F'), 'max@test.dev');
    const out = await b.request('POST', 'https://hello.stacks.test/api/auth/logout');
    const landed = await b.go(`${out.body.platformLogoutUrl}?return=${encodeURIComponent('https://hello.stacks.test/#/greetings/7')}`);
    expect(landed).toBe('https://hello.stacks.test/#/greetings/7');
    expect(await b.silentSignIn('https://hello.stacks.test')).toEqual({ error: 'login_required', signedIn: false });
    // A return address outside the platform's apps is refused: you land on the portal.
    await b.signInOnPortal(await b.go('https://hello.stacks.test/api/auth/login?return=%2F'), 'max@test.dev');
    expect(await b.go(`https://auth.stacks.test/logout?return=${encodeURIComponent('https://evil.example/')}`)).toBe('https://auth.stacks.test/#/?signedOut=1');
  });

  it('mirrors app activity into the central audit feed', async () => {
    const w = world();
    const b = new w.Browser();
    await b.signInOnPortal(await b.go('https://hello.stacks.test/api/auth/login?return=%2F'), 'max@test.dev');
    const feed = await w.platform.call('GET', '/admin/audit', { as: 'root@test.dev', query: { app: 'hello' } });
    expect(feed.body.events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['auth.login', 'grant.auto']));
  });
});
