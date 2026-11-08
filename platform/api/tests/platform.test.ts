import { describe, expect, it } from 'vitest';
import { createPlatformHarness, privateApp } from './helpers';

const token = (h: ReturnType<typeof createPlatformHarness>, slug: string, body: Record<string, unknown>, cred = `cred-${slug}`) =>
  h.call('POST', `/apps/${slug}/token`, { body, headers: { authorization: `Bearer ${cred}` } });

describe('portal sign-in', () => {
  it('creates an account for anyone with Google, no approval, and shows only their chosen or first name', async () => {
    const h = createPlatformHarness();
    await h.signIn('ann@test.dev', 'Ann Lee Smith');
    const me = await h.call('GET', '/me', { as: 'ann@test.dev' });
    expect(me.body.user).toMatchObject({ email: 'ann@test.dev', name: 'Ann', isPlatformAdmin: false });
    await h.call('PATCH', '/me', { as: 'ann@test.dev', body: { displayName: 'Annie' } });
    expect((await h.call('GET', '/me', { as: 'ann@test.dev' })).body.user.name).toBe('Annie');
  });

  it('needs the CSRF header and a session', async () => {
    const h = createPlatformHarness();
    expect((await h.call('GET', '/me')).status).toBe(401);
    expect((await h.call('POST', '/auth/google', { body: { credential: 'test:a@b.c' }, headers: { 'x-stacks-request': '0' } })).status).toBe(403);
  });
});

