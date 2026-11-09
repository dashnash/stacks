import { testUserId as idOf } from '@stacks/testing';
import { describe, expect, it } from 'vitest';
import { ensureMetadata, withinBudget } from '../../../api/books/repo.js';
import { keys } from '../../../api/utils/model.js';
import { makeTestApp } from '../helpers';

const ADMIN = 'admin@club.test';
const ALICE = 'alice@club.test';
const BOB = 'bob@club.test';
const PHM = '9780593135204';
const DUNE = '9780441172719';

async function setup() {
  const t = makeTestApp();
  await t.seedUser(ADMIN, 'ADMIN', 'Admin');
  await t.seedUser(ALICE, 'MEMBER', 'Alice');
  await t.seedUser(BOB, 'MEMBER', 'Bob');
  return t;
}

describe('book details', () => {
  it('shows the book with its Lineup votes, meetings, comment count and Amazon link', async () => {
    const t = await setup();
    const nomination = (await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } })).body.nomination.id;
    await t.call('POST', `/nominations/${nomination}/vote`, { as: ALICE });
    await t.call('POST', `/threads/book/${PHM}`, { as: ALICE, body: { body: 'So good' } });

    const res = await t.call('GET', `/books/${PHM}/details`, { as: ALICE });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      book: {
        isbn: PHM,
        title: 'Project Hail Mary',
        amazonUrl: 'https://www.amazon.com/dp/0593135202',
        amazonUrlIsCustom: false,
      },
      nomination: { id: nomination, votes: 1, myVote: true, canWithdraw: false, nominatedBy: { name: 'Bob' } },
      meetings: [],
      commentCount: 1,
      canEdit: false,
    });
    expect((await t.call('GET', `/books/${PHM}/details`, { as: ADMIN })).body.canEdit).toBe(true);

    // Once it is picked for a meeting it is off The Lineup and the meeting is listed.
    const meetingId = (
      await t.call('POST', '/meetings', { as: ADMIN, body: { dateTime: '2026-02-01T03:00:00Z', leaderId: idOf(ALICE) } })
    ).body.meeting.id;
    await t.call('POST', `/meetings/${meetingId}/book`, { as: ALICE, body: { nominationId: nomination } });
    const picked = (await t.call('GET', `/books/${PHM}/details`, { as: ALICE })).body;
    expect(picked.nomination).toBeNull();
    expect(picked.meetings).toEqual([
      expect.objectContaining({
        id: meetingId,
        status: 'UPCOMING',
        leader: expect.objectContaining({ name: 'Alice' }),
      }),
    ]);
  });

  it('accepts an ISBN-10 and 404s for books the Klub has never seen', async () => {
    const t = await setup();
    await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } });
    expect((await t.call('GET', '/books/0593135202/details', { as: ALICE })).body.book.isbn).toBe(PHM);
    expect((await t.call('GET', `/books/${DUNE}/details`, { as: ALICE })).status).toBe(404);
    expect((await t.call('GET', '/books/nope/details', { as: ALICE })).status).toBe(404);
  });

  it('fills in missing details once for books saved before the details page, without overwriting', async () => {
    const t = await setup();
    await t.store.put({
      ...keys.book(PHM),
      isbn: PHM,
      title: 'Hand-fixed title',
      author: 'Andy Weir',
      description: 'Ours',
    });
    t.books.lookupIsbn = async () => ({
      isbn: PHM,
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      description: 'Theirs',
      publisher: 'Ballantine',
      pageCount: 496,
      subjects: ['Science fiction'],
    });
    const { book } = (await t.call('GET', `/books/${PHM}/details`, { as: ALICE })).body;
    expect(book).toMatchObject({
      title: 'Hand-fixed title',
      description: 'Ours',
      publisher: 'Ballantine',
      pageCount: 496,
      subjects: ['Science fiction'],
    });

    let lookups = 0;
    t.books.lookupIsbn = async () => {
      lookups++;
      return null;
    };
    await t.call('GET', `/books/${PHM}/details`, { as: ALICE });
    expect(lookups).toBe(0);
  });
});

