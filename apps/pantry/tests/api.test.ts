import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '@stacks/api';
import { createTestHarness, memberFor, testUserId } from '@stacks/testing';
import { manifest } from '../api/manifest';
import { NOTIFY_THROTTLE_MS, rankSuggestions, routes, type HistoryEntry } from '../api/routes';

const SAM = { email: 'sam@x.dev', name: 'Sam' };
const ALEX = { email: 'alex@x.dev', name: 'Alex' };
const KIM = { email: 'kim@x.dev', name: 'Kim' };

/** A harness with Sam (Owner), Alex and Kim (Members) in the app. `fixedClock` stops the clock ticking. */
function harness(opts: { fixedClock?: boolean } = {}) {
  let clock = Date.parse('2026-11-11T09:00:00Z');
  const t = createTestHarness<AppDeps>({
    manifest,
    routes,
    ...(opts.fixedClock ? { extend: (base: AppDeps) => ({ ...base, now: () => new Date(clock) }) } : {}),
  });
  t.platform.members = [memberFor(SAM.email, 'OWNER', 'Sam'), memberFor(ALEX.email, 'MEMBER', 'Alex'), memberFor(KIM.email, 'MEMBER', 'Kim')];
  const as = (who: typeof SAM) => ({ as: who, role: who === SAM ? 'OWNER' : 'MEMBER' });
  const tick = (ms: number) => {
    clock += ms;
    t.advance(ms);
  };
  async function newList(name = 'Weekly shop') {
    const res = await t.call('POST', '/lists', { ...as(SAM), body: { name } });
    expect(res.status).toBe(201);
    return res.body.list.id as string;
  }
  async function add(listId: string, items: { name: string; quantity?: string }[], who = SAM) {
    return t.call('POST', `/lists/${listId}/items`, { ...as(who), body: { items } });
  }
  return { t, as, tick, newList, add };
}

