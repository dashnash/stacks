import { forgetMembers } from '@stacks/api';
import { testUserId as idOf } from '@stacks/testing';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../helpers';

const ADMIN = 'admin@club.test';
const ALICE = 'alice@club.test';
const OLD = 'alice.old@club.test';
const PHM = '9780593135204';

describe('a member who merged an old account into this one', () => {
  it('keeps what the old account did: its nomination, vote and meeting are hers', async () => {
    const t = makeTestApp();
    await t.seedUser(ADMIN, 'ADMIN', 'Admin');
    await t.seedUser(ALICE, 'MEMBER', 'Alice');
    await t.seedUser(OLD, 'MEMBER', 'Alice');
    // Before the merge, the old account nominates, votes and is made leader.
    const nomination = (await t.call('POST', '/nominations', { as: OLD, body: { isbn: PHM } })).body.nomination.id;
    await t.call('POST', `/nominations/${nomination}/vote`, { as: OLD });
    const meeting = (await t.call('POST', '/meetings', { as: ADMIN, body: { dateTime: '2026-02-01T03:00:00Z', leaderId: idOf(OLD) } })).body.meeting.id;

    // The merge: the platform lists Alice once, with the old account's id as a former id.
    t.platform.members = t.platform.members.filter((m) => m.id !== idOf(OLD)).map((m) => (m.id === idOf(ALICE) ? { ...m, formerIds: [idOf(OLD)] } : m));
    forgetMembers(t.deps);

    const lineup = (await t.call('GET', '/nominations', { as: ALICE })).body.nominations;
    expect(lineup[0]).toMatchObject({ nominatedBy: { id: idOf(ALICE), name: 'Alice' }, canWithdraw: true, myVote: true, votes: 1 });
    // Voting again doesn't count twice; taking it back removes the old account's vote.
    await t.call('POST', `/nominations/${nomination}/vote`, { as: ALICE });
    expect((await t.call('GET', '/nominations', { as: ALICE })).body.nominations[0]).toMatchObject({ votes: 1, myVote: true });
    await t.call('DELETE', `/nominations/${nomination}/vote`, { as: ALICE });
    expect((await t.call('GET', '/nominations', { as: ALICE })).body.nominations[0]).toMatchObject({ votes: 0, myVote: false });

    const next = (await t.call('GET', '/meetings/next', { as: ALICE })).body.meeting;
    expect(next).toMatchObject({ id: meeting, canManage: true, leader: { id: idOf(ALICE), name: 'Alice' } });
    expect((await t.call('PATCH', `/meetings/${meeting}`, { as: ALICE, body: { title: 'Mine now' } })).status).toBe(200);
  });
});
