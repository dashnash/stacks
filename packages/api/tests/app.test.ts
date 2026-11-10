import { describe, expect, it } from 'vitest';
import { cookieValue, createTestHarness, userFor } from '@stacks/testing';
import { safeReturnPath } from '../src/app';
import { SESSION_COOKIE } from '../src/session';
import { manifest, routes } from './fixtures';

const harness = () => createTestHarness({ manifest, routes });

describe('sign-in handshake (app side)', () => {
  it('sends the browser to the platform with a PKCE challenge and remembers where to return', async () => {
    const t = harness();
    const res = await t.call('GET', '/auth/login', { query: { return: '/notes/7?x=1' } });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.Location!);
    expect(url.origin + url.pathname).toBe('https://auth.stacks.test/authorize');
    expect(url.searchParams.get('app')).toBe('notes');
    expect(url.searchParams.get('redirect_uri')).toBe('https://notes.stacks.test/api/auth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const login = JSON.parse(atob(cookieValue(res.cookies, '__Host-stacks-login')!));
    expect(login).toMatchObject({ state: url.searchParams.get('state'), ret: '/notes/7?x=1' });
    expect(res.cookies[0]).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  });

  it('swaps the code for a session cookie and returns to the deep link', async () => {
    const t = harness();
    const start = await t.call('GET', '/auth/login', { query: { return: '/notes' } });
    const state = new URL(start.headers.Location!).searchParams.get('state')!;
    const loginCookie = cookieValue(start.cookies, '__Host-stacks-login')!;
    const code = t.platform.issueCode({ id: 'u_ed', email: 'ed@test.dev', name: 'Ed' }, 'EDITOR');

    const done = await t.call('GET', '/auth/callback', { query: { code, state }, cookies: { '__Host-stacks-login': loginCookie } });
    expect(done.status).toBe(302);
    expect(done.headers.Location).toBe('/notes');
    const token = cookieValue(done.cookies, SESSION_COOKIE)!;
    expect(token).toMatch(/^stk_/);
    expect(cookieValue(done.cookies, '__Host-stacks-login')).toBe('');

    const session = await t.call('GET', '/auth/session', { cookies: { [SESSION_COOKIE]: token } });
    expect(session.body).toEqual({ user: { id: 'u_ed', email: 'ed@test.dev', name: 'Ed' }, role: 'EDITOR', canManageAccess: false });
    // Only the hash is stored, and the sign-in is in the activity log (and mirrored).
    expect(JSON.stringify([...t.store.items.values()])).not.toContain(token);
    expect(t.platform.audit.map((e) => e.action)).toEqual(['auth.login']);
  });

  it('refuses a callback whose state does not match the browser that started it', async () => {
    const t = harness();
    const start = await t.call('GET', '/auth/login');
    const code = t.platform.issueCode(userFor('ed@test.dev'), 'EDITOR');
    const res = await t.call('GET', '/auth/callback', {
      query: { code, state: 'forged' },
      cookies: { '__Host-stacks-login': cookieValue(start.cookies, '__Host-stacks-login')! },
    });
    expect(res.status).toBe(400);
    expect((await t.call('GET', '/auth/callback', { query: { code, state: 'x' } })).status).toBe(400);
  });

  it('sends people whose access is pending back to the public view', async () => {
    const res = await harness().call('GET', '/auth/callback', { query: { error: 'access_pending' } });
    expect(res.headers.Location).toBe('/?stacks_access=access_pending');
  });

  it('only returns to paths in this app', () => {
    expect(safeReturnPath('/a/b?c')).toBe('/a/b?c');
    expect(safeReturnPath('//evil.example')).toBe('/');
    expect(safeReturnPath('https://evil.example')).toBe('/');
    expect(safeReturnPath('/\\evil.example')).toBe('/');
    expect(safeReturnPath(undefined)).toBe('/');
  });

  it('signs out: ends the session, clears the cookie and points at the platform logout', async () => {
    const t = harness();
    const token = await t.sessionFor('ed@test.dev', 'EDITOR');
    const res = await t.call('POST', '/auth/logout', { cookies: { [SESSION_COOKIE]: token } });
    expect(res.body.platformLogoutUrl).toBe('https://auth.stacks.test/logout');
    expect(cookieValue(res.cookies, SESSION_COOKIE)).toBe('');
    expect((await t.call('GET', '/auth/session', { cookies: { [SESSION_COOKIE]: token } })).status).toBe(401);
  });
});

