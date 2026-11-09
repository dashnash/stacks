import { commentCounts } from '../comments/routes.js';
import { getUpcomingMeeting, listLineup, listMeetings, listPastMeetings } from '../meetings/repo.js';
import { nominationForBook } from '../meetings/routes.js';
import { getPeople } from '../users/repo.js';
import type { Deps } from '../utils/deps.js';
import type { Handler } from '../utils/handler.js';
import { badRequest, forbidden, notFound } from '../utils/http.js';
import { isAdmin } from '../utils/model.js';
import type { Book, User } from '../utils/model.js';
import type { RequestContext } from '../utils/router.js';
import { defaultAmazonUrl, validateAmazonUrl } from './amazon.js';
import { normalizeIsbn } from './isbn.js';
import { ensureHiResCover, ensureMetadata, getBook, getBooks, saveBook, withinBudget } from './repo.js';

/** How long opening a book page may wait for missing details to be looked up. */
const LOOKUP_BUDGET_MS = 2500;

async function requireBook(deps: Deps, rawIsbn: string): Promise<Book> {
  const isbn = normalizeIsbn(rawIsbn);
  const book = isbn ? await getBook(deps, isbn) : undefined;
  if (!book) throw notFound('That book isn’t in the Klub’s library');
  return book;
}

/**
 * Who can fix a book's details: admins, and whoever nominated it, whether it's still on
 * The Lineup or was picked for a meeting from their nomination.
 */
export async function canEditBook(deps: Deps, user: User, isbn: string): Promise<boolean> {
  if (isAdmin(user)) return true;
  const [lineup, meetings] = await Promise.all([listLineup(deps), listMeetings(deps)]);
  if (lineup.some((n) => n.bookIsbn === isbn && n.nominatedById === user.id)) return true;
  return meetings.some(
    (m) => m.bookIsbn === isbn && m.chosenNomination?.nominatedById === user.id,
  );
}

async function requireEditor(deps: Deps, user: User, isbn: string): Promise<void> {
  if (!(await canEditBook(deps, user, isbn))) {
    throw forbidden('Only the member who nominated this book, or an admin, can edit it');
  }
}

/** A book as the details page shows it: the Amazon link is always filled in. */
function bookView(book: Book) {
  const { coverCheckedAt: _c, metadataCheckedAt: _m, ...rest } = book;
  return { ...rest, amazonUrl: book.amazonUrl ?? defaultAmazonUrl(book.isbn), amazonUrlIsCustom: !!book.amazonUrl };
}

/**
 * Everything the book page shows: the book, its Lineup card (votes) if it's nominated,
 * the meetings that read it, and how many comments it has.
 */
export const getBookDetails: Handler = async (req, user, deps) => {
  const found = await requireBook(deps, req.params.isbn!);
  // Books saved before the details page get their publisher, pages, etc. (and a sharper cover) once.
  // One after the other: each saves the book, and running them together could lose one's changes.
  await withinBudget(LOOKUP_BUDGET_MS, async (budget) => {
    await ensureMetadata(deps, found.isbn, budget);
    await ensureHiResCover(deps, found.isbn, budget);
  });

  const [book, nomination, allMeetings, [commentCount], canEdit] = await Promise.all([
    getBook(deps, found.isbn),
    nominationForBook(deps, found.isbn, user),
    listMeetings(deps),
    commentCounts(deps, [{ kind: 'book', id: found.isbn }]),
    canEditBook(deps, user, found.isbn),
  ]);
  const meetings = allMeetings.filter((m) => m.bookIsbn === found.isbn);
  const leaders = await getPeople(deps, meetings.map((m) => m.leaderId));
  return {
    body: {
      book: bookView(book ?? found),
      nomination,
      meetings: meetings.map((m) => ({
        id: m.id,
        title: m.title,
        dateTime: m.dateTime,
        status: m.status,
        leader: leaders.get(m.leaderId),
      })),
      commentCount: commentCount ?? 0,
      canEdit,
    },
  };
};

const LIMITS = { title: 300, author: 300, publisher: 200, publishedDate: 40, description: 5000, url: 2000 } as const;

/** A text field: undefined = leave alone, '' or null = clear (when allowed). */
function textField(body: Record<string, unknown>, field: keyof typeof LIMITS, { required = false } = {}) {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (value === null || value === '') {
    if (required) throw badRequest(`"${field}" can't be empty`);
    return null;
  }
  if (typeof value !== 'string') throw badRequest(`"${field}" must be text`);
  const trimmed = value.trim();
  if (!trimmed && required) throw badRequest(`"${field}" can't be empty`);
  if (trimmed.length > LIMITS[field]) throw badRequest(`"${field}" is too long (${LIMITS[field]} characters at most)`);
  return trimmed || null;
}

