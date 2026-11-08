import type { Deps } from '../utils/deps.js';
import { badRequest, notFound } from '../utils/http.js';
import { keys, strip, type Book, type BookItem } from '../utils/model.js';
import { normalizeIsbn } from './isbn.js';
import { HI_RES_COVER_WIDTH } from './sources.js';

export async function getBook(deps: Deps, isbn: string): Promise<Book | undefined> {
  const { PK, SK } = keys.book(isbn);
  const item = await deps.store.get<BookItem>(PK, SK);
  return item ? (strip(item) as Book) : undefined;
}

export async function getBooks(deps: Deps, isbns: string[]): Promise<Map<string, Book>> {
  const unique = [...new Set(isbns)];
  const books = await Promise.all(unique.map((isbn) => getBook(deps, isbn)));
  return new Map(books.filter((b): b is Book => !!b).map((b) => [b.isbn, b]));
}

/**
 * Return the cached Book item for an ISBN, fetching and storing it from the
 * external sources on first use so they're only ever queried once per book.
 */
export async function resolveBook(deps: Deps, rawIsbn: string): Promise<Book> {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) throw badRequest(`"${rawIsbn}" is not a valid ISBN`);

  const cached = await getBook(deps, isbn);
  if (cached) return cached;

  const found = await deps.books.lookupIsbn(isbn);
  if (!found) throw notFound(`Couldn't find a book with ISBN ${isbn}`);
  const now = deps.now().toISOString();
  const book: Book = { ...found, coverCheckedAt: now, metadataCheckedAt: now };
  await deps.store.put({ ...keys.book(book.isbn), ...book });
  return book;
}

const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Lookups made while a page loads only wait so long. Past `until` (wall-clock ms) a lookup
 * that finally answers saves nothing: the page has already been sent, and work left over
 * would run whenever Lambda next wakes this container, possibly much later. The book is
 * simply looked up again on a later request.
 */
export interface LookupBudget {
  until?: number;
}

const expired = (budget: LookupBudget) => budget.until !== undefined && Date.now() > budget.until;

/** Run `start(budget)` but wait at most `ms` for it; whatever it does after that is discarded. */
export async function withinBudget(ms: number, start: (budget: LookupBudget) => Promise<unknown>): Promise<void> {
  const budget = { until: Date.now() + ms };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = start(budget).catch(() => undefined);
  await Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

/** True when a book has no sharp cover and hasn't been looked up in the last day. */
function coverCheckDue(deps: Deps, book: Book): boolean {
  if (book.coverPinned || (book.coverWidth ?? 0) >= HI_RES_COVER_WIDTH) return false;
  const checked = book.coverCheckedAt ? Date.parse(book.coverCheckedAt) : 0;
  return deps.now().getTime() - checked >= RECHECK_AFTER_MS;
}

/**
 * Look again for covers of books that have none (or only a small one), so books saved
 * before cover lookups improved fill in over time. Bounded so a page load never waits
 * long: at most `max` books per call and `budgetMs` of waiting. Lookups that miss the
 * budget, and books not reached, are picked up on a later request. Each book is looked up
 * at most once a day.
 */
export async function backfillCovers(
  deps: Deps,
  isbns: string[],
  { max = 4, budgetMs = 2500 }: { max?: number; budgetMs?: number } = {},
): Promise<void> {
  const books = await getBooks(deps, isbns);
  const due = [...books.values()].filter((b) => coverCheckDue(deps, b)).slice(0, max);
  if (due.length === 0) return;
  await withinBudget(budgetMs, (budget) => Promise.allSettled(due.map((b) => ensureHiResCover(deps, b.isbn, budget))));
}

/**
 * Make sure a book that's about to headline the meeting poster has the sharpest
 * cover we can find. Books stored before covers were measured (or whose cover is
 * still small) are looked up again, at most once a day, and only a wider cover
 * replaces the stored one. Lookup failures never break the caller.
 */
export async function ensureHiResCover(deps: Deps, isbn: string, budget: LookupBudget = {}): Promise<void> {
  const book = await getBook(deps, isbn);
  if (!book || !coverCheckDue(deps, book)) return;

  let fresh: Book | null = null;
  try {
    fresh = await deps.books.lookupIsbn(isbn);
  } catch {
    fresh = null;
  }
  if (expired(budget)) return;
  // Re-read so changes made while the lookup ran (an admin edit, filled-in details) are kept.
  const current = (await getBook(deps, isbn)) ?? book;
  if (current.coverPinned) return;
  const better = fresh?.coverUrl && (fresh.coverWidth ?? 0) > (current.coverWidth ?? 0);
  const updated: Book = {
    ...current,
    ...(better ? { coverUrl: fresh!.coverUrl, coverWidth: fresh!.coverWidth } : {}),
    coverCheckedAt: deps.now().toISOString(),
  };
  await deps.store.put({ ...keys.book(isbn), ...updated });
}

/** Details a lookup may fill in when a book doesn't have them yet. Never the title, author or cover. */
const FILLABLE = ['description', 'publisher', 'publishedDate', 'pageCount', 'subjects'] as const;

/**
 * Books saved before the details page existed only have a title, author and cover. The
 * first time one is opened, look it up once more and fill in whatever it is missing
 * (publisher, pages, ...). Never overwrites anything, including an admin's edits.
 */
export async function ensureMetadata(deps: Deps, isbn: string, budget: LookupBudget = {}): Promise<void> {
  const book = await getBook(deps, isbn);
  if (!book || book.metadataCheckedAt) return;
  let fresh: Book | null = null;
  try {
    fresh = await deps.books.lookupIsbn(isbn);
  } catch {
    fresh = null;
  }
  if (expired(budget)) return;
  // Re-read so an edit made while the lookup ran is kept.
  const current = (await getBook(deps, isbn)) ?? book;
  const filled: Partial<Book> = {};
  for (const field of FILLABLE) {
    if (current[field] === undefined && fresh?.[field] !== undefined) Object.assign(filled, { [field]: fresh[field] });
  }
  await deps.store.put({ ...keys.book(isbn), ...current, ...filled, metadataCheckedAt: deps.now().toISOString() });
}

export async function saveBook(deps: Deps, book: Book): Promise<void> {
  await deps.store.put({ ...keys.book(book.isbn), ...book });
}