describe('route guards', () => {
  it('serves public routes to anyone and tells them who they are if signed in', async () => {
    const t = harness();
    expect((await t.call('GET', '/public/info')).body).toEqual({ app: 'Notes', signedInAs: null });
    expect((await t.call('GET', '/public/info', { as: 'r@test.dev' })).body.signedInAs).toBe('u_r_test_dev');
  });

  it('needs a session for member routes', async () => {
    const t = harness();
    expect((await t.call('GET', '/notes')).status).toBe(401);
    expect((await t.call('GET', '/notes', { as: 'r@test.dev', role: 'READER' })).status).toBe(200);
  });

  it('checks roles from the manifest', async () => {
    const t = harness();
    expect((await t.call('POST', '/notes', { as: 'r@test.dev', role: 'READER', body: { text: 'hi' } })).status).toBe(403);
    expect((await t.call('POST', '/notes', { as: 'e@test.dev', role: 'EDITOR', body: { text: 'hi' } })).status).toBe(201);
    expect((await t.call('DELETE', '/notes/id1', { as: 'e@test.dev', role: 'EDITOR' })).status).toBe(403);
  });

  it('lets roles that manage access use approver routes', async () => {
    const t = harness();
    const { body } = await t.call('POST', '/notes', { as: 'o@test.dev', role: 'OWNER', body: { text: 'x' } });
    expect((await t.call('DELETE', `/notes/${body.id}`, { as: 'o@test.dev', role: 'OWNER' })).status).toBe(200);
  });

  it('refuses state-changing calls without the CSRF header', async () => {
    const t = harness();
    const res = await t.call('POST', '/notes', { as: 'e@test.dev', role: 'EDITOR', body: { text: 'hi' }, noCsrf: true });
    expect(res).toMatchObject({ status: 403, body: { code: 'CSRF' } });
    expect((await t.call('POST', '/auth/logout', { noCsrf: true })).status).toBe(403);
  });

  it('ignores sessions holding a role the manifest no longer declares', async () => {
    const t = harness();
    expect((await t.call('GET', '/notes', { as: 'x@test.dev', role: 'GHOST' })).status).toBe(401);
  });

  it('refuses at startup a route that names an undeclared role', () => {
    expect(() =>
      createTestHarness({ manifest, routes: (api) => void api.role(['BOSS'], 'GET', '/x', async () => ({ body: {} })) }),
    ).toThrow(/role "BOSS"/);
  });

  it('turns HttpErrors into JSON errors', async () => {
    const res = await harness().call('POST', '/boom', { as: 'r@test.dev' });
    expect(res).toMatchObject({ status: 400, body: { error: 'nope', code: 'BAD_REQUEST' } });
  });
});

describe('account menu data', () => {
  it('serves the viewer\'s account from the platform, and degrades gracefully if the platform fails', async () => {
    const t = harness();
    t.platform.accountData = { ...t.platform.accountData, unread: 2, apps: [{ slug: 'x', name: 'X', url: 'https://x.stacks.test/' }] };
    expect((await t.call('GET', '/stacks/account', { as: 'r@test.dev' })).body.unread).toBe(2);
    t.platform.account = async () => {
      throw new Error('down');
    };
    expect((await t.call('GET', '/stacks/account', { as: 'r@test.dev', role: 'READER' })).body).toMatchObject({
      unread: 0,
      apps: [],
      manage: null,
      app: { slug: 'notes', name: 'Notes', roleLabel: 'Reader' },
      profileUrl: 'https://auth.stacks.test/#/profile?from=notes',
    });
    expect((await t.call('GET', '/stacks/account')).status).toBe(401);
  });

  it('shows names from the platform profile, so a rename needs no new sign-in', async () => {
    const t = harness();
    const token = await t.sessionFor({ id: 'u_r', email: 'r@test.dev', name: 'Old Name' }, 'READER');
    const cookies = { '__Host-stacks-session': token };
    expect((await t.call('GET', '/auth/session', { cookies })).body.user.name).toBe('Old Name');
    t.platform.members = [{ id: 'u_r', email: 'r@test.dev', name: 'New Name', role: 'READER' }];
    const { forgetMembers } = await import('../src/people');
    forgetMembers(t.deps);
    expect((await t.call('GET', '/auth/session', { cookies })).body.user.name).toBe('New Name');
  });
});

describe('activity log', () => {
  it('records audited actions with label and input, mirrors them, and shows them to approvers only', async () => {
    const t = harness();
    await t.call('POST', '/notes', { as: 'e@test.dev', role: 'EDITOR', body: { text: 'Hello world', token: 'secret' } });
    const mirrored = t.platform.audit.at(-1)!;
    expect(mirrored).toMatchObject({ action: 'note.post', actorId: 'u_e_test_dev', label: 'Hello world', details: { input: { text: 'Hello world' } } });

    expect((await t.call('GET', '/admin/audit', { as: 'e@test.dev', role: 'EDITOR' })).status).toBe(403);
    const log = await t.call('GET', '/admin/audit', { as: 'o@test.dev', role: 'OWNER' });
    expect(log.body.events.map((e: { action: string }) => e.action)).toEqual(['note.post']);
  });

  it('does not log failed actions or reads', async () => {
    const t = harness();
    await t.call('POST', '/notes', { as: 'r@test.dev', role: 'READER', body: { text: 'x' } });
    await t.call('GET', '/notes', { as: 'r@test.dev', role: 'READER' });
    expect(t.platform.audit).toEqual([]);
  });
});

describe('emails', () => {
  it('gives the app no email unless its manifest has needsEmail', async () => {
    const without = createTestHarness({ manifest, routes });
    expect((await without.call('GET', '/auth/session', { as: 'r@test.dev', role: 'READER' })).body.user).toEqual({ id: 'u_r_test_dev', name: 'r' });
    const withEmail = createTestHarness({ manifest: { ...manifest, needsEmail: true }, routes });
    expect((await withEmail.call('GET', '/auth/session', { as: 'r@test.dev', role: 'READER' })).body.user).toMatchObject({ email: 'r@test.dev' });
  });
});
