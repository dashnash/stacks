import { describe, expect, it } from 'vitest';
import { keys, meetingItem } from '../../../api/utils/model.js';
import { BOOKS, makeTestApp } from '../helpers';

const ADMIN = 'admin@club.test';
const ALICE = 'alice@club.test';
const BOB = 'bob@club.test';
const CAROL = 'carol@club.test';
const PHM = '9780593135204';
const DUNE = '9780441172719';
const HOBBIT = '9780547928227';

async function setup() {
  const t = makeTestApp();
  await t.seedUser(ADMIN, 'ADMIN', 'Admin');
  await t.seedUser(ALICE, 'MEMBER', 'Alice');
  await t.seedUser(BOB, 'MEMBER', 'Bob');
  await t.seedUser(CAROL, 'MEMBER', 'Carol');
  return t;
}

describe('sign-in and access (now from the platform)', () => {
  it('needs a session for member routes, but serves the public shelf', async () => {
    const t = await setup();
    expect((await t.call('GET', '/meetings/next')).status).toBe(401);
    expect((await t.call('GET', '/public/shelf')).status).toBe(200);
  });

  it('lists approved members for pickers from the platform', async () => {
    const t = await setup();
    const res = await t.call('GET', '/users', { as: ALICE });
    expect(res.body.users.map((u: { name: string; role: string }) => `${u.name}:${u.role}`)).toEqual(['Admin:ADMIN', 'Alice:MEMBER', 'Bob:MEMBER', 'Carol:MEMBER']);
  });

  it('lets admins (not members) use the access page, and changes go to the platform', async () => {
    const t = await setup();
    t.platform.pending = [{ email: 'newbie@club.test', name: 'Newbie', role: 'PENDING' }];
    expect((await t.call('GET', '/stacks/access', { as: ALICE })).status).toBe(403);
    const access = await t.call('GET', '/stacks/access', { as: ADMIN });
    expect(access.body.pending.map((p: { email: string }) => p.email)).toEqual(['newbie@club.test']);
    expect((await t.call('PUT', '/stacks/access/newbie%40club.test', { as: ADMIN, body: { role: 'MEMBER' } })).status).toBe(200);
    expect(t.platform.members.find((m) => m.email === 'newbie@club.test')?.role).toBe('MEMBER');
  });
});

