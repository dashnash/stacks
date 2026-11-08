import { describe, expect, it } from 'vitest';
import { MemoryStore, type Item } from '@stacks/api';
import { getGrant, getUser, grantsForApp, requestAccess, type PlatformDeps } from '@stacks/platform-api';
import { migrateBookClub } from '../src/migrate';

/** A slice of a real BookClubTable, in its own key layout. */
const OLD: Item[] = [
  { PK: 'USER#owner@x.dev', SK: 'USER#owner@x.dev', GSI1PK: 'USERS#OWNER', GSI1SK: 'owner@x.dev', email: 'owner@x.dev', role: 'OWNER', name: 'Dash Nash', createdAt: '2025-01-01T00:00:00.000Z' },
  { PK: 'USER#jane@x.dev', SK: 'USER#jane@x.dev', GSI1PK: 'USERS#MEMBER', GSI1SK: 'jane@x.dev', email: 'jane@x.dev', role: 'MEMBER', name: 'Jane Okafor', displayName: 'JJ', pictureUrl: 'https://p/j.jpg', createdAt: '2025-02-01T00:00:00.000Z' },
  { PK: 'USER#ada@x.dev', SK: 'USER#ada@x.dev', GSI1PK: 'USERS#ADMIN', GSI1SK: 'ada@x.dev', email: 'ada@x.dev', role: 'ADMIN', name: 'Ada', createdAt: '2025-03-01T00:00:00.000Z' },
  { PK: 'USER#sam@x.dev', SK: 'USER#sam@x.dev', GSI1PK: 'USERS#PENDING', GSI1SK: 'sam@x.dev', email: 'sam@x.dev', role: 'PENDING', name: 'Sam', createdAt: '2026-10-01T00:00:00.000Z' },
  { PK: 'SESSION#abc', SK: 'SESSION', userEmail: 'jane@x.dev' },
  { PK: 'BOOK#9780593135204', SK: 'BOOK#9780593135204', isbn: '9780593135204', title: 'Project Hail Mary', author: 'Andy Weir' },
  { PK: 'MEETING#m1', SK: 'MEETING#m1', GSI1PK: 'MEETINGS#PAST', GSI1SK: '2026-01-01T00:00:00Z', id: 'm1', title: 'Jan', status: 'PAST' },
  { PK: 'LINEUP', SK: 'NOMINATION#n1', id: 'n1', bookIsbn: '9780593135204', nominatedByEmail: 'jane@x.dev' },
  { PK: 'LINEUP', SK: 'VOTE#n1#ada@x.dev', nominationId: 'n1', userEmail: 'ada@x.dev' },
  { PK: 'THREAD#BOOK#9780593135204', SK: 'COMMENT#c1', id: 'c1', authorEmail: 'jane@x.dev', body: 'Rocky!' },
  { PK: 'THREAD#BOOK#9780593135204', SK: 'COUNT', count: 1 },
  { PK: 'EASTEREGG', SK: 'EGG#gatsby', id: 'gatsby', quote: 'q', characterName: 'c', imageKey: 'eggs/gatsby.jpg' },
  { PK: 'AUDIT#2026-01', SK: '2026-01-02T00:00:00.000Z#e1', id: 'e1', action: 'comment.post', actorEmail: 'jane@x.dev' },
];

function platformDeps(store: MemoryStore): PlatformDeps {
  return {
    store,
    config: { rootDomain: 'x.dev', authOrigin: 'https://auth.x.dev', googleClientId: 'g', platformAdmins: [] },
    registry: { list: async () => [] },
    appSessions: { endUserSessions: async () => undefined },
    verifyGoogle: async () => ({ email: '', name: '' }),
    now: () => new Date('2026-11-08T00:00:00Z'),
    newId: () => 'id',
  };
}