function httpsUrl(value: string, field: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && value.length <= LIMITS.url) return url.toString();
  } catch {
    // fall through
  }
  throw badRequest(`"${field}" must be an https:// address`);
}

/**
 * Admins, and the book's nominator, fix its details. Only the fields sent change; null (or '') clears an
 * optional one. `coverUrl: null` means "no image" (the typeset cover), `amazonUrl: null`
 * goes back to the link built from the ISBN. A chosen cover is pinned, so automatic
 * cover lookups leave it alone.
 */
export const updateBook: Handler = async (req, user, deps) => {
  const book = await requireBook(deps, req.params.isbn!);
  await requireEditor(deps, user, book.isbn);
  const body = req.body;
  const next: Book = { ...book };
  const set = <K extends keyof Book>(key: K, value: Book[K] | null | undefined) => {
    if (value === undefined) return;
    if (value === null) delete next[key];
    else next[key] = value;
  };

  set('title', textField(body, 'title', { required: true }) as string | undefined);
  set('author', textField(body, 'author', { required: true }) as string | undefined);
  set('publisher', textField(body, 'publisher'));
  set('publishedDate', textField(body, 'publishedDate'));
  set('description', textField(body, 'description'));

  if ('pageCount' in body) {
    const pages = body.pageCount;
    if (pages === null || pages === '') set('pageCount', null);
    else if (typeof pages === 'number' && Number.isInteger(pages) && pages > 0 && pages < 100_000)
      set('pageCount', pages);
    else throw badRequest('"pageCount" must be a whole number of pages');
  }

  if ('subjects' in body) {
    const subjects = body.subjects;
    if (subjects === null) set('subjects', null);
    else if (Array.isArray(subjects) && subjects.every((x) => typeof x === 'string')) {
      const clean = [...new Set(subjects.map((x: string) => x.trim()).filter(Boolean))].slice(0, 10);
      if (clean.some((x) => x.length > 60)) throw badRequest('Each subject must be 60 characters or fewer');
      set('subjects', clean.length ? clean : null);
    } else throw badRequest('"subjects" must be a list of text');
  }

  if ('coverUrl' in body) {
    const cover = body.coverUrl;
    if (cover === null || cover === '') {
      set('coverUrl', null);
      set('coverWidth', null);
    } else if (typeof cover === 'string') {
      next.coverUrl = httpsUrl(cover.trim(), 'coverUrl');
      const width = body.coverWidth;
      set('coverWidth', typeof width === 'number' && width > 0 ? Math.round(width) : null);
    } else throw badRequest('"coverUrl" must be an https:// address or null');
    next.coverPinned = true;
  }

  if ('amazonUrl' in body) {
    const link = body.amazonUrl;
    if (link === null || link === '') set('amazonUrl', null);
    else if (typeof link === 'string') next.amazonUrl = validateAmazonUrl(link);
    else throw badRequest('"amazonUrl" must be a link or null');
  }

  next.editedBy = user.id;
  next.editedAt = deps.now().toISOString();
  await saveBook(deps, next);
  // For the activity log: each changed field, before → after (long text just marked as changed).
  const changes: Record<string, unknown> = {};
  for (const field of [
    'title',
    'author',
    'publisher',
    'publishedDate',
    'pageCount',
    'subjects',
    'coverUrl',
    'amazonUrl',
    'description',
  ] as const) {
    const before = book[field];
    const after = next[field];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changes[field] = field === 'description' ? 'changed' : { from: before ?? null, to: after ?? null };
  }
  return { body: { book: bookView(next) }, audit: { label: next.title, changes } };
};

/**
 * Look the book up again for someone fixing it (admin or nominator). Saves nothing.
 * - By its ISBN: what the sources say now (to refill details) and every cover they have,
 *   widest first.
 * - With `?q=` search terms: matching editions (any ISBN), each with its cover and
 *   details, for when the ISBN's own record is wrong or thin.
 */
/**
 * Search for a book to nominate: editions matching the terms, with the details and cover each source has.
 * Only editions with an ISBN (a nomination needs one), Google Books first, one per ISBN.
 */