describe('The Lineup', () => {
  it('takes nominations at any time, even with no meeting scheduled', async () => {
    const t = await setup();
    expect((await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } })).status).toBe(201);
    // ISBN-10 input is canonicalised; duplicates and unknown or invalid ISBNs are rejected.
    expect((await t.call('POST', '/nominations', { as: CAROL, body: { isbn: '0-441-17271-7' } })).status).toBe(201);
    expect((await t.call('POST', '/nominations', { as: ALICE, body: { isbn: PHM } })).status).toBe(409);
    expect((await t.call('POST', '/nominations', { as: ALICE, body: { isbn: '9780000000002' } })).status).toBe(404);
    expect((await t.call('POST', '/nominations', { as: ALICE, body: { isbn: 'nope' } })).status).toBe(400);
    expect(t.books.lookups.filter((i) => i === PHM)).toHaveLength(1);

    const lineup = await t.call('GET', '/nominations', { as: ALICE });
    expect(lineup.body.nominations.map((n: { book: { title: string } }) => n.book.title)).toEqual(['Project Hail Mary', 'Dune']);
    expect(lineup.body.nominations[0]).toMatchObject({ nominatedBy: { name: 'Bob' }, canWithdraw: false });
    expect(lineup.body).toMatchObject({ canPick: false, meetingId: null });
  });

  it('lets members withdraw their own nominations and admins remove anyone\'s', async () => {
    const t = await setup();
    const bobs = (await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } })).body.nomination.id;
    const carols = (await t.call('POST', '/nominations', { as: CAROL, body: { isbn: DUNE } })).body.nomination.id;

    expect((await t.call('GET', '/nominations', { as: BOB })).body.nominations.map((n: { canWithdraw: boolean }) => n.canWithdraw)).toEqual([true, false]);
    expect((await t.call('DELETE', `/nominations/${carols}`, { as: BOB })).status).toBe(403);
    expect((await t.call('DELETE', `/nominations/${bobs}`, { as: BOB })).status).toBe(200);
    // Admins can always modify The Lineup, even when they aren't leading anything.
    expect((await t.call('GET', '/nominations', { as: ADMIN })).body.nominations[0].canWithdraw).toBe(true);
    expect((await t.call('DELETE', `/nominations/${carols}`, { as: ADMIN })).status).toBe(200);
    expect((await t.call('GET', '/nominations', { as: BOB })).body.nominations).toEqual([]);
    expect((await t.call('DELETE', `/nominations/${carols}`, { as: ADMIN })).status).toBe(404);
  });

  it('moves nominations from the old per-meeting workflow onto The Lineup', async () => {
    const t = await setup();
    await t.store.put(
      meetingItem({
        id: 'old', title: 'Nov', dateTime: '2026-11-19T03:00:00.000Z', leaderEmail: ALICE,
        status: 'UPCOMING', phase: 'VOTING' as never, createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await t.store.put({ ...keys.book(PHM), ...BOOKS[PHM]! });
    await t.store.put({ PK: 'MEETING#old', SK: 'NOMINATION#n1', id: 'n1', meetingId: 'old', bookIsbn: PHM, nominatedByEmail: BOB, createdAt: '2026-01-02T00:00:00.000Z' });
    await t.store.put({ PK: 'MEETING#old', SK: 'VOTE#bob@club.test', meetingId: 'old', userEmail: BOB, rankedIsbns: [PHM] });

    const lineup = await t.call('GET', '/nominations', { as: ALICE });
    expect(lineup.body.nominations).toMatchObject([{ id: 'n1', book: { title: 'Project Hail Mary' } }]);
    expect(await t.store.query('MEETING#old', 'NOMINATION#')).toEqual([]);
    // A meeting caught mid-vote reads as "book not picked yet".
    expect((await t.call('GET', '/meetings/next', { as: ALICE })).body.meeting.phase).toBe('PLANNING');
  });
});

describe('voting on The Lineup', () => {
  it('counts one vote per member, sorts by votes, and lets members take a vote back', async () => {
    const t = await setup();
    const phm = (await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } })).body.nomination.id;
    const dune = (await t.call('POST', '/nominations', { as: CAROL, body: { isbn: DUNE } })).body.nomination.id;
    const order = async (as: string) =>
      (await t.call('GET', '/nominations', { as })).body.nominations.map((n: { book: { isbn: string }; votes: number; myVote: boolean }) => [n.book.isbn, n.votes, n.myVote]);

    expect(await order(ALICE)).toEqual([[PHM, 0, false], [DUNE, 0, false]]);
    await t.call('POST', `/nominations/${dune}/vote`, { as: ALICE });
    await t.call('POST', `/nominations/${dune}/vote`, { as: ALICE }); // voting twice is still one vote
    await t.call('POST', `/nominations/${dune}/vote`, { as: BOB });
    await t.call('POST', `/nominations/${phm}/vote`, { as: ALICE });
    // Most-voted first, and each member sees their own votes.
    expect(await order(ALICE)).toEqual([[DUNE, 2, true], [PHM, 1, true]]);
    expect(await order(CAROL)).toEqual([[DUNE, 2, false], [PHM, 1, false]]);

    await t.call('DELETE', `/nominations/${dune}/vote`, { as: ALICE });
    // Now tied at one vote each: ties keep nomination order.
    expect(await order(ALICE)).toEqual([[PHM, 1, true], [DUNE, 1, false]]);
    expect((await t.call('POST', '/nominations/nope/vote', { as: ALICE })).status).toBe(404);

    // Withdrawing a nomination clears its votes.
    await t.call('DELETE', `/nominations/${dune}`, { as: CAROL });
    expect(await t.store.query('LINEUP', `VOTE#${dune}#`)).toEqual([]);
  });
});