describe('the handshake', () => {
  it('sends signed-out people to portal sign-in and back to /authorize', async () => {
    const h = createPlatformHarness();
    const { url } = await h.authorize('hello');
    expect(url!.origin).toBe('https://auth.stacks.test');
    const next = decodeURIComponent(url!.hash.replace('#/signin?next=', ''));
    expect(next.startsWith('/authorize?app=hello&')).toBe(true);
  });

  it('auto-grants public apps and issues a single-use code bound to app, redirect and PKCE', async () => {
    const h = createPlatformHarness();
    const a = await h.authorize('hello', 'max@test.dev');
    expect(a.url!.origin + a.url!.pathname).toBe('https://hello.stacks.test/api/auth/callback');
    expect(a.url!.searchParams.get('state')).toBe(a.state);
    expect(a.code).toMatch(/^stc_/);

    expect((await token(h, 'hello', { code: a.code, codeVerifier: 'wrong', redirectUri: a.redirectUri })).status).toBe(400);
    // The failed attempt used the code up.
    expect((await token(h, 'hello', { code: a.code, codeVerifier: a.verifier, redirectUri: a.redirectUri })).status).toBe(400);

    const b = await h.authorize('hello', 'max@test.dev');
    const ok = await token(h, 'hello', { code: b.code, codeVerifier: b.verifier, redirectUri: b.redirectUri });
    expect(ok.body).toEqual({ user: { email: 'max@test.dev', name: 'max' }, role: 'MEMBER' });
    expect((await token(h, 'hello', { code: b.code, codeVerifier: b.verifier, redirectUri: b.redirectUri })).status).toBe(400);
  });

  it('rejects codes after 60 seconds, other apps\' credentials, and redirect URIs of other apps', async () => {
    const h = createPlatformHarness();
    const a = await h.authorize('hello', 'max@test.dev');
    h.advance(61_000);
    expect((await token(h, 'hello', { code: a.code, codeVerifier: a.verifier, redirectUri: a.redirectUri })).status).toBe(400);
    const b = await h.authorize('hello', 'max@test.dev');
    expect((await token(h, 'hello', { code: b.code, codeVerifier: b.verifier, redirectUri: b.redirectUri }, 'cred-club')).status).toBe(401);
    expect((await token(h, 'club', { code: b.code, codeVerifier: b.verifier, redirectUri: b.redirectUri }, 'cred-club')).status).toBe(400);
    const bad = await h.call('GET', '/authorize', {
      as: 'max@test.dev',
      query: { app: 'hello', state: 's', redirect_uri: 'https://evil.example/cb', code_challenge: 'c', code_challenge_method: 'S256' },
    });
    expect(bad.status).toBe(400);
  });

  it('files a request for private apps, tells the approvers, and lets the user in once approved', async () => {
    const h = createPlatformHarness();
    const first = await h.authorize('club', 'ann@test.dev');
    expect(first.url!.searchParams.get('error')).toBe('access_pending');
    expect(first.code).toBeUndefined();

    const ownerMe = await h.call('GET', '/me', { as: 'owner@test.dev' });
    expect(ownerMe.body).toMatchObject({ unread: 1, pendingRequests: 1 });
    const notes = await h.call('GET', '/notifications', { as: 'owner@test.dev' });
    expect(notes.body.notifications[0].text).toContain('ann@test.dev');

    expect((await h.call('PUT', '/admin/access/club/ann@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } })).status).toBe(200);
    expect((await h.call('GET', '/me', { as: 'ann@test.dev' })).body.unread).toBe(1);
    const again = await h.authorize('club', 'ann@test.dev');
    expect((await token(h, 'club', { code: again.code, codeVerifier: again.verifier, redirectUri: again.redirectUri })).body.role).toBe('MEMBER');
  });
});

describe('access grid', () => {
  it('registers apps on first sight with the owners in the top role', async () => {
    const h = createPlatformHarness();
    const grid = await h.call('GET', '/admin/access', { as: 'owner@test.dev' });
    expect(grid.body.apps.map((a: { slug: string }) => a.slug)).toEqual(['club', 'hello']);
    expect(grid.body.grants).toEqual(expect.arrayContaining([expect.objectContaining({ app: 'club', email: 'owner@test.dev', role: 'OWNER' })]));
  });

  it('lets admins approve members but only approver-managers change approvers', async () => {
    const h = createPlatformHarness();
    await h.call('PUT', '/admin/access/club/adam@test.dev', { as: 'owner@test.dev', body: { role: 'ADMIN' } });
    expect((await h.call('PUT', '/admin/access/club/m@test.dev', { as: 'adam@test.dev', body: { role: 'MEMBER' } })).status).toBe(200);
    expect((await h.call('PUT', '/admin/access/club/m@test.dev', { as: 'adam@test.dev', body: { role: 'ADMIN' } })).status).toBe(403);
    expect((await h.call('PUT', '/admin/access/club/m@test.dev', { as: 'm@test.dev', body: { role: 'OWNER' } })).status).toBe(403);
    expect((await h.call('GET', '/admin/access', { as: 'm@test.dev' })).status).toBe(403);
  });

  it('keeps at least one holder of the top role', async () => {
    const h = createPlatformHarness();
    expect((await h.call('PUT', '/admin/access/club/owner@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } })).status).toBe(409);
    await h.call('PUT', '/admin/access/club/two@test.dev', { as: 'owner@test.dev', body: { role: 'OWNER' } });
    expect((await h.call('PUT', '/admin/access/club/owner@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } })).status).toBe(200);
  });

  it('ends the user\'s app sessions when their role changes or is removed', async () => {
    const h = createPlatformHarness();
    await h.call('PUT', '/admin/access/club/m@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } });
    expect(h.revoked).toEqual([]);
    await h.call('PUT', '/admin/access/club/m@test.dev', { as: 'owner@test.dev', body: { role: null } });
    expect(h.revoked).toEqual(['club:m@test.dev']);
  });

  it('lets the platform super-admin edit any cell and see every user', async () => {
    const h = createPlatformHarness();
    await h.signIn('stranger@test.dev');
    expect((await h.call('PUT', '/admin/access/club/x@test.dev', { as: 'root@test.dev', body: { role: 'OWNER' } })).status).toBe(200);
    const grid = await h.call('GET', '/admin/access', { as: 'root@test.dev' });
    expect(grid.body.users.map((u: { email: string }) => u.email)).toContain('stranger@test.dev');
    expect(grid.body.isPlatformAdmin).toBe(true);
  });

  it('rejects roles the app does not declare', async () => {
    const h = createPlatformHarness();
    expect((await h.call('PUT', '/admin/access/club/x@test.dev', { as: 'owner@test.dev', body: { role: 'GOD' } })).status).toBe(400);
  });
});

describe('catalog', () => {
  it('lists apps for signed-out visitors and the viewer\'s access when signed in', async () => {
    const h = createPlatformHarness();
    const pub = await h.call('GET', '/public/catalog');
    expect(pub.body.apps.map((a: { slug: string; access: null }) => [a.slug, a.access])).toEqual([['club', null], ['hello', null]]);
    await h.call('POST', '/apps/club/request', { as: 'ann@test.dev' });
    await h.call('POST', '/apps/hello/request', { as: 'ann@test.dev' });
    await h.call('PUT', '/me/favorites/hello', { as: 'ann@test.dev' });
    const mine = await h.call('GET', '/catalog', { as: 'ann@test.dev' });
    expect(mine.body.apps.map((a: { slug: string; access: string; favorite: boolean }) => [a.slug, a.access, a.favorite])).toEqual([
      ['club', 'PENDING', false],
      ['hello', 'MEMBER', true],
    ]);
    expect(mine.body.apps[1].url).toBe('https://hello.stacks.test/');
  });

  it('hides archived apps from everyone but lets admins restore them', async () => {
    const h = createPlatformHarness();
    expect((await h.call('PUT', '/admin/apps/club/status', { as: 'owner@test.dev', body: { status: 'archived' } })).status).toBe(403);
    await h.call('PUT', '/admin/apps/club/status', { as: 'root@test.dev', body: { status: 'archived' } });
    expect((await h.call('GET', '/public/catalog')).body.apps.map((a: { slug: string }) => a.slug)).toEqual(['hello']);
    expect((await h.authorize('club', 'owner@test.dev')).res.status).toBe(404);
  });
});

describe('sign-out and audit', () => {
  it('signs out everywhere: portal session and every app session', async () => {
    const h = createPlatformHarness();
    await h.authorize('hello', 'max@test.dev');
    const res = await h.call('GET', '/logout', { as: 'max@test.dev' });
    expect(res.location).toBe('https://auth.stacks.test/#/?signedOut=1');
    expect(h.revoked).toEqual(['hello:max@test.dev']);
    expect((await h.call('GET', '/me', { cookies: { '__Host-stacks-portal': 'stp_gone' } })).status).toBe(401);
  });

  it('keeps a central feed, filtered to the apps a viewer manages', async () => {
    const h = createPlatformHarness();
    await h.call('POST', '/apps/club/audit', {
      headers: { authorization: 'Bearer cred-club' },
      body: { id: 'e1', at: '2026-02-28T23:00:00.000Z', actorEmail: 'm@test.dev', actorName: 'M', action: 'book.nominate', label: 'Dune' },
    });
    expect((await h.call('POST', '/apps/club/audit', { headers: { authorization: 'Bearer nope' }, body: { action: 'x', actorEmail: 'a' } })).status).toBe(401);
    await h.call('PUT', '/admin/access/hello/bo@test.dev', { as: 'root@test.dev', body: { role: 'OWNER' } });
    const forBo = await h.call('GET', '/admin/audit', { as: 'bo@test.dev' });
    expect(forBo.body.events.every((e: { app: string }) => e.app === 'hello')).toBe(true);
    const all = await h.call('GET', '/admin/audit', { as: 'root@test.dev', query: { app: privateApp.slug } });
    expect(all.body.events.map((e: { action: string }) => e.action)).toContain('book.nominate');
  });
});
