import { describe, expect, it } from 'vitest';
import { createTestHarness, memberFor, testUserId } from '@stacks/testing';
import { migrate } from '../api/migrations/user-ids';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';

const idFor = (e: string) => `u_${e.toLowerCase().split('@')[0]}`;

describe('user-id migration', () => {
  it('stores list owners and claimers by user id, re-keying the by-claimer index', () => {
    expect(
      migrate({ PK: 'LIST#abc', SK: 'META', GSI1PK: 'LISTS', GSI1SK: 'max#abc', listId: 'abc', ownerName: 'Max', ownerEmail: 'Max@x.dev', note: 'Hi', updatedAt: 't' }, idFor),
    ).toEqual({ PK: 'LIST#abc', SK: 'META', GSI1PK: 'LISTS', GSI1SK: 'abc', listId: 'abc', ownerId: 'u_max', note: 'Hi', updatedAt: 't' });
    expect(
      migrate({ PK: 'CLAIMS#abc', SK: 'w1', GSI1PK: 'CLAIMER#ann@x.dev', GSI1SK: 't', itemId: 'w1', listId: 'abc', claimerEmail: 'ann@x.dev', claimerName: 'Ann', bought: false, claimedAt: 't' }, idFor),
    ).toEqual({ PK: 'CLAIMS#abc', SK: 'w1', GSI1PK: 'CLAIMER#u_ann', GSI1SK: 't', itemId: 'w1', listId: 'abc', claimerId: 'u_ann', bought: false, claimedAt: 't' });
  });

  it('handles the SDK items and leaves list items and migrated items alone', () => {
    expect(migrate({ PK: 'SESSION#abc', SK: 'SESSION' }, idFor)).toBeNull();
    expect(migrate({ PK: 'AUDIT#2026', SK: 'x', actorEmail: 'max@x.dev' }, idFor)).toMatchObject({ actorId: 'u_max' });
    expect(migrate({ PK: 'LIST#abc', SK: 'ITEM#w1', title: 'Socks' }, idFor)).toBeUndefined();
    expect(migrate({ PK: 'LIST#abc', SK: 'META', GSI1PK: 'LISTS', GSI1SK: 'abc', ownerId: 'u_max' }, idFor)).toBeUndefined();
    expect(migrate({ PK: 'CLAIMS#abc', SK: 'w1', GSI1PK: 'CLAIMER#u_ann', claimerId: 'u_ann' }, idFor)).toBeUndefined();
  });

  it('keeps a migrated list at its old id: the owner still finds it, and claims still count', async () => {
    const t = createTestHarness({ manifest, routes });
    t.platform.members = [memberFor('max@x.dev', 'MEMBER', 'Max'), memberFor('ann@x.dev', 'MEMBER', 'Ann')];
    const realIdFor = (e: string) => testUserId(e);
    const legacy: Record<string, unknown>[] = [
      { PK: 'LIST#old', SK: 'META', GSI1PK: 'LISTS', GSI1SK: 'max#old', listId: 'old', ownerName: 'Max', ownerEmail: 'max@x.dev', note: '', updatedAt: 't' },
      { PK: 'LIST#old', SK: 'ITEM#w1', id: 'w1', listId: 'old', title: 'Skateboard', link: null, price: null, priority: 'love', notes: '', addedAt: 't' },
      { PK: 'CLAIMS#old', SK: 'w1', GSI1PK: 'CLAIMER#ann@x.dev', GSI1SK: 't', itemId: 'w1', listId: 'old', claimerEmail: 'ann@x.dev', claimerName: 'Ann', bought: false, claimedAt: 't' },
    ];
    for (const item of legacy) await t.store.put((migrate(item as never, realIdFor) ?? item) as never);

    const max = { as: 'max@x.dev', role: 'MEMBER' };
    const ann = { as: 'ann@x.dev', role: 'MEMBER' };
    expect((await t.call('GET', '/lists', max)).body).toMatchObject({ myListId: 'old', lists: [{ listId: 'old', ownerName: 'Max', mine: true, items: 1 }] });
    expect((await t.call('POST', '/me/items', { ...max, body: { title: 'Socks' } })).body.item.listId).toBe('old');
    expect((await t.call('GET', '/lists/old', ann)).body.items).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Skateboard', status: 'mine' })]));
    expect((await t.call('GET', '/me/claims', ann)).body.groups).toEqual([{ listId: 'old', ownerName: 'Max', items: [expect.objectContaining({ title: 'Skateboard' })] }]);
  });
});
