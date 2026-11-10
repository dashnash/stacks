import { describe, expect, it } from 'vitest';
import { mergedRole } from '../src/merge';
import { createPlatformHarness, privateApp, publicApp, type Res } from './helpers';

const PORTAL = '__Host-stacks-portal';

/** Sign in as someone and keep their portal cookie (a second Google account is another sign-in). */
async function person(h: ReturnType<typeof createPlatformHarness>, email: string, name: string) {
  const token = await h.signIn(email, name, `g-${email}`);
  const as = (method: string, path: string, body?: unknown): Promise<Res> => h.call(method, path, { cookies: { [PORTAL]: token }, body });
  return { token, as, id: await h.idOf(email) };
}

const link = (p: Awaited<ReturnType<typeof person>>, email: string) => p.as('POST', '/me/identities/google', { credential: `test:${email}::g-${email}` });

describe('mergedRole', () => {
  it('lets a block win, then the stronger role, then a pending request', () => {
    expect(mergedRole(privateApp, 'MEMBER', 'ADMIN')).toBe('ADMIN');
    expect(mergedRole(privateApp, 'OWNER', 'MEMBER')).toBe('OWNER');
    expect(mergedRole(privateApp, 'OWNER', 'BLOCKED')).toBe('BLOCKED');
    expect(mergedRole(privateApp, 'PENDING', 'MEMBER')).toBe('MEMBER');
    expect(mergedRole(privateApp, null, 'PENDING')).toBe('PENDING');
    expect(mergedRole(privateApp, null, null)).toBeNull();
  });
});

describe('Settings › Sign-in methods', () => {
  it('links a Google account nobody has, which then signs in to the same account without changing the profile', async () => {
    const h = createPlatformHarness();
    const ann = await person(h, 'ann@test.dev', 'Ann Lee');
    expect((await link(ann, 'ann.work@test.dev')).body).toEqual({ linked: true });

    const methods = (await ann.as('GET', '/me/identities')).body;
    expect(methods.identities.map((i: { email: string; primary: boolean }) => [i.email, i.primary])).toEqual([
      ['ann@test.dev', true],
      ['ann.work@test.dev', false],
    ]);
    expect(methods.emails).toEqual(['ann@test.dev', 'ann.work@test.dev']);

    const work = await h.signIn('ann.work@test.dev', 'Ann At Work', 'g-ann.work@test.dev');
    const me = await h.call('GET', '/me', { cookies: { [PORTAL]: work } });
    expect(me.body.user).toMatchObject({ id: ann.id, email: 'ann@test.dev', googleName: 'Ann Lee' });
    expect((await link(ann, 'ann.work@test.dev')).status).toBe(409); // already one of hers
  });

  it('unlinks a linked method, never the main one', async () => {
    const h = createPlatformHarness();
    const ann = await person(h, 'ann@test.dev', 'Ann');
    await link(ann, 'ann.work@test.dev');
    expect((await ann.as('DELETE', '/me/identities/google/g-ann@test.dev')).status).toBe(409);
    expect((await ann.as('DELETE', '/me/identities/google/g-ann.work@test.dev')).status).toBe(200);
    expect((await ann.as('GET', '/me/identities')).body.identities).toHaveLength(1);
    expect((await ann.as('DELETE', '/me/identities/google/nope')).status).toBe(400);
  });
});

