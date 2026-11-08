import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@stacks/testing';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';

const HOST = { as: { email: 'olive@x.dev', name: 'Olive' }, role: 'HOST' };
const MAX = { as: { email: 'max@x.dev', name: 'Max' }, role: 'GUEST' };
const ANN = { as: { email: 'ann@x.dev', name: 'Ann' }, role: 'GUEST' };
const needs = { mains: 1, sides: 2, desserts: 1, drinks: 0 };

async function withEvent(overrides: Record<string, unknown> = {}) {
  const t = createTestHarness({ manifest, routes });
  t.platform.members = [
    { email: 'olive@x.dev', name: 'Olive', role: 'HOST' },
    { email: 'max@x.dev', name: 'Max', role: 'GUEST' },
    { email: 'ann@x.dev', name: 'Ann', role: 'GUEST' },
  ];
  const res = await t.call('POST', '/events', { ...HOST, body: { title: 'Harvest', startsAt: '2026-01-10T23:00:00Z', place: '14 Maple Ct', needs, ...overrides } });
  return { t, res, id: res.body.event?.id as string };
}

describe('potlucks', () => {
  it('lets hosts post one, tells everyone else, and logs it', async () => {
    const { t, res } = await withEvent();
    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({ title: 'Harvest', needs, hostName: 'Olive', cancelled: false });
    expect(t.platform.notifications.map((n) => n.email).sort()).toEqual(['ann@x.dev', 'max@x.dev']);
    expect(t.platform.notifications[0]!.text).toContain('New potluck: Harvest');
    expect(t.platform.audit.map((e) => e.action)).toEqual(['event.create']);
  });

  it('only hosts post, edit and cancel; input is checked', async () => {
    const { t, id } = await withEvent();
    expect((await t.call('POST', '/events', { ...MAX, body: { title: 'x', startsAt: '2026-01-10T23:00:00Z', place: 'p', needs } })).status).toBe(403);
    expect((await t.call('PATCH', `/events/${id}`, { ...MAX, body: { title: 'Mine now' } })).status).toBe(403);
    expect((await t.call('POST', `/events/${id}/cancel`, MAX)).status).toBe(403);
    expect((await t.call('POST', '/events', { ...HOST, body: { title: 'x', startsAt: 'soon', place: 'p', needs } })).status).toBe(400);
    expect((await t.call('POST', '/events', { ...HOST, body: { title: 'x', startsAt: '2026-01-10T23:00:00Z', place: 'p', needs: { mains: 0, sides: 0, desserts: 0, drinks: 0 } } })).status).toBe(400);
    expect((await t.call('POST', '/events', { ...HOST, body: { title: 'x', startsAt: '2026-01-10T23:00:00Z', place: 'p', needs: { ...needs, mains: 21 } } })).status).toBe(400);
  });

  it('lists upcoming potlucks soonest first with course counts, headcount and my RSVP; past ones drop off', async () => {
    const { t, id } = await withEvent();
    await t.call('POST', '/events', { ...HOST, body: { title: 'Sooner', startsAt: '2026-01-05T23:00:00Z', place: 'p', needs } });
    await t.call('POST', '/events', { ...HOST, body: { title: 'Long gone', startsAt: '2025-06-01T23:00:00Z', place: 'p', needs } });
    await t.call('PUT', `/events/${id}/rsvp`, { ...MAX, body: { status: 'going', guests: 2 } });
    await t.call('POST', `/events/${id}/dishes`, { ...MAX, body: { course: 'sides', name: 'Slaw' } });
    const list = await t.call('GET', '/events', MAX);
    expect(list.body.events.map((e: { title: string }) => e.title)).toEqual(['Sooner', 'Harvest']);
    expect(list.body.events[1]).toMatchObject({ headcount: 3, myRsvp: 'going', myDishes: 1, filled: { mains: 0, sides: 1, desserts: 0, drinks: 0 } });
    expect(list.body.canHost).toBe(false);
  });

  it('shows signed-out visitors only a count of upcoming potlucks', async () => {
    const { t, id } = await withEvent();
    await t.call('POST', '/events', { ...HOST, body: { title: 'Two', startsAt: '2026-01-20T23:00:00Z', place: 'Secret St', needs } });
    await t.call('POST', `/events/${id}/cancel`, HOST);
    const pub = await t.call('GET', '/public/summary');
    expect(pub.body).toEqual({ upcoming: 1 });
    expect((await t.call('GET', '/events')).status).toBe(401);
  });

  it('edits move the date on the list, and cancelled potlucks stop taking sign-ups', async () => {
    const { t, id } = await withEvent();
    await t.call('POST', '/events', { ...HOST, body: { title: 'Other', startsAt: '2026-01-08T23:00:00Z', place: 'p', needs } });
    const edited = await t.call('PATCH', `/events/${id}`, { ...HOST, body: { startsAt: '2026-01-06T23:00:00Z', notes: 'Bring chairs' } });
    expect(edited.body.event).toMatchObject({ title: 'Harvest', notes: 'Bring chairs', needs });
    expect((await t.call('GET', '/events', MAX)).body.events.map((e: { title: string }) => e.title)).toEqual(['Harvest', 'Other']);
    await t.call('POST', `/events/${id}/cancel`, HOST);
    expect((await t.call('POST', `/events/${id}/dishes`, { ...MAX, body: { course: 'mains', name: 'Stew' } })).status).toBe(403);
    expect((await t.call('PUT', `/events/${id}/rsvp`, { ...MAX, body: { status: 'going' } })).status).toBe(403);
    expect(t.platform.audit.map((e) => e.action)).toEqual(['event.create', 'event.create', 'event.update', 'event.cancel']);
  });
});

