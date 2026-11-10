import { testUserId as idOf } from '@stacks/testing';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../helpers';

const ADMIN = 'admin@club.test';
const ALICE = 'alice@club.test';
const BOB = 'bob@club.test';
const PHM = '9780593135204';

async function setup() {
  // The admin here is the owner, who alone can make people admins.
  const t = makeTestApp();
  await t.seedUser(ADMIN, 'OWNER', 'Admin');
  await t.seedUser(ALICE, 'MEMBER', 'Alice');
  await t.seedUser(BOB, 'MEMBER', 'Bob');
  const log = async (query: Record<string, string> = {}) => (await t.call('GET', '/admin/audit', { as: ADMIN, query })).body;
  return { t, log };
}

describe('the activity log', () => {
  it('records sign-ins and every change, newest first, with who, what and on what', async () => {
    const { t, log } = await setup();
    const nomination = (await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } })).body.nomination.id;
    await t.call('POST', `/nominations/${nomination}/vote`, { as: ALICE });
    const comment = (await t.call('POST', `/threads/book/${PHM}`, { as: ALICE, body: { body: 'Rocky rules' } })).body.comment.id;
    await t.call('PATCH', `/threads/book/${PHM}/comments/${comment}`, { as: ALICE, body: { body: 'Rocky RULES' } });
    await t.call('DELETE', `/threads/book/${PHM}/comments/${comment}`, { as: ADMIN });
    await t.call('PATCH', `/books/${PHM}`, { as: BOB, body: { publisher: 'Ballantine', pageCount: 496 } });
    // Reads are not logged; failed actions are not logged.
    await t.call('GET', '/nominations', { as: ALICE });
    await t.call('PATCH', `/books/${PHM}`, { as: ALICE, body: { title: 'Hijacked' } });

    const { events } = await log();
    expect(events.map((e: { action: string; actorId: string }) => [e.action, e.actorId])).toEqual([
      ['book.edit', idOf(BOB)],
      ['comment.delete', idOf(ADMIN)],
      ['comment.edit', idOf(ALICE)],
      ['comment.post', idOf(ALICE)],
      ['vote.add', idOf(ALICE)],
      ['nomination.create', idOf(BOB)],
    ]);
    const byAction = Object.fromEntries(events.map((e: { action: string }) => [e.action, e]));
    expect(byAction['nomination.create']).toMatchObject({ actorName: 'Bob', label: 'Project Hail Mary', details: { input: { isbn: PHM } } });
    expect(byAction['vote.add'].label).toBe('Project Hail Mary');
    expect(byAction['comment.post']).toMatchObject({ label: 'Project Hail Mary', params: { kind: 'book', id: PHM }, details: { input: { body: 'Rocky rules' } } });
    expect(byAction['comment.edit'].details).toMatchObject({ before: 'Rocky rules', input: { body: 'Rocky RULES' } });
    expect(byAction['comment.delete'].details).toEqual({ author: idOf(ALICE), text: 'Rocky RULES', byModerator: true });
    expect(byAction['book.edit'].details.changes).toEqual({
      publisher: { from: null, to: 'Ballantine' },
      pageCount: { from: null, to: 496 },
    });
    // Credentials never reach the log.
    expect(JSON.stringify(events)).not.toContain('test:');
  });

  it('filters by person and by kind of action, and pages back in time', async () => {
    const { t, log } = await setup();
    for (const body of ['one', 'two', 'three']) await t.call('POST', `/threads/book/${PHM}`, { as: ALICE, body: { body } }).catch(() => null);
    // (No book stored yet: those fail and aren't logged.) Store one, then comment.
    await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } });
    for (const body of ['one', 'two', 'three']) await t.call('POST', `/threads/book/${PHM}`, { as: ALICE, body: { body } });
    await t.call('PUT', `/stacks/access/${encodeURIComponent(BOB)}`, { as: ADMIN, body: { role: 'ADMIN' } });

    expect((await log({ actor: idOf(BOB) })).events.map((e: { action: string }) => e.action)).toEqual(['nomination.create']);
    expect((await log({ action: 'comment' })).events).toHaveLength(3);
    expect((await log({ action: 'access.set' })).events[0]).toMatchObject({ label: BOB, details: { to: 'ADMIN' } });

    const page1 = await log({ limit: '2' });
    expect(page1.events).toHaveLength(2);
    const page2 = await log({ limit: '2', before: page1.nextBefore });
    expect(page2.events.map((e: { id: string }) => e.id)).not.toContain(page1.events[0].id);
    expect(page2.events).toHaveLength(2);
    // A nonsense limit falls back to the default page size rather than reading everything.
    expect((await log({ limit: 'abc' })).events.length).toBeGreaterThan(2);
    expect((await log({ limit: 'abc' })).events.length).toBeLessThanOrEqual(100);
  });

  it('names what each action touched, for the whole meeting cycle', async () => {
    const { t, log } = await setup();
    const meeting = (await t.call('POST', '/meetings', { as: ADMIN, body: { dateTime: '2026-02-01T19:00:00Z', title: 'Feb Klub' } })).body.meeting.id;
    await t.call('PATCH', `/meetings/${meeting}`, { as: ADMIN, body: { title: 'February Klub' } });
    const nomination = (await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } })).body.nomination.id;
    await t.call('POST', `/nominations/${nomination}/vote`, { as: ALICE });
    await t.call('DELETE', `/nominations/${nomination}/vote`, { as: ALICE });
    await t.call('POST', `/meetings/${meeting}/book`, { as: ADMIN, body: { nominationId: nomination } });
    await t.call('POST', `/threads/meeting/${meeting}`, { as: ALICE, body: { body: 'See you there' } });
    await t.call('DELETE', `/meetings/${meeting}/book`, { as: ADMIN });
    await t.call('POST', `/meetings/${meeting}/book`, { as: ADMIN, body: { isbn: PHM } });
    await t.call('POST', `/meetings/${meeting}/complete`, { as: ADMIN, body: { nextLeaderId: idOf(ALICE) } });

    const labels = Object.fromEntries(
      (await log()).events.map((e: { action: string; label?: string }) => [e.action, e.label]),
    );
    expect(labels).toEqual({
      'meeting.complete': 'February Klub',
      'meeting.pick_book': 'Project Hail Mary',
      'meeting.clear_book': 'February Klub',
      'comment.post': 'February Klub',
      'vote.remove': 'Project Hail Mary',
      'vote.add': 'Project Hail Mary',
      'nomination.create': 'Project Hail Mary',
      'meeting.edit': 'February Klub',
      'meeting.create': 'Feb Klub',
    });
  });

  it('is for admins only', async () => {
    const { t } = await setup();
    expect((await t.call('GET', '/admin/audit', { as: ALICE })).status).toBe(403);
  });
});