describe('discussion threads', () => {
  async function withBookAndMeeting() {
    const t = await setup();
    await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } });
    const meetingId = (await t.call('POST', '/meetings', { as: ADMIN, body: { dateTime: '2026-02-01T03:00:00Z', leaderEmail: ALICE } })).body.meeting.id;
    return { t, meetingId };
  }

  it('threads comments and replies on a book, and counts them on the Lineup', async () => {
    const { t } = await withBookAndMeeting();
    const top = await t.call('POST', `/threads/book/${PHM}`, { as: ALICE, body: { body: '  Loved the science bits.  ' } });
    expect(top.status).toBe(201);
    expect(top.body.comment).toMatchObject({ body: 'Loved the science bits.', parentId: null, author: { name: 'Alice' }, canEdit: true });
    const reply = await t.call('POST', `/threads/book/${PHM}`, { as: BOB, body: { body: 'Rocky!', parentId: top.body.comment.id } });
    expect(reply.body.comment.parentId).toBe(top.body.comment.id);

    const thread = await t.call('GET', `/threads/book/${PHM}`, { as: CAROL });
    expect(thread.body.comments.map((c: { body: string; canEdit: boolean; canDelete: boolean }) => [c.body, c.canEdit, c.canDelete])).toEqual([
      ['Loved the science bits.', false, false],
      ['Rocky!', false, false],
    ]);
    // The book's ISBN-10 reaches the same thread.
    expect((await t.call('GET', '/threads/book/0593135202', { as: CAROL })).body.comments).toHaveLength(2);
    expect((await t.call('GET', '/nominations', { as: CAROL })).body.nominations[0].commentCount).toBe(2);
  });

  it('keeps a meeting thread, counted on the meeting', async () => {
    const { t, meetingId } = await withBookAndMeeting();
    await t.call('POST', `/threads/meeting/${meetingId}`, { as: CAROL, body: { body: 'Running 5 min late' } });
    const next = await t.call('GET', '/meetings/next', { as: ALICE });
    expect(next.body.meeting).toMatchObject({ commentCount: 1, bookCommentCount: 0 });
    expect((await t.call('GET', `/threads/meeting/${meetingId}`, { as: ALICE })).body.comments[0].body).toBe('Running 5 min late');
  });

  it('keeps a stored count per thread, and counts older threads that have none the first time', async () => {
    const { t } = await withBookAndMeeting();
    await t.call('POST', `/threads/book/${PHM}`, { as: ALICE, body: { body: 'One' } });
    await t.call('POST', `/threads/book/${PHM}`, { as: BOB, body: { body: 'Two' } });
    const countKey = `THREAD#BOOK#${PHM}`;
    const countItem = () => [...t.store.items.values()].find((i) => i.PK === countKey && i.SK === 'COUNT');
    expect(countItem()).toMatchObject({ count: 2 });

    // A thread from before counts were stored: counted (and stored) when it's first shown.
    t.store.items.delete([...t.store.items.keys()].find((k) => k.includes(countKey) && k.includes('COUNT'))!);
    expect(countItem()).toBeUndefined();
    expect((await t.call('GET', '/nominations', { as: CAROL })).body.nominations[0].commentCount).toBe(2);
    expect(countItem()).toMatchObject({ count: 2 });
  });

  it('validates the target, the text and the parent', async () => {
    const { t } = await withBookAndMeeting();
    expect((await t.call('GET', '/threads/book/9780000000002', { as: ALICE })).status).toBe(404);
    expect((await t.call('GET', '/threads/meeting/nope', { as: ALICE })).status).toBe(404);
    expect((await t.call('GET', '/threads/user/x', { as: ALICE })).status).toBe(404);
    expect((await t.call('POST', `/threads/book/${PHM}`, { as: ALICE, body: { body: '   ' } })).status).toBe(400);
    expect((await t.call('POST', `/threads/book/${PHM}`, { as: ALICE, body: { body: 'x'.repeat(2001) } })).status).toBe(400);
    expect((await t.call('POST', `/threads/book/${PHM}`, { as: ALICE, body: { body: 'hi', parentId: 'ghost' } })).status).toBe(404);
    expect((await t.call('GET', `/threads/book/${PHM}`)).status).toBe(401);
  });

  it('lets authors edit and delete their own comments, admins delete any, and keeps replies in place', async () => {
    const { t } = await withBookAndMeeting();
    const top = (await t.call('POST', `/threads/book/${PHM}`, { as: ALICE, body: { body: 'First' } })).body.comment.id;
    const reply = (await t.call('POST', `/threads/book/${PHM}`, { as: BOB, body: { body: 'Reply', parentId: top } })).body.comment.id;
    const path = (id: string) => `/threads/book/${PHM}/comments/${id}`;

    expect((await t.call('PATCH', path(top), { as: BOB, body: { body: 'hijack' } })).status).toBe(403);
    const edited = await t.call('PATCH', path(top), { as: ALICE, body: { body: 'First (edited)' } });
    expect(edited.body.comment).toMatchObject({ body: 'First (edited)' });
    expect(edited.body.comment.editedAt).toBeTruthy();

    expect((await t.call('DELETE', path(top), { as: CAROL })).status).toBe(403);
    // Has a reply: blanked, not removed.
    expect((await t.call('DELETE', path(top), { as: ALICE })).status).toBe(200);
    let thread = (await t.call('GET', `/threads/book/${PHM}`, { as: CAROL })).body.comments;
    expect(thread[0]).toMatchObject({ id: top, deleted: true, body: '', author: null, canEdit: false });
    expect(thread[1]).toMatchObject({ id: reply, parentId: top, body: 'Reply' });
    expect((await t.call('POST', `/threads/book/${PHM}`, { as: CAROL, body: { body: 'x', parentId: top } })).status).toBe(400);

    // An admin removes the reply (no replies of its own: removed outright).
    expect((await t.call('DELETE', path(reply), { as: ADMIN })).status).toBe(200);
    thread = (await t.call('GET', `/threads/book/${PHM}`, { as: CAROL })).body.comments;
    expect(thread.map((c: { id: string }) => c.id)).toEqual([top]);
    // Deleted comments don't count.
    expect((await t.call('GET', '/nominations', { as: CAROL })).body.nominations[0].commentCount).toBe(0);
  });
});

