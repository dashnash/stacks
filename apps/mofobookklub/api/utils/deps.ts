import type { AppDeps } from '@stacks/api';
import type { Book, EasterEgg } from './model.js';

/** A search hit offered to the user when they nominate by title. */
export interface BookCandidate {
  isbn: string;
  title: string;
  author: string;
  coverUrl?: string;
  year?: number;
}

export interface BookSource {
  /** Resolve full metadata (and a verified cover) for an ISBN, or null if unknown. */
  lookupIsbn(isbn: string): Promise<Book | null>;
  /** Free-text title/author search. Only results that carry an ISBN are returned. */
  search(query: string): Promise<BookCandidate[]>;
  /** Every cover image the sources have for a book, measured and widest first. */
  coverCandidates(isbn: string, title?: string, author?: string): Promise<CoverCandidate[]>;
  /** Free-text search for editions (any ISBN), with covers measured and details. */
  searchEditions(query: string): Promise<Edition[]>;
}

/** One edition found by a free-text search. */
export interface Edition {
  title: string;
  author: string;
  isbn?: string;
  coverUrl?: string;
  /** Pixel width of the cover, or 0 if it couldn't be measured. */
  coverWidth?: number;
  publisher?: string;
  publishedDate?: string;
  pageCount?: number;
  description?: string;
  subjects?: string[];
  /** "Open Library" or "Google Books". */
  source: string;
}

/** A cover image found for a book. */
export interface CoverCandidate {
  url: string;
  width: number;
  source: string;
}

/** The Stacks dependencies plus Book Club's own: book sources and the critics' photos. */
export interface Deps extends AppDeps {
  books: BookSource;
  /** A short-lived link to a photo in the app's private content bucket. */
  signImageUrl(key: string): Promise<string>;
  random(): number;
  /** Critic quotes shipped with the code (content/eggs/quotes.json). Table entries with the same id win. */
  bundledEasterEggs?: readonly EasterEgg[];
  /** Keys of the shared "faces" photos (eggs/faces/ in the content bucket; never in git). */
  listFacePhotos?: () => Promise<string[]>;
}