export const searchEditions: Handler = async (req, _user, deps) => {
  const q = (req.query.q ?? '').trim();
  if (q.length < 2) throw badRequest('Search query "q" must be at least 2 characters');
  if (q.length > 200) throw badRequest('Search terms are too long');
  const found = await deps.books.searchEditions(q).catch(() => []);
  const rank = (source: string) => (source === 'Google Books' ? 0 : 1);
  const seen = new Set<string>();
  const editions = found
    .filter((e) => !!e.isbn)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e.source) - rank(b.e.source) || a.i - b.i)
    .map(({ e }) => e)
    .filter((e) => (seen.has(e.isbn!) ? false : (seen.add(e.isbn!), true)));
  return { body: { editions } };
};

export const lookUpBookAgain: Handler = async (req, user, deps) => {
  const book = await requireBook(deps, req.params.isbn!);
  await requireEditor(deps, user, book.isbn);
  // With search terms: any edition matching them (when the ISBN's own record is wrong or thin).
  const q = (req.query.q ?? '').trim();
  if (q) {
    if (q.length > 200) throw badRequest('Search terms are too long');
    const editions = await deps.books.searchEditions(q).catch(() => []);
    return { body: { found: null, covers: [], editions } };
  }
  const [found, covers] = await Promise.all([
    deps.books.lookupIsbn(book.isbn).catch(() => null),
    deps.books.coverCandidates(book.isbn, book.title, book.author).catch(() => []),
  ]);
  return { body: { found, covers, editions: [] } };
};

/**
 * A book as signed-out visitors see it: what's printed on and about the book, plus where
 * to buy it. Never anything about members (no nominator, edits, votes or comments).
 */
function publicBook(book: Book, { full = false } = {}) {
  const picked = {
    isbn: book.isbn,
    title: book.title,
    author: book.author,
    coverUrl: book.coverUrl,
    publisher: book.publisher,
    publishedDate: book.publishedDate,
    pageCount: book.pageCount,
    ...(full
      ? {
          description: book.description,
          subjects: book.subjects,
          amazonUrl: book.amazonUrl ?? defaultAmazonUrl(book.isbn),
        }
      : {}),
  };
  return Object.fromEntries(Object.entries(picked).filter(([, v]) => v !== undefined && v !== ''));
}

/**
 * Books signed-out visitors may see: the ones the Klub has read, and the current headliner
 * once it's picked. (Not The Lineup: nominations are members-only.)
 */
async function publicBooks(deps: Deps) {
  const [upcoming, past] = await Promise.all([getUpcomingMeeting(deps), listPastMeetings(deps)]);
  const current = upcoming?.bookIsbn ? { meetsOn: upcoming.dateTime, isbn: upcoming.bookIsbn } : null;
  const read = past.flatMap((m) => (m.bookIsbn ? [{ readOn: m.dateTime, isbn: m.bookIsbn }] : []));
  return { current, read };
}

/**
 * The shelf for signed-out visitors (the home page): the current headliner (when picked)
 * and every book the Klub has read, with when. Deliberately nothing about members: no
 * hosts, leaders, nominators, votes, comments or video links, since anyone can call it.
 */
export async function getPublicShelf(deps: Deps) {
  const { current, read } = await publicBooks(deps);
  const books = await getBooks(deps, [...(current ? [current.isbn] : []), ...read.map((r) => r.isbn)]);
  const currentBook = current && books.get(current.isbn);
  return {
    body: {
      current: currentBook ? { meetsOn: current.meetsOn, book: publicBook(currentBook) } : null,
      books: read.flatMap(({ readOn, isbn }) => {
        const book = books.get(isbn);
        return book ? [{ readOn, book: publicBook(book) }] : [];
      }),
    },
  };
}

/** A book's public page: only for the current headliner and books the Klub has read. */
export async function getPublicBook(deps: Deps, rawIsbn: string) {
  const isbn = normalizeIsbn(rawIsbn);
  const { current, read } = await publicBooks(deps);
  const isPublic = !!isbn && (current?.isbn === isbn || read.some((r) => r.isbn === isbn));
  const book = isPublic ? await getBook(deps, isbn!) : undefined;
  if (!book) throw notFound('That book isn’t on the Klub’s public shelf');
  return {
    body: {
      book: publicBook(book, { full: true }),
      readOn: read.filter((r) => r.isbn === isbn).map((r) => r.readOn),
      meetsOn: current?.isbn === isbn ? current.meetsOn : null,
    },
  };
}