describe('meeting lifecycle', () => {
  it('lets the leader pick from The Lineup, then hands off to the next leader', async () => {
    const t = await setup();

    // Nobody has been handed off to yet, so only the admin can bootstrap the first meeting.
    const empty = await t.call('GET', '/meetings/next', { as: ALICE });
    expect(empty.body).toEqual({ meeting: null, nextLeader: null, canCreateNext: false });
    expect((await t.call('POST', '/meetings', { as: ALICE, body: { dateTime: '2026-02-01T03:00:00Z' } })).status).toBe(403);

    const created = await t.call('POST', '/meetings', {
      as: ADMIN,
      body: { title: 'February', dateTime: '2026-02-01T03:00:00Z', videoUrl: 'https://meet.google.com/abc', leaderEmail: ALICE },
    });
    expect(created.status).toBe(201);
    const id = created.body.meeting.id;
    // The admin who created it can manage it too.
    expect(created.body.meeting).toMatchObject({ leaderEmail: ALICE, phase: 'PLANNING', status: 'UPCOMING', canManage: true });
    // Only one upcoming meeting at a time.
    expect((await t.call('POST', '/meetings', { as: ADMIN, body: { dateTime: '2026-03-01T03:00:00Z' } })).status).toBe(409);

    const phm = (await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } })).body.nomination.id;
    await t.call('POST', '/nominations', { as: CAROL, body: { isbn: DUNE } });

    // The leader (and admins) can pick; other members can't.
    expect((await t.call('GET', '/nominations', { as: ALICE })).body).toMatchObject({ canPick: true, meetingId: id });
    expect((await t.call('GET', '/nominations', { as: CAROL })).body.canPick).toBe(false);
    expect((await t.call('POST', `/meetings/${id}/book`, { as: CAROL, body: { nominationId: phm } })).status).toBe(403);
    expect((await t.call('POST', `/meetings/${id}/book`, { as: ALICE, body: {} })).status).toBe(400);

    // Can't wrap up before a book is picked.
    expect((await t.call('POST', `/meetings/${id}/complete`, { as: ALICE, body: { nextLeaderEmail: BOB } })).status).toBe(409);

    const picked = await t.call('POST', `/meetings/${id}/book`, { as: ALICE, body: { nominationId: phm } });
    expect(picked.status).toBe(200);
    expect(picked.body.meeting).toMatchObject({ phase: 'SELECTED', bookIsbn: PHM, book: { title: 'Project Hail Mary' }, nominatedBy: { name: 'Bob' } });
    // Picked from The Lineup, so it comes off it, and can't be nominated again while it's the pick.
    expect((await t.call('GET', '/nominations', { as: ALICE })).body.nominations.map((n: { book: { isbn: string } }) => n.book.isbn)).toEqual([DUNE]);
    expect((await t.call('POST', '/nominations', { as: CAROL, body: { isbn: PHM } })).status).toBe(409);

    const next = await t.call('GET', '/meetings/next', { as: CAROL });
    expect(next.body.meeting).toMatchObject({ book: { title: 'Project Hail Mary' }, canManage: false });
    expect(next.body.meeting.chosenNomination).toBeUndefined();

    // Completing requires naming an approved next leader.
    expect((await t.call('POST', `/meetings/${id}/complete`, { as: ALICE, body: {} })).status).toBe(400);
    expect(
      (await t.call('POST', `/meetings/${id}/complete`, { as: ALICE, body: { nextLeaderEmail: 'ghost@x.test' } })).status,
    ).toBe(400);
    const done = await t.call('POST', `/meetings/${id}/complete`, { as: ALICE, body: { nextLeaderEmail: BOB } });
    expect(done.body.meeting).toMatchObject({ status: 'PAST', phase: 'PAST', nextLeaderEmail: BOB });

    const history = await t.call('GET', '/meetings/history', { as: CAROL });
    expect(history.body.meetings).toHaveLength(1);
    expect(history.body.meetings[0]).toMatchObject({ id, book: { title: 'Project Hail Mary' }, leader: { name: 'Alice' } });

    // The handoff: Bob (and only Bob, or an admin) can create the next meeting.
    const handoff = await t.call('GET', '/meetings/next', { as: BOB });
    expect(handoff.body).toEqual({ meeting: null, nextLeader: { email: BOB, name: 'Bob' }, canCreateNext: true });
    expect((await t.call('POST', '/meetings', { as: CAROL, body: { dateTime: '2026-03-01T03:00:00Z' } })).status).toBe(403);
    expect(
      (await t.call('POST', '/meetings', { as: BOB, body: { dateTime: '2026-03-01T03:00:00Z', leaderEmail: CAROL } })).status,
    ).toBe(403);
    const second = await t.call('POST', '/meetings', { as: BOB, body: { dateTime: '2026-03-01T03:00:00Z' } });
    expect(second.status).toBe(201);
    expect(second.body.meeting.leaderEmail).toBe(BOB);
    // The Lineup carries over: Dune is still waiting for its turn.
    expect((await t.call('GET', '/nominations', { as: BOB })).body).toMatchObject({ canPick: true, nominations: [{ book: { isbn: DUNE } }] });
  });

  it('puts a picked Lineup book back when the leader changes or clears the pick', async () => {
    const t = await setup();
    const { body } = await t.call('POST', '/meetings', { as: ADMIN, body: { dateTime: '2026-02-01T03:00:00Z', leaderEmail: ALICE } });
    const id = body.meeting.id;
    const phm = (await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } })).body.nomination.id;
    await t.call('POST', '/nominations', { as: CAROL, body: { isbn: DUNE } });
    const lineupIsbns = async () =>
      (await t.call('GET', '/nominations', { as: ALICE })).body.nominations.map((n: { book: { isbn: string } }) => n.book.isbn).sort();

    await t.call('POST', `/meetings/${id}/book`, { as: ALICE, body: { nominationId: phm } });
    expect(await lineupIsbns()).toEqual([DUNE]);

    // Picking by ISBN a book that is on The Lineup takes it off too; Hail Mary goes back.
    const switched = await t.call('POST', `/meetings/${id}/book`, { as: ALICE, body: { isbn: DUNE } });
    expect(switched.body.meeting).toMatchObject({ bookIsbn: DUNE, nominatedBy: { name: 'Carol' } });
    expect(await lineupIsbns()).toEqual([PHM]);

    // A book that was never nominated can be picked directly.
    const offList = await t.call('POST', `/meetings/${id}/book`, { as: ALICE, body: { isbn: HOBBIT } });
    expect(offList.body.meeting).toMatchObject({ bookIsbn: HOBBIT });
    expect(offList.body.meeting.nominatedBy).toBeUndefined();
    expect(await lineupIsbns()).toEqual([DUNE, PHM].sort());

    const cleared = await t.call('DELETE', `/meetings/${id}/book`, { as: ALICE });
    expect(cleared.body.meeting).toMatchObject({ phase: 'PLANNING' });
    expect(cleared.body.meeting.bookIsbn).toBeUndefined();
    expect(await lineupIsbns()).toEqual([DUNE, PHM].sort());
  });

  it('lets admins run the current meeting even when they are not leading it', async () => {
    const t = await setup();
    const { body } = await t.call('POST', '/meetings', { as: ADMIN, body: { dateTime: '2026-02-01T03:00:00Z', leaderEmail: ALICE } });
    const id = body.meeting.id;
    const phm = (await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } })).body.nomination.id;

    expect((await t.call('GET', '/meetings/next', { as: ADMIN })).body.meeting.canManage).toBe(true);
    expect((await t.call('POST', `/meetings/${id}/book`, { as: ADMIN, body: { nominationId: phm } })).status).toBe(200);
    expect((await t.call('PATCH', `/meetings/${id}`, { as: ADMIN, body: { title: 'Admin edit' } })).body.meeting.title).toBe('Admin edit');
    expect((await t.call('POST', `/meetings/${id}/complete`, { as: ADMIN, body: { nextLeaderEmail: CAROL } })).status).toBe(200);
    // Past meetings can't be changed.
    expect((await t.call('POST', `/meetings/${id}/book`, { as: ADMIN, body: { isbn: DUNE } })).status).toBe(409);
  });

  it('lets the leader edit details and only admins reassign the leader', async () => {
    const t = await setup();
    const { body } = await t.call('POST', '/meetings', {
      as: ADMIN,
      body: { dateTime: '2026-02-01T03:00:00Z', leaderEmail: ALICE },
    });
    const id = body.meeting.id;

    const edited = await t.call('PATCH', `/meetings/${id}`, {
      as: ALICE,
      body: { title: 'Moved', dateTime: '2026-02-02T03:00:00Z', videoUrl: 'https://meet.google.com/xyz' },
    });
    expect(edited.body.meeting).toMatchObject({ title: 'Moved', dateTime: '2026-02-02T03:00:00.000Z' });
    expect((await t.call('PATCH', `/meetings/${id}`, { as: ALICE, body: { videoUrl: 'javascript:alert(1)' } })).status).toBe(400);
    expect((await t.call('PATCH', `/meetings/${id}`, { as: BOB, body: { title: 'Hijack' } })).status).toBe(403);
    expect((await t.call('PATCH', `/meetings/${id}`, { as: ALICE, body: { leaderEmail: BOB } })).status).toBe(403);
    const reassigned = await t.call('PATCH', `/meetings/${id}`, { as: ADMIN, body: { leaderEmail: BOB } });
    expect(reassigned.body.meeting.leaderEmail).toBe(BOB);
  });
});