describe('admins editing a book', () => {
  async function withBook() {
    const t = await setup();
    await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } });
    return t;
  }

  it('updates details, clears optional fields, and records who edited', async () => {
    const t = await withBook();
    const res = await t.call('PATCH', `/books/${PHM}`, {
      as: ADMIN,
      body: {
        title: ' Project Hail Mary (Signed) ',
        publisher: 'Ballantine',
        pageCount: 496,
        subjects: ['Sci-fi', 'Sci-fi', ' Space '],
        description: '',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.book).toMatchObject({
      title: 'Project Hail Mary (Signed)',
      publisher: 'Ballantine',
      pageCount: 496,
      subjects: ['Sci-fi', 'Space'],
      editedBy: idOf(ADMIN),
    });
    expect(res.body.book.description).toBeUndefined();
    // Untouched fields stay.
    expect(res.body.book.author).toBe('Andy Weir');

    const bad = async (body: unknown) => (await t.call('PATCH', `/books/${PHM}`, { as: ADMIN, body })).status;
    expect(await bad({ title: '' })).toBe(400);
    expect(await bad({ pageCount: -3 })).toBe(400);
    expect(await bad({ pageCount: '300' })).toBe(400);
    expect(await bad({ title: 'x'.repeat(301) })).toBe(400);
  });

  it('lets the nominator edit their own book, and nobody else but admins', async () => {
    const t = await withBook(); // Bob nominated Project Hail Mary
    const edit = async (as: string, isbn = PHM) =>
      (await t.call('PATCH', `/books/${isbn}`, { as, body: { publisher: `By ${as}` } })).status;

    expect(await edit(BOB)).toBe(200);
    expect((await t.call('GET', `/books/${PHM}/lookup`, { as: BOB })).status).toBe(200);
    expect((await t.call('GET', `/books/${PHM}/details`, { as: BOB })).body.canEdit).toBe(true);

    expect(await edit(ALICE)).toBe(403);
    expect((await t.call('GET', `/books/${PHM}/lookup`, { as: ALICE })).status).toBe(403);
    expect((await t.call('GET', `/books/${PHM}/details`, { as: ALICE })).body.canEdit).toBe(false);

    // Alice can edit the book she nominated, but still not Bob's.
    await t.call('POST', '/nominations', { as: ALICE, body: { isbn: DUNE } });
    expect(await edit(ALICE, DUNE)).toBe(200);
    expect(await edit(BOB, DUNE)).toBe(403);
  });

  it("keeps the nominator's edit rights after their book is picked, and drops them if it's withdrawn", async () => {
    const t = await withBook();
    const nominationId = (await t.call('GET', '/nominations', { as: BOB })).body.nominations[0].id;
    const meetingId = (
      await t.call('POST', '/meetings', { as: ADMIN, body: { dateTime: '2026-02-01T03:00:00Z', leaderId: idOf(ALICE) } })
    ).body.meeting.id;
    await t.call('POST', `/meetings/${meetingId}/book`, { as: ALICE, body: { nominationId } });
    expect((await t.call('PATCH', `/books/${PHM}`, { as: BOB, body: { pageCount: 500 } })).status).toBe(200);
    // The leader who picked it didn't nominate it.
    expect((await t.call('PATCH', `/books/${PHM}`, { as: ALICE, body: { pageCount: 1 } })).status).toBe(403);

    const t2 = await withBook();
    const id2 = (await t2.call('GET', '/nominations', { as: BOB })).body.nominations[0].id;
    await t2.call('DELETE', `/nominations/${id2}`, { as: BOB });
    expect((await t2.call('PATCH', `/books/${PHM}`, { as: BOB, body: { pageCount: 500 } })).status).toBe(403);
  });

  it('pins a chosen cover so automatic lookups keep it, and can switch to no image', async () => {
    const t = await setup();
    await t.call('POST', '/nominations', { as: BOB, body: { isbn: DUNE } }); // Dune's stored cover is small
    const looked = (await t.call('GET', `/books/${DUNE}/lookup`, { as: ADMIN })).body;
    expect(looked.covers[0]).toEqual({
      url: `https://covers.example/${DUNE}-alt.jpg`,
      width: 1400,
      source: 'Open Library',
    });
    expect(looked.found.title).toBe('Dune');

    const chosen = 'https://images.example/dune-fixed.jpg';
    const res = await t.call('PATCH', `/books/${DUNE}`, { as: ADMIN, body: { coverUrl: chosen, coverWidth: 200 } });
    expect(res.body.book).toMatchObject({ coverUrl: chosen, coverWidth: 200, coverPinned: true });

    // A small pinned cover is not replaced by the daily cover check.
    const lookupsBefore = t.books.lookups.length;
    await t.call('GET', '/nominations', { as: ALICE });
    expect(t.books.lookups.length).toBe(lookupsBefore);

    const none = await t.call('PATCH', `/books/${DUNE}`, { as: ADMIN, body: { coverUrl: null } });
    expect(none.body.book.coverUrl).toBeUndefined();
    expect(
      (await t.call('PATCH', `/books/${DUNE}`, { as: ADMIN, body: { coverUrl: 'http://insecure.example/x.jpg' } }))
        .status,
    ).toBe(400);
    expect(
      (await t.call('PATCH', `/books/${DUNE}`, { as: ADMIN, body: { coverUrl: 'javascript:alert(1)' } })).status,
    ).toBe(400);
  });

  it('searches editions by free text when given search terms', async () => {
    const t = await withBook(); // Bob nominated Project Hail Mary
    const res = await t.call('GET', `/books/${PHM}/lookup`, { as: BOB, query: { q: '  dune herbert ' } });
    expect(res.status).toBe(200);
    expect(t.books.searches).toEqual(['dune herbert']);
    expect(res.body.found).toBeNull();
    expect(res.body.editions).toEqual([
      expect.objectContaining({ title: 'Dune', author: 'Frank Herbert', publisher: 'Fake Press', source: 'Open Library' }),
    ]);
    // Same permission as the ISBN lookup.
    expect((await t.call('GET', `/books/${PHM}/lookup`, { as: ALICE, query: { q: 'dune' } })).status).toBe(403);
    expect((await t.call('GET', `/books/${PHM}/lookup`, { as: BOB, query: { q: 'x'.repeat(201) } })).status).toBe(400);
  });

  it('sets a custom Amazon link, only on Amazon sites, and can go back to the default', async () => {
    const t = await withBook();
    const set = async (amazonUrl: unknown) => t.call('PATCH', `/books/${PHM}`, { as: ADMIN, body: { amazonUrl } });

    const custom = await set('https://www.amazon.com/Project-Hail-Mary-Novel/dp/0593135202?tag=x');
    expect(custom.body.book).toMatchObject({
      amazonUrl: 'https://www.amazon.com/Project-Hail-Mary-Novel/dp/0593135202?tag=x',
      amazonUrlIsCustom: true,
    });
    expect((await set('https://a.co/d/abc123')).status).toBe(200);
    expect((await set('https://www.amazon.co.uk/dp/0593135202')).status).toBe(200);

    expect((await set('https://amazon.com.evil.example/dp/1')).status).toBe(400);
    expect((await set('http://www.amazon.com/dp/0593135202')).status).toBe(400);
    expect((await set('https://notamazon.com/dp/1')).status).toBe(400);

    const reset = await set(null);
    expect(reset.body.book).toMatchObject({
      amazonUrl: 'https://www.amazon.com/dp/0593135202',
      amazonUrlIsCustom: false,
    });
  });
});

