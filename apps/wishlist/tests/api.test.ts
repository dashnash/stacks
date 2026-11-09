import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@stacks/testing';
import { manifest } from '../api/manifest';
import { listIdFor } from '../api/model';
import { routes } from '../api/routes';

const OLIVE = { as: { email: 'olive@x.dev', name: 'Olive' }, role: 'ORGANIZER' };
const MAX = { as: { email: 'max@x.dev', name: 'Max' }, role: 'MEMBER' };
const ANN = { as: { email: 'ann@x.dev', name: 'Ann' }, role: 'MEMBER' };

async function setup() {
  const t = createTestHarness({ manifest, routes });
  t.platform.members = [
    { email: 'olive@x.dev', name: 'Olive', role: 'ORGANIZER' },
    { email: 'max@x.dev', name: 'Max', role: 'MEMBER' },
    { email: 'ann@x.dev', name: 'Ann', role: 'MEMBER' },
  ];
  const maxList = await listIdFor('max@x.dev');
  const sk = await t.call('POST', '/me/items', { ...MAX, body: { title: 'Skateboard', price: 80, priority: 'love', link: 'https://example.com/sk8' } });
  const socks = await t.call('POST', '/me/items', { ...MAX, body: { title: 'Socks' } });
  return { t, maxList, skate: sk.body.item.id as string, socks: socks.body.item.id as string };
}

describe('your own list', () => {
  it('adds, edits and removes items, with checked input, and logs each change', async () => {
    const { t, socks } = await setup();
    expect((await t.call('PATCH', `/me/items/${socks}`, { ...MAX, body: { notes: 'Wool, size 9', priority: 'idea' } })).body.item).toMatchObject({ title: 'Socks', notes: 'Wool, size 9', priority: 'idea' });
    expect((await t.call('POST', '/me/items', { ...MAX, body: { title: '' } })).status).toBe(400);
    expect((await t.call('POST', '/me/items', { ...MAX, body: { title: 'x', priority: 'must' } })).status).toBe(400);
    expect((await t.call('POST', '/me/items', { ...MAX, body: { title: 'x', link: 'javascript:alert(1)' } })).status).toBe(400);
    expect((await t.call('DELETE', `/me/items/${socks}`, MAX)).status).toBe(200);
    expect(t.platform.audit.map((e) => e.action)).toEqual(['item.add', 'item.add', 'item.update', 'item.remove']);
  });

  it('keeps a note on the list', async () => {
    const { t, maxList } = await setup();
    await t.call('PUT', '/me/note', { ...MAX, body: { note: 'No more mugs' } });
    expect((await t.call('GET', `/lists/${maxList}`, ANN)).body.list).toMatchObject({ ownerName: 'Max', note: 'No more mugs', mine: false });
  });
});

describe('the surprise rule', () => {
  it('never tells owners whether their items are claimed: not on the list, not in the directory, not on delete', async () => {
    const { t, maxList, skate, socks } = await setup();
    const before = await t.call('GET', `/lists/${maxList}`, MAX);
    await t.call('POST', `/lists/${maxList}/items/${skate}/claim`, ANN);
    await t.call('PATCH', `/lists/${maxList}/items/${skate}/claim`, { ...ANN, body: { bought: true } });
    const after = await t.call('GET', `/lists/${maxList}`, MAX);
    expect(after.body).toEqual(before.body); // byte-for-byte the same as before any claim
    expect(JSON.stringify(after.body)).not.toMatch(/status|claim|bought|taken|ann/i);
    const dir = (await t.call('GET', '/lists', MAX)).body.lists.find((l: { mine: boolean }) => l.mine);
    expect(dir).toMatchObject({ items: 2, available: null });
    // Deleting a claimed item answers exactly like deleting an unclaimed one.
    const claimedDelete = await t.call('DELETE', `/me/items/${skate}`, MAX);
    const plainDelete = await t.call('DELETE', `/me/items/${socks}`, MAX);
    expect(claimedDelete.body).toEqual(plainDelete.body);
    expect(claimedDelete.status).toBe(plainDelete.status);
  });

  it('tells the claimer, not the owner, when a claimed item is removed', async () => {
    const { t, maxList, skate } = await setup();
    await t.call('POST', `/lists/${maxList}/items/${skate}/claim`, ANN);
    await t.call('DELETE', `/me/items/${skate}`, MAX);
    expect(t.platform.notifications).toEqual([expect.objectContaining({ email: 'ann@x.dev', text: expect.stringContaining('Skateboard') })]);
    expect((await t.call('GET', '/me/claims', ANN)).body.groups).toEqual([]);
  });
});

