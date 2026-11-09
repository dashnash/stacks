import { describe, expect, it } from 'vitest';
import { MemoryStore, type Item } from '@stacks/api';
import { createPlatformHarness } from '../../../platform/api/tests/helpers';
import { formerUserId, migrateApp, migratePlatform, type Table } from '../src/migrate';
import { migrate as bookClub } from '../../../apps/mofobookklub/api/migrations/user-ids';

const tableOf = (store: MemoryStore): Table => ({
  scan: () => [...store.items.values()].map((i) => structuredClone(i)),
  put: (item) => store.put(item),
  delete: (pk, sk) => store.delete(pk, sk),
});

/** The platform table as the email-keyed code wrote it. */
const legacyPlatform = (): Item[] => [
  { PK: 'USER#ann@test.dev', SK: 'PROFILE', GSI1PK: 'USERS', GSI1SK: 'ann@test.dev', email: 'ann@test.dev', name: 'Ann Lee', displayName: 'Annie', createdAt: '2026-01-01T00:00:00.000Z', favorites: ['club'] },
  { PK: 'APP#club', SK: 'APP', slug: 'club', status: 'live', registeredAt: '2026-01-01T00:00:00.000Z' },
  { PK: 'APP#hello', SK: 'APP', slug: 'hello', status: 'live', registeredAt: '2026-01-01T00:00:00.000Z' },
  // The owner never signed in: a grant with no user.
  { PK: 'APP#club', SK: 'GRANT#owner@test.dev', GSI1PK: 'USERGRANTS#owner@test.dev', GSI1SK: 'club', app: 'club', email: 'owner@test.dev', role: 'OWNER', grantedBy: 'platform', grantedAt: '2026-01-01T00:00:00.000Z' },
  { PK: 'APP#hello', SK: 'GRANT#owner@test.dev', GSI1PK: 'USERGRANTS#owner@test.dev', GSI1SK: 'hello', app: 'hello', email: 'owner@test.dev', role: 'OWNER', grantedBy: 'platform', grantedAt: '2026-01-01T00:00:00.000Z' },
  { PK: 'APP#club', SK: 'GRANT#ann@test.dev', GSI1PK: 'USERGRANTS#ann@test.dev', GSI1SK: 'club', app: 'club', email: 'ann@test.dev', role: 'MEMBER', grantedBy: 'owner@test.dev', grantedAt: '2026-01-02T00:00:00.000Z' },
  { PK: 'NOTIF#ann@test.dev', SK: '2026-01-02T00:00:00.000Z#n1', id: 'n1', at: '2026-01-02T00:00:00.000Z', text: 'You now have access to Book Club.', read: false, app: 'club' },
  { PK: 'SESSION#abc', SK: 'SESSION', GSI1PK: 'USERSESSIONS#ann@test.dev', GSI1SK: 't', email: 'ann@test.dev', userCreatedAt: '2026-01-01T00:00:00.000Z', lastUsedAt: 't', expiresAt: 9e9 },
  { PK: 'AUDIT#2026-01', SK: '2026-01-02T00:00:00.000Z#club#a1', id: 'a1', at: '2026-01-02T00:00:00.000Z', app: 'club', actorEmail: 'owner@test.dev', actorName: 'owner', action: 'grant.set', label: 'ann@test.dev' },
  { PK: 'AUDIT#2026-01', SK: '2026-01-01T00:00:00.000Z#club#a0', id: 'a0', at: '2026-01-01T00:00:00.000Z', app: 'club', actorEmail: 'platform', actorName: 'Platform', action: 'app.register' },
];

function run(store: MemoryStore, dryRun = false) {
  let n = 0;
  return migratePlatform(tableOf(store), { mintId: () => `u_mig${++n}`, now: () => new Date('2026-11-10T00:00:00Z'), dryRun });
}