describe('the public shelf', () => {
  async function withCompletedMeeting() {
    const t = await setup();
    const nomination = (await t.call('POST', '/nominations', { as: BOB, body: { isbn: PHM } })).body.nomination.id;
    const meetingId = (await t.call('POST', '/meetings', { as: ADMIN, body: { dateTime: '2026-02-01T03:00:00Z', leaderId: idOf(ALICE) } }))
      .body.meeting.id;
    await t.call('POST', `/meetings/${meetingId}/book`, { as: ALICE, body: { nominationId: nomination } });
    return { t, meetingId };
  }

  it('shows the current headliner, then past books, to anyone, with book details only', async () => {
    const { t, meetingId } = await withCompletedMeeting();
    await t.call('PATCH', `/books/${PHM}`, { as: ADMIN, body: { publisher: 'Ballantine', pageCount: 496 } });

    // Picked for the upcoming meeting: it's the headliner, not yet on the shelf.
    const before = (await t.call('GET', '/public/shelf')).body;
    expect(before).toEqual({
      current: {
        meetsOn: '2026-02-01T03:00:00.000Z',
        book: { isbn: PHM, title: 'Project Hail Mary', author: 'Andy Weir', coverUrl: 'https://covers.example/phm-large.jpg', publisher: 'Ballantine', pageCount: 496 },
      },
      books: [],
    });

    await t.call('POST', `/meetings/${meetingId}/complete`, { as: ALICE, body: { nextLeaderId: idOf(BOB) } });
    await t.call('POST', `/threads/book/${PHM}`, { as: ALICE, body: { body: 'Secret members-only take' } });
    const after = (await t.call('GET', '/public/shelf')).body; // no sign-in
    expect(after.current).toBeNull();
    expect(after.books).toEqual([{ readOn: '2026-02-01T03:00:00.000Z', book: before.current.book }]);

    // Nothing about members leaks out.
    const text = JSON.stringify(after);
    for (const leak of ['alice', 'bob', 'admin@', 'Secret', 'votes', 'leader', 'edited', 'meet.google']) expect(text).not.toContain(leak);
  });

  it('serves a public page for the headliner and past books only', async () => {
    const { t } = await withCompletedMeeting();
    await t.call('POST', '/nominations', { as: BOB, body: { isbn: DUNE } }); // on The Lineup: members only

    const page = await t.call('GET', `/public/books/${PHM}`);
    expect(page.status).toBe(200);
    expect(page.body).toEqual({
      book: expect.objectContaining({ isbn: PHM, title: 'Project Hail Mary', amazonUrl: 'https://www.amazon.com/dp/0593135202' }),
      readOn: [],
      meetsOn: '2026-02-01T03:00:00.000Z',
    });
    expect(Object.keys(page.body.book)).not.toEqual(expect.arrayContaining(['editedBy', 'coverPinned']));
    expect((await t.call('GET', '/public/books/0593135202')).status).toBe(200); // ISBN-10 works too
    expect((await t.call('GET', `/public/books/${DUNE}`)).status).toBe(404);
    expect((await t.call('GET', '/public/books/nonsense')).status).toBe(404);
  });
});