describe('claiming from other lists', () => {
  it('shows others available / mine / taken (never who), one claim per item, not on your own list', async () => {
    const { t, maxList, skate, socks } = await setup();
    expect((await t.call('POST', `/lists/${maxList}/items/${skate}/claim`, ANN)).status).toBe(201);
    expect((await t.call('POST', `/lists/${maxList}/items/${skate}/claim`, OLIVE)).status).toBe(409);
    expect((await t.call('POST', `/lists/${maxList}/items/${socks}/claim`, MAX)).status).toBe(403);
    const asOlive = await t.call('GET', `/lists/${maxList}`, OLIVE);
    expect(asOlive.body.items.map((i: { title: string; status: string }) => [i.title, i.status])).toEqual([
      ['Skateboard', 'taken'],
      ['Socks', 'available'],
    ]);
    expect(JSON.stringify(asOlive.body)).not.toContain('ann');
    const asAnn = await t.call('GET', `/lists/${maxList}`, ANN);
    expect(asAnn.body.items[0]).toMatchObject({ status: 'mine', bought: false });
    expect((await t.call('GET', '/lists', OLIVE)).body.lists.find((l: { listId: string }) => l.listId === maxList)).toMatchObject({ items: 2, available: 1 });
  });

  it('lets only the claimer mark bought or unclaim, and lists their claims by person', async () => {
    const { t, maxList, skate } = await setup();
    await t.call('POST', `/lists/${maxList}/items/${skate}/claim`, ANN);
    expect((await t.call('PATCH', `/lists/${maxList}/items/${skate}/claim`, { ...OLIVE, body: { bought: true } })).status).toBe(404);
    expect((await t.call('DELETE', `/lists/${maxList}/items/${skate}/claim`, OLIVE)).status).toBe(404);
    await t.call('PATCH', `/lists/${maxList}/items/${skate}/claim`, { ...ANN, body: { bought: true } });
    expect((await t.call('GET', '/me/claims', ANN)).body.groups).toEqual([{ listId: maxList, ownerName: 'Max', items: [expect.objectContaining({ title: 'Skateboard', bought: true })] }]);
    expect((await t.call('DELETE', `/lists/${maxList}/items/${skate}/claim`, ANN)).status).toBe(200);
    expect((await t.call('GET', `/lists/${maxList}`, OLIVE)).body.items[0].status).toBe('available');
    expect(t.platform.audit.map((e) => e.action).slice(2)).toEqual(['claim.add', 'claim.bought', 'claim.remove']);
  });

  it("lets organizers remove an item from someone else's list, releasing its claim; members cannot", async () => {
    const { t, maxList, skate } = await setup();
    await t.call('POST', `/lists/${maxList}/items/${skate}/claim`, ANN);
    expect((await t.call('DELETE', `/lists/${maxList}/items/${skate}`, ANN)).status).toBe(403);
    expect((await t.call('DELETE', `/lists/${maxList}/items/${skate}`, OLIVE)).status).toBe(200);
    expect((await t.call('GET', `/lists/${maxList}`, MAX)).body.items.map((i: { title: string }) => i.title)).toEqual(['Socks']);
    expect(t.platform.notifications.map((n) => n.email)).toEqual(['ann@x.dev']);
  });

  it('needs sign-in for everything', async () => {
    const { t } = await setup();
    expect((await t.call('GET', '/lists')).status).toBe(401);
  });
});