describe('dishes and RSVPs', () => {
  it('lets guests sign up while a course has room, with tags, and shows who brings what without emails', async () => {
    const { t, id } = await withEvent();
    const add = await t.call('POST', `/events/${id}/dishes`, { ...MAX, body: { course: 'mains', name: 'Veggie chili', serves: 8, tags: ['vegan', 'gluten-free'] } });
    expect(add.status).toBe(201);
    const full = await t.call('POST', `/events/${id}/dishes`, { ...ANN, body: { course: 'mains', name: 'Lasagna' } });
    expect(full.status).toBe(409);
    expect((await t.call('POST', `/events/${id}/dishes`, { ...ANN, body: { course: 'drinks', name: 'Soda' } })).status).toBe(409); // none needed
    expect((await t.call('POST', `/events/${id}/dishes`, { ...ANN, body: { course: 'snacks', name: 'Chips' } })).status).toBe(400);
    expect((await t.call('POST', `/events/${id}/dishes`, { ...ANN, body: { course: 'sides', name: 'Chips', tags: ['keto'] } })).status).toBe(400);
    const page = await t.call('GET', `/events/${id}`, ANN);
    expect(page.body.dishes).toEqual([expect.objectContaining({ name: 'Veggie chili', bringerName: 'Max', serves: 8, tags: ['vegan', 'gluten-free'], mine: false, canRemove: false })]);
    expect(JSON.stringify(page.body.dishes)).not.toContain('@x.dev');
  });

  it('lets people change or drop only their own dish; hosts can remove any', async () => {
    const { t, id } = await withEvent();
    const { body } = await t.call('POST', `/events/${id}/dishes`, { ...MAX, body: { course: 'sides', name: 'Slaw' } });
    const dish = `/events/${id}/dishes/${body.dish.id}`;
    expect((await t.call('PATCH', dish, { ...ANN, body: { name: 'Mine' } })).status).toBe(403);
    expect((await t.call('PATCH', dish, { ...MAX, body: { name: 'Vinegar slaw', tags: ['vegan'] } })).body.dish).toMatchObject({ name: 'Vinegar slaw', tags: ['vegan'] });
    expect((await t.call('DELETE', dish, ANN)).status).toBe(403);
    expect((await t.call('DELETE', dish, HOST)).status).toBe(200);
    expect((await t.call('DELETE', dish, MAX)).status).toBe(404);
    expect(t.platform.audit.map((e) => e.action).slice(1)).toEqual(['dish.add', 'dish.update', 'dish.remove']);
  });

  it('records RSVPs with guests only when going, and counts the headcount', async () => {
    const { t, id } = await withEvent();
    await t.call('PUT', `/events/${id}/rsvp`, { ...MAX, body: { status: 'going', guests: 2 } });
    await t.call('PUT', `/events/${id}/rsvp`, { ...ANN, body: { status: 'maybe', guests: 3 } });
    expect((await t.call('PUT', `/events/${id}/rsvp`, { ...ANN, body: { status: 'yes' } })).status).toBe(400);
    expect((await t.call('PUT', `/events/${id}/rsvp`, { ...ANN, body: { status: 'going', guests: 9 } })).status).toBe(400);
    const page = await t.call('GET', `/events/${id}`, MAX);
    expect(page.body.headcount).toBe(3);
    expect(page.body.rsvps).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Max', status: 'going', guests: 2, mine: true }), expect.objectContaining({ name: 'Ann', status: 'maybe', guests: 0, mine: false })]),
    );
  });

  it('refuses sign-ups once a potluck is over', async () => {
    const { t, id } = await withEvent({ startsAt: '2025-12-01T23:00:00Z' });
    expect((await t.call('POST', `/events/${id}/dishes`, { ...MAX, body: { course: 'mains', name: 'Stew' } })).status).toBe(403);
  });
});