describe('books & easter eggs', () => {
  it('searches books by title', async () => {
    const t = await setup();
    const res = await t.call('GET', '/books/search', { as: ALICE, query: { q: 'dune' } });
    expect(res.body.results.map((b: { isbn: string }) => b.isbn)).toEqual([DUNE]);
    expect((await t.call('GET', '/books/search', { as: ALICE, query: { q: 'd' } })).status).toBe(400);
  });

  it('returns a random easter egg with a presigned image URL', async () => {
    const t = await setup();
    expect((await t.call('GET', '/easter-egg/random', { as: ALICE })).status).toBe(404);

    await t.store.put({ ...keys.easterEgg('1'), id: '1', quote: 'Q1', characterName: 'Gary', imageKey: 'eggs/gary.jpg' });
    await t.store.put({ ...keys.easterEgg('2'), id: '2', quote: 'Q2', characterName: 'Pam' });

    // Older rows still carry a critic's name; quotes are served unsigned.
    const first = await t.call('GET', '/easter-egg/random', { as: ALICE });
    expect(first.body).toEqual({ id: '1', quote: 'Q1', imageUrl: 'https://signed.example/eggs/gary.jpg' });

    const shuffled = await t.call('GET', '/easter-egg/random', { as: ALICE, query: { exclude: '1' } });
    expect(shuffled.body).toEqual({ id: '2', quote: 'Q2', imageUrl: null });
  });
});