describe('migrateBookClub', () => {
  it('copies app data unchanged, turns users into platform users and grants, and drops sessions', async () => {
    const appStore = new MemoryStore();
    const platformStore = new MemoryStore();
    const copied: string[] = [];
    const report = await migrateBookClub({
      source: OLD,
      appStore,
      platformStore,
      appSlug: 'book-club',
      copyObjects: async (prefix) => (copied.push(prefix), 232),
    });
    expect(report).toMatchObject({ appItems: 8, sessionsDropped: 1, users: { created: 4 }, grants: { created: 4, pending: 1 }, objectsCopied: 232, skipped: [] });
    expect(copied).toEqual(['eggs/']);

    // App data keeps its exact keys (the app and the comments module read them as-is).
    for (const item of OLD.filter((i) => !i.PK.startsWith('USER#') && !i.PK.startsWith('SESSION#'))) {
      expect(await appStore.get(item.PK, item.SK)).toEqual(item);
    }
    expect([...appStore.items.keys()].some((k) => k.startsWith('USER#') || k.startsWith('SESSION#'))).toBe(false);

    // The platform reads what was written.
    const deps = platformDeps(platformStore);
    expect(await getUser(deps, 'jane@x.dev')).toMatchObject({ name: 'Jane Okafor', displayName: 'JJ', pictureUrl: 'https://p/j.jpg', createdAt: '2025-02-01T00:00:00.000Z' });
    expect((await grantsForApp(deps, 'book-club')).map((g) => `${g.email}:${g.role}`).sort()).toEqual([
      'ada@x.dev:ADMIN',
      'jane@x.dev:MEMBER',
      'owner@x.dev:OWNER',
      'sam@x.dev:PENDING',
    ]);
    expect((await getGrant(deps, 'book-club', 'sam@x.dev'))?.requestedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('never overwrites what the platform already has, and is safe to re-run', async () => {
    const appStore = new MemoryStore();
    const platformStore = new MemoryStore();
    const deps = platformDeps(platformStore);
    // Jane already signed in to the portal and chose another name; Sam was already approved there.
    await platformStore.put({ PK: 'USER#jane@x.dev', SK: 'PROFILE', GSI1PK: 'USERS', GSI1SK: 'jane@x.dev', email: 'jane@x.dev', name: 'Jane Okafor', displayName: 'Janey', createdAt: '2026-11-01T00:00:00.000Z' });
    await platformStore.put({ PK: 'APP#book-club', SK: 'GRANT#sam@x.dev', GSI1PK: 'USERGRANTS#sam@x.dev', GSI1SK: 'book-club', app: 'book-club', email: 'sam@x.dev', role: 'MEMBER' });

    const first = await migrateBookClub({ source: OLD, appStore, platformStore, appSlug: 'book-club' });
    expect(first.users).toEqual({ created: 3, existing: 1 });
    expect(first.grants).toMatchObject({ created: 3, existing: 1 });
    expect((await getUser(deps, 'jane@x.dev'))?.displayName).toBe('Janey');
    expect((await getGrant(deps, 'book-club', 'sam@x.dev'))?.role).toBe('MEMBER');

    const again = await migrateBookClub({ source: OLD, appStore, platformStore, appSlug: 'book-club' });
    expect(again.users).toEqual({ created: 0, existing: 4 });
    expect(again.grants).toMatchObject({ created: 0, existing: 4 });
  });

  it('writes nothing in a dry run, but reports what it would do; flags unknown items', async () => {
    const appStore = new MemoryStore();
    const platformStore = new MemoryStore();
    const report = await migrateBookClub({ source: [...OLD, { PK: 'MYSTERY#1', SK: 'X' }], appStore, platformStore, appSlug: 'book-club', dryRun: true, copyObjects: async () => 99 });
    expect(report).toMatchObject({ appItems: 8, users: { created: 4 }, objectsCopied: 0, skipped: ['MYSTERY#1 / X'] });
    expect(appStore.items.size + platformStore.items.size).toBe(0);
  });

  it('leaves migrated pending users where the platform expects them (a new request does not duplicate it)', async () => {
    const platformStore = new MemoryStore();
    await migrateBookClub({ source: OLD, appStore: new MemoryStore(), platformStore, appSlug: 'book-club' });
    const deps = platformDeps(platformStore);
    const sam = (await getUser(deps, 'sam@x.dev'))!;
    const manifest = { slug: 'book-club', name: 'Book Club', tagline: 't', description: 'd', visibility: 'private' as const, roles: [{ id: 'OWNER', label: 'Owner', canManageAccess: true }, { id: 'MEMBER', label: 'Member' }], topRole: 'OWNER', defaultRole: 'MEMBER', owners: ['owner@x.dev'] };
    expect((await requestAccess(deps, sam, manifest)).role).toBe('PENDING');
    expect((await grantsForApp(deps, 'book-club')).filter((g) => g.email === 'sam@x.dev')).toHaveLength(1);
  });
});