describe('lookups while a page loads', () => {
  it('save nothing when they answer after the page stopped waiting, and save when in time', async () => {
    const t = await setup();
    await t.store.put({ ...keys.book(PHM), isbn: PHM, title: 'Project Hail Mary', author: 'Andy Weir' });
    const slowLookup = (ms: number) => {
      const real = t.books.lookupIsbn.bind(t.books);
      t.books.lookupIsbn = async (isbn) => {
        await new Promise((r) => setTimeout(r, ms));
        return real(isbn);
      };
    };
    const stored = async () => (await t.store.get<Record<string, unknown> & { PK: string; SK: string }>(keys.book(PHM).PK, keys.book(PHM).SK))!;

    slowLookup(80);
    await withinBudget(20, (budget) => ensureMetadata(t.deps, PHM, budget));
    await new Promise((r) => setTimeout(r, 120)); // the lookup has answered by now
    expect((await stored()).metadataCheckedAt).toBeUndefined();

    await withinBudget(500, (budget) => ensureMetadata(t.deps, PHM, budget));
    expect((await stored()).metadataCheckedAt).toBeTruthy();
  });
});

describe('searching for a book to nominate', () => {
  it('lists editions with ISBNs, Google Books first, one per ISBN', async () => {
    const t = await setup();
    t.books.searchEditions = async () => [
      { title: 'Dune', author: 'Frank Herbert', isbn: DUNE, source: 'Open Library' },
      { title: 'Dune (no ISBN)', author: 'Frank Herbert', source: 'Google Books' },
      { title: 'Dune Messiah', author: 'Frank Herbert', isbn: '9780593098233', source: 'Open Library' },
      { title: 'Dune', author: 'Frank Herbert', isbn: DUNE, publisher: 'Ace', source: 'Google Books' },
    ];
    const res = await t.call('GET', '/books/editions', { as: ALICE, query: { q: 'dune' } });
    expect(res.status).toBe(200);
    expect(res.body.editions.map((e: { title: string; source: string }) => `${e.title} / ${e.source}`)).toEqual([
      'Dune / Google Books',
      'Dune Messiah / Open Library',
    ]);
    expect((await t.call('GET', '/books/editions', { as: ALICE, query: { q: 'd' } })).status).toBe(400);
  });
});