describe('high-resolution covers for the poster', () => {
  it("upgrades a selected book's small stored cover once, and keeps the better one", async () => {
    const t = await setup();
    // Stored before covers were measured: small and never re-checked.
    await t.store.put({ ...keys.book(PHM), isbn: PHM, title: 'Project Hail Mary', author: 'Andy Weir', coverUrl: 'https://small.example/phm.jpg', coverWidth: 180 });
    await t.store.put(
      meetingItem({
        id: 'm-sel', title: 'Nov', dateTime: '2026-11-19T03:00:00.000Z', leaderEmail: ALICE,
        bookIsbn: PHM, status: 'UPCOMING', phase: 'SELECTED', createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    t.books.lookups.length = 0;

    const first = await t.call('GET', '/meetings/next', { as: BOB });
    expect(first.body.meeting.book).toMatchObject({ coverUrl: 'https://covers.example/phm-large.jpg', coverWidth: 1200 });

    // Already sharp: no more lookups on later visits.
    await t.call('GET', '/meetings/next', { as: BOB });
    expect(t.books.lookups).toEqual([PHM]);
  });

  it("doesn't replace a cover with a smaller one, and doesn't retry for a day", async () => {
    const t = await setup();
    await t.store.put({ ...keys.book(DUNE), isbn: DUNE, title: 'Dune', author: 'Frank Herbert', coverUrl: 'https://mine.example/dune.jpg', coverWidth: 500 });
    await t.store.put(
      meetingItem({
        id: 'm-dune', title: 'Nov', dateTime: '2026-11-19T03:00:00.000Z', leaderEmail: ALICE,
        bookIsbn: DUNE, status: 'UPCOMING', phase: 'SELECTED', createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    t.books.lookups.length = 0;
    expect((await t.call('GET', '/meetings/next', { as: BOB })).body.meeting.book.coverUrl).toBe('https://mine.example/dune.jpg');
    await t.call('GET', '/meetings/next', { as: BOB });
    expect(t.books.lookups).toEqual([DUNE]);
  });
});

describe('cover backfill', () => {
  it('fills in covers for Lineup and shelf books saved without one, at most once a day', async () => {
    const t = await setup();
    // Saved before cover lookups improved: no cover, never re-checked.
    await t.store.put({ ...keys.book(PHM), isbn: PHM, title: 'Project Hail Mary', author: 'Andy Weir' });
    await t.store.put({ ...keys.nomination('n1'), id: 'n1', bookIsbn: PHM, nominatedByEmail: BOB, createdAt: '2026-01-01T00:00:00.000Z' });
    await t.store.put({ ...keys.book(DUNE), isbn: DUNE, title: 'Dune', author: 'Frank Herbert' });
    await t.store.put(
      meetingItem({
        id: 'past', title: 'Jan', dateTime: '2026-01-10T03:00:00.000Z', leaderEmail: ALICE,
        bookIsbn: DUNE, status: 'PAST', phase: 'PAST', createdAt: '2025-12-01T00:00:00.000Z',
      }),
    );
    t.books.lookups.length = 0;

    const lineup = await t.call('GET', '/nominations', { as: BOB });
    expect(lineup.body.nominations[0].book).toMatchObject({ coverUrl: 'https://covers.example/phm-large.jpg' });
    const history = await t.call('GET', '/meetings/history', { as: BOB });
    expect(history.body.meetings[0].book).toMatchObject({ coverUrl: 'https://covers.example/dune-small.jpg', coverWidth: 300 });

    // Dune's cover is still small, but it was just checked: no repeat lookups today.
    await t.call('GET', '/nominations', { as: BOB });
    await t.call('GET', '/meetings/history', { as: BOB });
    expect(t.books.lookups.sort()).toEqual([DUNE, PHM].sort());
  });
});

describe('bundled critic quotes', () => {
  it('serves quotes shipped with the deploy, with their photos, and lets table entries override them', async () => {
    const t = makeTestApp({
      bundledEasterEggs: [
        { id: 'gatsby', quote: 'Bundled quote.', imageKey: 'eggs/lady-p.jpg' },
        { id: 'hobbit', quote: 'Old wording.' },
      ],
    });
    await t.seedUser(ALICE, 'MEMBER');
    expect((await t.call('GET', '/easter-egg/random', { as: ALICE })).body).toEqual({
      id: 'gatsby',
      quote: 'Bundled quote.',
      imageUrl: 'https://signed.example/eggs/lady-p.jpg',
    });

    await t.store.put({ ...keys.easterEgg('hobbit'), id: 'hobbit', quote: 'New wording.' });
    const hobbit = await t.call('GET', '/easter-egg/random', { as: ALICE, query: { exclude: 'gatsby' } });
    expect(hobbit.body.quote).toBe('New wording.');
  });
});

describe('shared face photos', () => {
  it("gives a quote without its own photo a random face, but keeps a quote's own photo", async () => {
    const faces = ['eggs/faces/kyle-001.jpg', 'eggs/faces/kyle-002.jpg', 'eggs/faces/kyle-003.jpg'];
    const draws = [0, 0.7, 0.9, 0.1];
    const t = makeTestApp({
      faces,
      random: () => draws.shift() ?? 0,
      bundledEasterEggs: [
        { id: 'a', quote: 'No photo of its own.' },
        { id: 'b', quote: 'Has a photo.', imageKey: 'eggs/b.jpg' },
      ],
    });
    await t.seedUser(ALICE, 'MEMBER');
    // First draw picks quote "a", second picks face index floor(0.7 * 3) = 2.
    expect((await t.call('GET', '/easter-egg/random', { as: ALICE })).body.imageUrl).toBe('https://signed.example/eggs/faces/kyle-003.jpg');
    // Quote "b" keeps its own photo regardless of the faces.
    expect((await t.call('GET', '/easter-egg/random', { as: ALICE, query: { exclude: 'a' } })).body.imageUrl).toBe(
      'https://signed.example/eggs/b.jpg',
    );
  });

  it('falls back to no photo when there are no faces', async () => {
    const t = makeTestApp({ faces: [], bundledEasterEggs: [{ id: 'a', quote: 'q' }] });
    await t.seedUser(ALICE, 'MEMBER');
    expect((await t.call('GET', '/easter-egg/random', { as: ALICE })).body.imageUrl).toBeNull();
  });
});

describe('routing', () => {
  it('returns 404 for unknown routes and 405 for wrong methods', async () => {
    const t = await setup();
    expect((await t.call('GET', '/nope', { as: ALICE })).status).toBe(404);
    expect((await t.call('PUT', '/nominations', { as: ALICE })).status).toBe(405);
  });

  it('rejects malformed URL escapes with 400, not a server error', async () => {
    const t = await setup();
    expect((await t.call('GET', '/books/%E0%A4%A/details', { as: ALICE })).status).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    const t = await setup();
    const res = (await t.app({
      rawPath: '/api/nominations',
      requestContext: { http: { method: 'POST' } },
      headers: { authorization: 'Bearer test:alice@club.test' },
      body: '{nope',
    } as never)) as { statusCode: number };
    expect(res.statusCode).toBe(400);
  });
});
