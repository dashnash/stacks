import { forgetMembers } from '@stacks/api';
import { createTestHarness, type CallOptions } from '@stacks/testing';
import { manifest } from '../../api/manifest';
import { routes } from '../../api/routes';
import type { BookCandidate, BookSource, CoverCandidate, Deps, Edition } from '../../api/utils/deps';
import type { Book, EasterEgg, Role } from '../../api/utils/model';

export const BOOKS: Record<string, Book> = {
  '9780593135204': {
    isbn: '9780593135204',
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    coverUrl: 'https://covers.example/phm-large.jpg',
    coverWidth: 1200,
  },
  '9780441172719': { isbn: '9780441172719', title: 'Dune', author: 'Frank Herbert', coverUrl: 'https://covers.example/dune-small.jpg', coverWidth: 300 },
  '9780547928227': { isbn: '9780547928227', title: 'The Hobbit', author: 'J.R.R. Tolkien' },
};

export class FakeBooks implements BookSource {
  lookups: string[] = [];
  searches: string[] = [];
  async lookupIsbn(isbn: string): Promise<Book | null> {
    this.lookups.push(isbn);
    return BOOKS[isbn] ?? null;
  }
  async search(query: string): Promise<BookCandidate[]> {
    return Object.values(BOOKS).filter((b) => b.title.toLowerCase().includes(query.toLowerCase()));
  }
  async searchEditions(query: string): Promise<Edition[]> {
    this.searches.push(query);
    return Object.values(BOOKS)
      .filter((b) => `${b.title} ${b.author}`.toLowerCase().includes(query.toLowerCase().split(' ')[0]!))
      .map((b) => ({ title: b.title, author: b.author, isbn: b.isbn, coverUrl: b.coverUrl, coverWidth: b.coverWidth, publisher: 'Fake Press', source: 'Open Library' }));
  }
  async coverCandidates(isbn: string): Promise<CoverCandidate[]> {
    const own = BOOKS[isbn]?.coverUrl;
    return [
      { url: `https://covers.example/${isbn}-alt.jpg`, width: 1400, source: 'Open Library' },
      ...(own ? [{ url: own, width: BOOKS[isbn]!.coverWidth ?? 0, source: 'Google Books' }] : []),
    ];
  }
}

/**
 * Book Club's API in memory, with the same helpers its tests used before the move: members are
 * seeded into the fake platform (which owns them now) instead of the app's table.
 */
export function makeTestApp(opts: { bundledEasterEggs?: EasterEgg[]; faces?: string[]; random?: () => number } = {}) {
  const books = new FakeBooks();
  const t = createTestHarness<Deps>({
    manifest,
    routes,
    extend: (base) => ({
      ...base,
      books,
      signImageUrl: async (key) => `https://signed.example/${key}`,
      random: opts.random ?? (() => 0),
      bundledEasterEggs: opts.bundledEasterEggs,
      listFacePhotos: opts.faces ? async () => opts.faces! : undefined,
    }),
  });

  async function seedUser(email: string, role: Role, name = email.split('@')[0]!) {
    t.platform.members = [...t.platform.members.filter((m) => m.email !== email), { email, name, role }];
    forgetMembers(t.deps);
  }

  /** Call as a seeded member (their role and name come from the fake platform). */
  async function call(method: string, path: string, o: Omit<CallOptions, 'as'> & { as?: string } = {}) {
    const m = o.as ? t.platform.members.find((x) => x.email === o.as) : undefined;
    return t.call(method, path, { ...o, as: o.as ? { email: o.as, name: m?.name ?? o.as.split('@')[0]! } : undefined, role: o.role ?? m?.role ?? 'MEMBER' });
  }

  return { ...t, call, books, seedUser };
}