describe('self-serve merge', () => {
  async function twoAccounts() {
    const h = createPlatformHarness();
    const owner = await person(h, 'owner@test.dev', 'Olive');
    const ann = await person(h, 'ann@test.dev', 'Ann');
    const old = await person(h, 'ann.old@test.dev', 'Ann Old');
    return { h, owner, ann, old };
  }

  it('offers a merge with a summary, then moves roles, inbox and sign-ins, leaving an alias apps can resolve', async () => {
    const { h, owner, ann, old } = await twoAccounts();
    await h.setRole('club', 'ann@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } });
    await h.authorize('club', 'ann.old@test.dev'); // files a request...
    await h.setRole('club', 'ann.old@test.dev', { as: 'owner@test.dev', body: { role: 'ADMIN' } }); // ...approved: in her inbox
    await h.authorize('hello', 'ann.old@test.dev'); // public: MEMBER

    const offer = await link(ann, 'ann.old@test.dev');
    expect(offer.body).toMatchObject({ linked: false, ticket: expect.stringMatching(/^stm_/), plan: { other: { name: 'Ann', email: 'ann.old@test.dev' }, problems: [] } });
    expect(offer.body.plan.apps).toEqual([
      { slug: 'club', name: 'Book Club', yours: 'MEMBER', theirs: 'ADMIN', result: 'ADMIN', resultLabel: 'Admin' },
      { slug: 'hello', name: 'Hello Board', yours: null, theirs: 'MEMBER', result: 'MEMBER', resultLabel: 'Member' },
    ]);

    const merged = await ann.as('POST', '/me/merge', { ticket: offer.body.ticket });
    expect(merged.status).toBe(200);
    expect(merged.body.user).toMatchObject({ id: ann.id, email: 'ann@test.dev', name: 'Ann' });
    // The ticket was single use.
    expect((await ann.as('POST', '/me/merge', { ticket: offer.body.ticket })).status).toBe(400);

    // Roles combined, the old account's sessions are gone, and its Google account now signs in as Ann.
    const catalog = await ann.as('GET', '/catalog');
    expect(Object.fromEntries(catalog.body.apps.map((a: { slug: string; access: string }) => [a.slug, a.access]))).toEqual({ club: 'ADMIN', hello: 'MEMBER' });
    expect((await h.call('GET', '/me', { cookies: { [PORTAL]: old.token } })).status).toBe(401);
    const again = await h.signIn('ann.old@test.dev', 'Ann Old', 'g-ann.old@test.dev');
    const me = await h.call('GET', '/me', { cookies: { [PORTAL]: again } });
    expect(me.body.user).toMatchObject({ id: ann.id, name: 'Ann' });
    expect(me.body.unread).toBeGreaterThan(0); // her old inbox came along

    // Apps see one person, who used to be the old id too; the grid lists her once.
    const access = await h.call('GET', '/apps/club/access', { headers: { authorization: 'Bearer cred-club' } });
    expect(access.body.members.find((m: { id: string }) => m.id === ann.id)).toMatchObject({ role: 'ADMIN', formerIds: [old.id] });
    expect(access.body.members.some((m: { id: string }) => m.id === old.id)).toBe(false);
    const grid = await owner.as('GET', '/admin/access');
    expect(grid.body.users.filter((u: { name: string }) => u.name.startsWith('Ann')).map((u: { id: string }) => u.id)).toEqual([ann.id]);
    const feed = await h.call('GET', '/admin/audit', { as: 'root@test.dev', query: { action: 'user.merge' } });
    expect(feed.body.events.map((e: { app: string }) => e.app).sort()).toEqual(['club', 'hello', 'platform']);
  });

  it('keeps a block: a merge never escapes one', async () => {
    const { h, ann } = await twoAccounts();
    await h.authorize('hello', 'ann@test.dev');
    await h.setRole('hello', 'ann.old@test.dev', { as: 'owner@test.dev', body: { role: 'BLOCKED' } });
    const offer = await link(ann, 'ann.old@test.dev');
    expect(offer.body.plan.apps).toEqual([expect.objectContaining({ slug: 'hello', yours: 'MEMBER', theirs: 'BLOCKED', result: 'BLOCKED' })]);
    await ann.as('POST', '/me/merge', { ticket: offer.body.ticket });
    expect((await h.authorize('hello', 'ann@test.dev')).url!.searchParams.get('error')).toBe('access_denied');
  });

  it("refuses a merge that would leave an app without its owner, or that involves a platform admin", async () => {
    const h = createPlatformHarness({ apps: [publicApp] });
    const owner = await person(h, 'owner@test.dev', 'Olive'); // hello's only owner
    const alt = await person(h, 'olive.alt@test.dev', 'Olive Alt');
    await h.setRole('hello', 'olive.alt@test.dev', { as: 'owner@test.dev', body: { role: 'BLOCKED' } });
    const offer = await link(owner, 'olive.alt@test.dev');
    expect(offer.body.plan.problems).toEqual(['Hello Board would lose its last Owner.']);
    expect((await owner.as('POST', '/me/merge', { ticket: offer.body.ticket })).status).toBe(403);
    void alt;

    const root = await person(h, 'root@test.dev', 'Root');
    const offer2 = await link(root, 'olive.alt@test.dev');
    expect(offer2.body.plan.problems).toContain('Platform admin accounts can only be merged by a platform admin.');
  });

  it("only lets the person the offer was made to use it, and only for ten minutes", async () => {
    const { h, ann, owner } = await twoAccounts();
    const offer = await link(ann, 'ann.old@test.dev');
    expect((await owner.as('POST', '/me/merge', { ticket: offer.body.ticket })).status).toBe(400);
    const second = await link(ann, 'ann.old@test.dev');
    h.advance(11 * 60_000);
    expect((await ann.as('POST', '/me/merge', { ticket: second.body.ticket })).status).toBe(400);
  });

  it("follows the account's own Google profile only: a linked account's name never replaces it", async () => {
    const { h, ann } = await twoAccounts();
    const offer = await link(ann, 'ann.old@test.dev');
    await ann.as('POST', '/me/merge', { ticket: offer.body.ticket });
    await h.signIn('ann.old@test.dev', 'Someone Else', 'g-ann.old@test.dev');
    expect((await ann.as('GET', '/me')).body.user).toMatchObject({ googleName: 'Ann', email: 'ann@test.dev' });
    // Her own Google account still updates it.
    await h.signIn('ann@test.dev', 'Ann Lee', 'g-ann@test.dev');
    expect((await ann.as('GET', '/me')).body.user.googleName).toBe('Ann Lee');
  });
});