describe('Pantry API: lists and items', () => {
  it('creates, renames, lists (with counts and mute state) and deletes lists', async () => {
    const { t, as, newList, add } = harness();
    const id = await newList();
    expect(id).toMatch(/^[A-Za-z0-9-]+$/);
    await add(id, [{ name: 'Milk' }, { name: 'Eggs' }]);
    expect((await t.call('PATCH', `/lists/${id}`, { ...as(ALEX), body: { name: 'Big shop' } })).body.list.name).toBe('Big shop');
    const lists = (await t.call('GET', '/lists', as(ALEX))).body.lists;
    expect(lists).toEqual([expect.objectContaining({ id, name: 'Big shop', open: 2, done: 0, muted: false })]);
    expect((await t.call('DELETE', `/lists/${id}`, as(ALEX))).status).toBe(200);
    expect((await t.call('GET', '/lists', as(SAM))).body.lists).toEqual([]);
    expect((await t.call('GET', `/lists/${id}`, as(SAM))).status).toBe(404);
    expect(t.platform.audit.map((e) => e.action)).toEqual(['list.create', 'item.add', 'list.rename', 'list.delete']);
  });

  it('rejects bad input: empty or 81-character names, 21-character quantities, 0 or 21 items', async () => {
    const { t, as, newList, add } = harness();
    const id = await newList();
    expect((await add(id, [{ name: '' }])).status).toBe(400);
    expect((await add(id, [{ name: '   ' }])).status).toBe(400);
    expect((await add(id, [{ name: 'x'.repeat(81) }])).status).toBe(400);
    expect((await add(id, [{ name: 'Rice', quantity: 'q'.repeat(21) }])).status).toBe(400);
    expect((await add(id, Array.from({ length: 21 }, (_, i) => ({ name: `Thing ${i}` })))).status).toBe(400);
    expect((await add(id, [])).status).toBe(400);
    expect((await t.call('POST', `/lists/${id}/items`, { ...as(SAM), body: { items: 'Milk' } })).status).toBe(400);
    expect((await t.call('POST', '/lists', { ...as(SAM), body: { name: ' ' } })).status).toBe(400);
    // At the limits is fine, and names are trimmed.
    const ok = await add(id, [{ name: `  ${'x'.repeat(80)}  `, quantity: 'q'.repeat(20) }]);
    expect(ok.status).toBe(201);
    expect(ok.body.added[0]).toMatchObject({ name: 'x'.repeat(80), quantity: 'q'.repeat(20), done: false, createdBy: testUserId(SAM.email) });
    expect((await add(id, Array.from({ length: 20 }, (_, i) => ({ name: `Thing ${i}` })))).status).toBe(201);
    const item = ok.body.added[0].id;
    expect((await t.call('PATCH', `/lists/${id}/items/${item}`, { ...as(SAM), body: { done: 'yes' } })).status).toBe(400);
    expect((await t.call('PATCH', `/lists/${id}/items/${item}`, { ...as(SAM), body: { name: 'y'.repeat(81) } })).status).toBe(400);
  });

  it('is for members only: signed-out visitors and people waiting for approval are refused', async () => {
    const { t, newList } = harness();
    const id = await newList();
    for (const [method, path] of [
      ['GET', '/lists'],
      ['POST', '/lists'],
      ['GET', `/lists/${id}`],
      ['POST', `/lists/${id}/items`],
      ['GET', `/lists/${id}/suggestions`],
      ['PUT', `/lists/${id}/mute`],
    ] as const) {
      expect((await t.call(method, path, { body: {} })).status).toBe(401);
      // Someone who asked for access and hasn't been let in yet holds no role the app declares, so
      // the SDK gives them no viewer at all (401 NOT_SIGNED_IN: the app shows the request-access notice).
      const pending = await t.call(method, path, { as: 'waiting@x.dev', role: 'PENDING', body: {} });
      expect(pending.status).toBe(401);
    }
  });

  it('bumps the version on every write, and ?since answers unchanged when nothing changed', async () => {
    const { t, as, newList, add } = harness();
    const id = await newList();
    const v0 = (await t.call('GET', `/lists/${id}`, as(SAM))).body.list.version;
    const added = await add(id, [{ name: 'Milk' }]);
    const v1 = added.body.list.version;
    expect(v1).toBeGreaterThan(v0);
    const item = added.body.added[0].id;
    const edited = await t.call('PATCH', `/lists/${id}/items/${item}`, { ...as(ALEX), body: { name: 'Oat milk', quantity: '2' } });
    expect(edited.body.item).toMatchObject({ name: 'Oat milk', quantity: '2', updatedBy: testUserId(ALEX.email), createdBy: testUserId(SAM.email) });
    const v2 = edited.body.list.version;
    expect(v2).toBeGreaterThan(v1);
    const toggled = await t.call('PATCH', `/lists/${id}/items/${item}`, { ...as(ALEX), body: { done: true } });
    const v3 = toggled.body.list.version;
    expect(v3).toBeGreaterThan(v2);
    expect(toggled.body.list).toMatchObject({ open: 0, done: 1 });

    expect((await t.call('GET', `/lists/${id}`, { ...as(SAM), query: { since: String(v3) } })).body).toEqual({ unchanged: true, version: v3 });
    const stale = await t.call('GET', `/lists/${id}`, { ...as(SAM), query: { since: String(v1) } });
    expect(stale.body.list.version).toBe(v3);
    expect(stale.body.items).toEqual([expect.objectContaining({ id: item, done: true })]);
  });

  it('makes done idempotent (PUT-like, not a flip) and clears quantity on an empty value', async () => {
    const { t, as, newList, add } = harness();
    const id = await newList();
    const item = (await add(id, [{ name: 'Milk', quantity: '2' }])).body.added[0].id;
    const first = (await t.call('PATCH', `/lists/${id}/items/${item}`, { ...as(SAM), body: { done: true } })).body.item;
    const again = (await t.call('PATCH', `/lists/${id}/items/${item}`, { ...as(ALEX), body: { done: true } })).body.item;
    expect(again.done).toBe(true);
    expect(again.doneAt).toBe(first.doneAt);
    expect((await t.call('PATCH', `/lists/${id}/items/${item}`, { ...as(SAM), body: { done: false } })).body.item).not.toHaveProperty('doneAt');
    expect((await t.call('PATCH', `/lists/${id}/items/${item}`, { ...as(SAM), body: { quantity: '' } })).body.item).not.toHaveProperty('quantity');
  });

  it('orders open items oldest first, then done items most recently checked first', async () => {
    const { t, as, newList, add } = harness();
    const id = await newList();
    const ids = (await add(id, [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])).body.added.map((i: { id: string }) => i.id);
    await t.call('PATCH', `/lists/${id}/items/${ids[0]}`, { ...as(SAM), body: { done: true } });
    await t.call('PATCH', `/lists/${id}/items/${ids[2]}`, { ...as(SAM), body: { done: true } });
    const items = (await t.call('GET', `/lists/${id}`, as(SAM))).body.items;
    expect(items.map((i: { name: string }) => i.name)).toEqual(['B', 'D', 'C', 'A']);
  });

  it("answers 404 when editing or removing an item someone else already removed", async () => {
    const { t, as, newList, add } = harness();
    const id = await newList();
    const item = (await add(id, [{ name: 'Milk' }])).body.added[0].id;
    expect((await t.call('DELETE', `/lists/${id}/items/${item}`, as(ALEX))).body.removed).toMatchObject({ id: item, name: 'Milk' });
    expect((await t.call('PATCH', `/lists/${id}/items/${item}`, { ...as(SAM), body: { name: 'Milk!' } })).status).toBe(404);
    expect((await t.call('DELETE', `/lists/${id}/items/${item}`, as(SAM))).status).toBe(404);
  });

  it('round-trips Clear Complete and restore with the same ids', async () => {
    const { t, as, newList, add } = harness();
    const id = await newList();
    const ids = (await add(id, [{ name: 'Milk', quantity: '2' }, { name: 'Eggs' }, { name: 'Bread' }])).body.added.map((i: { id: string }) => i.id);
    await t.call('PATCH', `/lists/${id}/items/${ids[0]}`, { ...as(SAM), body: { done: true } });
    await t.call('PATCH', `/lists/${id}/items/${ids[1]}`, { ...as(SAM), body: { done: true } });
    const before = (await t.call('GET', `/lists/${id}`, as(SAM))).body.items;

    const cleared = await t.call('POST', `/lists/${id}/clear-complete`, as(ALEX));
    expect(cleared.body.removed.map((i: { id: string }) => i.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(cleared.body.items.map((i: { id: string }) => i.id)).toEqual([ids[2]]);
    expect(cleared.body.list).toMatchObject({ open: 1, done: 0 });

    const restored = await t.call('POST', `/lists/${id}/items/restore`, { ...as(ALEX), body: { items: cleared.body.removed } });
    expect(restored.status).toBe(200);
    const strip = (items: Record<string, unknown>[]) => items.map(({ updatedBy: _u, ...rest }) => rest);
    expect(strip(restored.body.items)).toEqual(strip(before));
    expect(restored.body.list).toMatchObject({ open: 1, done: 2 });
    expect((await t.call('POST', `/lists/${id}/items/restore`, { ...as(ALEX), body: { items: [{ id: 'x', name: 'Milk' }] } })).status).toBe(400);
  });

  it('deletes everything under a list: items, history, mutes and throttle records', async () => {
    const { t, as, newList, add } = harness();
    const id = await newList();
    const other = await newList('Other');
    await add(id, [{ name: 'Milk' }], ALEX);
    await t.call('PUT', `/lists/${id}/mute`, { ...as(KIM), body: { muted: true } });
    const rows = () => [...t.store.items.values()].filter((i) => i.PK === `LIST#${id}`).map((i) => i.SK.split('#')[0]);
    expect(new Set(rows())).toEqual(new Set(['META', 'ITEM', 'HIST', 'MUTE', 'NOTIFIED']));
    await t.call('DELETE', `/lists/${id}`, as(SAM));
    expect(rows()).toEqual([]);
    expect((await t.call('GET', `/lists/${other}`, as(SAM))).status).toBe(200);
  });
});

describe('Pantry API: autocomplete history', () => {
  it('counts uses, keeps the last quantity, merges names case-insensitively, and survives clear-complete', async () => {
    const { t, as, newList, add } = harness();
    const id = await newList();
    const milk = (await add(id, [{ name: 'milk', quantity: '1' }])).body.added[0].id;
    await add(id, [{ name: 'Milk', quantity: '2' }]);
    await add(id, [{ name: 'MILK' }]);
    const suggestions = async (q: string) => (await t.call('GET', `/lists/${id}/suggestions`, { ...as(ALEX), query: { q } })).body.suggestions;
    expect(await suggestions('mi')).toEqual([expect.objectContaining({ key: 'milk', name: 'MILK', count: 3, lastQuantity: '2' })]);

    // Renaming an item counts a use of the new name.
    await t.call('PATCH', `/lists/${id}/items/${milk}`, { ...as(SAM), body: { name: 'Oat milk' } });
    expect(await suggestions('oat')).toEqual([expect.objectContaining({ key: 'oat milk', count: 1, lastQuantity: '1' })]);

    for (const i of (await t.call('GET', `/lists/${id}`, as(SAM))).body.items) await t.call('PATCH', `/lists/${id}/items/${i.id}`, { ...as(SAM), body: { done: true } });
    await t.call('POST', `/lists/${id}/clear-complete`, as(SAM));
    expect((await t.call('GET', `/lists/${id}`, as(SAM))).body.items).toEqual([]);
    expect((await suggestions('m')).map((s: HistoryEntry) => s.key)).toEqual(['milk', 'oat milk']);

    // ✕ removes an entry (keys are case-insensitive).
    expect((await t.call('DELETE', `/lists/${id}/suggestions/${encodeURIComponent('Oat Milk')}`, as(ALEX))).status).toBe(200);
    expect((await suggestions('m')).map((s: HistoryEntry) => s.key)).toEqual(['milk']);
    expect((await t.call('DELETE', `/lists/${id}/suggestions/nothing`, as(ALEX))).status).toBe(404);
    expect(await suggestions('')).toEqual([]);
  });

  it('keeps history per list', async () => {
    const { t, as, newList, add } = harness();
    const a = await newList('A');
    const b = await newList('B');
    await add(a, [{ name: 'Milk' }]);
    expect((await t.call('GET', `/lists/${b}/suggestions`, { ...as(SAM), query: { q: 'mi' } })).body.suggestions).toEqual([]);
  });

  it('ranks prefix matches before any-word matches, each by use count, at most 8', () => {
    const e = (name: string, count: number): HistoryEntry => ({ key: name.toLowerCase(), name, count, lastUsedAt: '2026-11-01T00:00:00Z' });
    const entries = [e('Oat milk', 9), e('Milk', 2), e('Milky Way', 5), e('Almond milk', 1), e('Coconut milk', 3), e('Bread', 50)];
    expect(rankSuggestions(entries, 'MIL').map((s) => s.name)).toEqual(['Milky Way', 'Milk', 'Oat milk', 'Coconut milk', 'Almond milk']);
    const many = Array.from({ length: 12 }, (_, i) => e(`Tea ${i}`, i));
    expect(rankSuggestions(many, 'tea')).toHaveLength(8);
    expect(rankSuggestions(many, 'tea')[0]!.name).toBe('Tea 11');
  });
});

describe('Pantry API: notifications', () => {
  it('tells every subscribed member but the actor, with a deep link; muted members hear nothing', async () => {
    const { t, as, newList, add } = harness();
    const id = await newList();
    await t.call('PUT', `/lists/${id}/mute`, { ...as(KIM), body: { muted: true } });
    expect((await t.call('GET', '/lists', as(KIM))).body.lists[0].muted).toBe(true);
    await add(id, [{ name: 'Milk' }], ALEX);
    expect(t.platform.notifications).toEqual([{ userId: testUserId(SAM.email), text: 'Alex added Milk to Weekly shop', link: `https://pantry.stacks.test/#/l/${id}` }]);
    // Unmuting brings Kim back.
    await t.call('PUT', `/lists/${id}/mute`, { ...as(KIM), body: { muted: false } });
    expect((await t.call('PUT', `/lists/${id}/mute`, { ...as(KIM), body: { muted: 'no' } })).status).toBe(400);
    await add(id, [{ name: 'Eggs' }], ALEX);
    expect(t.platform.notifications.map((n) => n.userId)).toEqual([testUserId(SAM.email), testUserId(KIM.email)]);
  });

  it('sends nothing for check-offs, removals or Clear Complete; edits notify', async () => {
    const { t, as, tick, newList, add } = harness();
    const id = await newList();
    const [milk, bread] = (await add(id, [{ name: 'Milk' }, { name: 'Bread' }])).body.added.map((i: { id: string }) => i.id);
    const sent = () => t.platform.notifications.length;
    expect(sent()).toBe(2); // Alex and Kim
    tick(NOTIFY_THROTTLE_MS + 60_000); // so the throttle can't be what keeps these quiet
    await t.call('PATCH', `/lists/${id}/items/${milk}`, { ...as(SAM), body: { done: true } });
    await t.call('PATCH', `/lists/${id}/items/${milk}`, { ...as(SAM), body: { done: false } });
    await t.call('PATCH', `/lists/${id}/items/${milk}`, { ...as(SAM), body: { done: true } });
    await t.call('POST', `/lists/${id}/clear-complete`, as(SAM));
    await t.call('DELETE', `/lists/${id}/items/${bread}`, as(SAM));
    expect(sent()).toBe(2);
    const rice = (await add(id, [{ name: 'Rice' }])).body.added[0].id;
    expect(sent()).toBe(4);
    tick(NOTIFY_THROTTLE_MS + 60_000);
    await t.call('PATCH', `/lists/${id}/items/${rice}`, { ...as(SAM), body: { quantity: '1 kg' } });
    expect(sent()).toBe(6);
    expect(t.platform.notifications.at(-1)!.text).toBe('Sam changed Rice on Weekly shop');
  });

  it('throttles to one per (list, subscriber) every 10 minutes: suppressed at 10 min, sent at 10 min + 1 s', async () => {
    const { t, tick, newList, add } = harness({ fixedClock: true });
    const id = await newList();
    const other = await newList('Other');
    const toAlex = () => t.platform.notifications.filter((n) => n.userId === testUserId(ALEX.email)).map((n) => n.text);
    await add(id, [{ name: 'Milk' }]);
    expect(toAlex()).toEqual(['Sam added Milk to Weekly shop']);
    tick(60_000);
    await add(id, [{ name: 'Eggs' }]);
    await add(other, [{ name: 'Tea' }]); // another list has its own window
    expect(toAlex()).toEqual(['Sam added Milk to Weekly shop', 'Sam added Tea to Other']);
    tick(NOTIFY_THROTTLE_MS - 60_000);
    await add(id, [{ name: 'Bread' }]);
    expect(toAlex()).toHaveLength(2);
    tick(1000);
    await add(id, [{ name: 'Butter' }]);
    expect(toAlex().at(-1)).toBe('Sam added Butter to Weekly shop');
  });

  it('sends one notification for a bulk add, naming how many', async () => {
    const { t, newList, add } = harness();
    const id = await newList();
    await add(id, [{ name: 'Milk' }, { name: 'Eggs' }, { name: 'Bread' }], ALEX);
    expect(t.platform.notifications.map((n) => [n.userId, n.text])).toEqual([
      [testUserId(SAM.email), 'Alex added 3 items to Weekly shop'],
      [testUserId(KIM.email), 'Alex added 3 items to Weekly shop'],
    ]);
  });

  it('still saves the item when notifying fails', async () => {
    const { t, as, newList, add } = harness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const id = await newList();
    t.platform.notify = async () => Promise.reject(new Error('platform down'));
    expect((await add(id, [{ name: 'Milk' }])).status).toBe(201);
    expect((await t.call('GET', `/lists/${id}`, as(SAM))).body.items).toHaveLength(1);
    error.mockRestore();
  });
});

describe('Pantry API: realtime hints', () => {
  it('publishes { version } on list/<id> after every write, with the new version', async () => {
    const { t, as, newList, add } = harness();
    const id = await newList();
    const versions: number[] = [(await t.call('GET', `/lists/${id}`, as(SAM))).body.list.version];
    const added = await add(id, [{ name: 'Milk' }, { name: 'Eggs' }]);
    versions.push(added.body.list.version);
    const [milk, eggs] = added.body.added.map((i: { id: string }) => i.id);
    const writes = [
      () => t.call('PATCH', `/lists/${id}/items/${milk}`, { ...as(SAM), body: { quantity: '2' } }),
      () => t.call('PATCH', `/lists/${id}/items/${milk}`, { ...as(SAM), body: { done: true } }),
      () => t.call('DELETE', `/lists/${id}/items/${eggs}`, as(SAM)),
      () => t.call('POST', `/lists/${id}/clear-complete`, as(SAM)),
      () => t.call('POST', `/lists/${id}/items/restore`, { ...as(SAM), body: { items: [{ id: eggs, name: 'Eggs', done: false, createdBy: 'u', createdAt: '2026-11-11T09:00:00Z', updatedAt: '2026-11-11T09:00:00Z' }] } }),
      () => t.call('PATCH', `/lists/${id}`, { ...as(SAM), body: { name: 'Renamed' } }),
    ];
    for (const w of writes) versions.push((await w()).body.list.version);
    expect(t.realtime.on(`list/${id}`)).toEqual(versions.map((version) => ({ version })));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('publishes on lists when a list is created, renamed or deleted, or a count changes; deleting sends { deleted: true }', async () => {
    const { t, as, newList, add } = harness();
    const id = await newList();
    const hints = () => t.realtime.on('lists').length;
    expect(hints()).toBe(1);
    const item = (await add(id, [{ name: 'Milk' }])).body.added[0].id;
    expect(hints()).toBe(2);
    await t.call('PATCH', `/lists/${id}/items/${item}`, { ...as(SAM), body: { quantity: '2' } });
    expect(hints()).toBe(2); // counts unchanged
    await t.call('PATCH', `/lists/${id}/items/${item}`, { ...as(SAM), body: { done: true } });
    expect(hints()).toBe(3);
    await t.call('PATCH', `/lists/${id}`, { ...as(SAM), body: { name: 'B' } });
    expect(hints()).toBe(4);
    await t.call('DELETE', `/lists/${id}`, as(SAM));
    expect(hints()).toBe(5);
    expect(t.realtime.on('lists').every((d) => JSON.stringify(d) === '{}')).toBe(true);
    expect(t.realtime.on(`list/${id}`).at(-1)).toEqual({ deleted: true });
  });

  it('never fails a write because a publish failed', async () => {
    const { t, as, newList, add } = harness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const id = await newList();
    t.realtime.publish = async () => Promise.reject(new Error('AppSync down'));
    expect((await add(id, [{ name: 'Milk' }])).status).toBe(201);
    expect((await t.call('DELETE', `/lists/${id}`, as(SAM))).status).toBe(200);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('hands members subscribe-only tokens, and refuses client publish and people waiting for approval', async () => {
    const { t, as, newList } = harness();
    const id = await newList();
    expect((await t.call('POST', '/realtime/token', { ...as(ALEX), body: { subscribe: ['lists', `list/${id}`] } })).status).toBe(200);
    expect((await t.call('POST', '/realtime/token', { ...as(ALEX), body: { publish: [`list/${id}`] } })).body.code).toBe('REALTIME_SUBSCRIBE_ONLY');
    expect((await t.call('POST', '/realtime/token', { ...as(ALEX), body: { publish: ['lists'] } })).body.code).toBe('REALTIME_SUBSCRIBE_ONLY');
    expect((await t.call('POST', '/realtime/token', { ...as(ALEX), body: { subscribe: ['counter/main'] } })).body.code).toBe('REALTIME_UNDECLARED');
    expect((await t.call('POST', '/realtime/token', { as: 'waiting@x.dev', role: 'PENDING', body: { subscribe: [`list/${id}`] } })).status).toBe(401);
    expect((await t.call('POST', '/realtime/token', { body: { subscribe: [`list/${id}`] } })).status).toBe(401);
  });
});