describe('platform migration', () => {
  it('leaves the platform working for everyone who was there: same account, name, roles and inbox', async () => {
    const h = createPlatformHarness();
    for (const item of legacyPlatform()) await h.store.put(item);
    const { ids, report } = await run(h.store);
    expect(report.errors).toEqual([]);
    expect(report.counts).toMatchObject({ user: 1, 'user.placeholder': 1, grant: 3, notification: 1, 'session.dropped': 1, audit: 2 });

    // Ann signs in with Google (a sub we've never seen): matched by her email to her old account.
    const annId = ids.get('ann@test.dev')!;
    const me = await h.call('GET', '/me', { as: 'ann@test.dev' });
    expect(me.body.user).toMatchObject({ id: annId, name: 'Annie', email: 'ann@test.dev' });
    expect(me.body.unread).toBe(1);
    const catalog = await h.call('GET', '/catalog', { as: 'ann@test.dev' });
    expect(catalog.body.apps.find((a: { slug: string }) => a.slug === 'club')).toMatchObject({ access: 'MEMBER', favorite: true });

    // The owner, who had only a grant, gets their account (and the top role) on first sign-in.
    const grid = await h.call('GET', '/admin/access', { as: 'owner@test.dev' });
    expect(grid.body.grants).toEqual(expect.arrayContaining([expect.objectContaining({ app: 'club', userId: annId, role: 'MEMBER' })]));
    const feed = await h.call('GET', '/admin/audit', { as: 'owner@test.dev', query: { app: 'club' } });
    expect(feed.body.events.map((e: { actorId: string }) => e.actorId)).toEqual(expect.arrayContaining([ids.get('owner@test.dev'), 'platform']));

    // Nothing email-keyed is left.
    const keys = [...h.store.items.values()].map((i) => `${i.PK}|${i.SK}`);
    expect(keys.filter((k) => /(USER|NOTIF|GRANT|SESSIONS?)#[^|]*@/.test(k))).toEqual([]);
  });

  it('changes nothing on a dry run, and nothing more on a second run', async () => {
    const store = new MemoryStore(legacyPlatform());
    const before = JSON.stringify([...store.items.entries()]);
    await run(store, true);
    expect(JSON.stringify([...store.items.entries()])).toBe(before);

    const first = await run(store);
    const after = JSON.stringify([...store.items.entries()]);
    const second = await run(store);
    expect(second.report.counts).toEqual({});
    expect(JSON.stringify([...store.items.entries()])).toBe(after);
    expect(second.ids).toEqual(first.ids);
  });

  it('gives people the platform no longer knows a stable placeholder id', async () => {
    const { idFor } = await run(new MemoryStore(legacyPlatform()));
    expect(idFor('Ann@test.dev')).toBe('u_mig1');
    expect(idFor('gone@test.dev')).toBe(formerUserId('gone@test.dev'));
    expect(idFor('gone@test.dev')).toMatch(/^u_x[0-9a-f]{23}$/);
  });
});

describe('app migration', () => {
  it("runs an app's own migration over its table, re-keying and dropping as it says", async () => {
    const store = new MemoryStore([
      { PK: 'LINEUP', SK: 'VOTE#n1#ann@test.dev', nominationId: 'n1', userEmail: 'ann@test.dev' },
      { PK: 'LINEUP', SK: 'NOMINATION#n1', id: 'n1', bookIsbn: '1', nominatedByEmail: 'gone@test.dev' },
      { PK: 'SESSION#x', SK: 'SESSION' },
      { PK: 'EASTEREGG', SK: 'EGG#1', quote: 'q' },
    ]);
    const idFor = (e: string) => (e === 'ann@test.dev' ? 'u_ann' : formerUserId(e));
    const dry = await migrateApp(tableOf(store), bookClub, idFor, { dryRun: true });
    expect(dry.counts).toEqual({ rekeyed: 1, rewritten: 1, deleted: 1 });
    expect(store.items.size).toBe(4);

    const report = await migrateApp(tableOf(store), bookClub, idFor);
    expect(report).toEqual({ counts: { rekeyed: 1, rewritten: 1, deleted: 1 }, errors: [] });
    expect(await store.get('LINEUP', 'VOTE#n1#u_ann')).toMatchObject({ userId: 'u_ann' });
    expect(await store.get('LINEUP', 'VOTE#n1#ann@test.dev')).toBeUndefined();
    expect(await store.get('LINEUP', 'NOMINATION#n1')).toMatchObject({ nominatedById: formerUserId('gone@test.dev') });
    expect(await store.get('SESSION#x', 'SESSION')).toBeUndefined();
    expect((await migrateApp(tableOf(store), bookClub, idFor)).counts).toEqual({});
  });
});
