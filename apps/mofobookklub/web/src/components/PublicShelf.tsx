import { formatPublished, monthStamp, posterDate } from '../lib/format';
import { bookHref } from '../lib/route';
import type { PublicBook, PublicShelfBook } from '../lib/types';
import { CoverReveal } from './CoverReveal';

/** "Ballantine · 2021 · 496 pages" */
export function publicDetails(book: Pick<PublicBook, 'publisher' | 'publishedDate' | 'pageCount'>): string {
  return [
    book.publisher,
    book.publishedDate && formatPublished(book.publishedDate),
    book.pageCount && `${book.pageCount.toLocaleString()} pages`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The current headliner for signed-out visitors: the next meeting's date and its book, with
 * the members' poster hover. No host, video link or anything else about members.
 */
export function PublicHeadliner({ meetsOn, book }: { meetsOn: string; book: PublicBook }) {
  const d = posterDate(meetsOn);
  return (
    <section
      aria-labelledby="public-headliner-heading"
      className="grid items-center gap-8 border-b-2 border-ink px-4 py-12 sm:px-6 md:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div className="min-w-0">
        <p className="kicker">Now reading · next meeting</p>
        <h2 id="public-headliner-heading" className="display mt-3 text-[clamp(3rem,8vw,6.5rem)]">
          {d.weekday} {d.month} <span className="outline-type">{d.day}</span>
        </h2>
        <p className="voice mt-2 text-[clamp(1.6rem,3.2vw,2.5rem)] leading-[1.05]">
          {d.time} {d.zone}
        </p>
        <p className="mt-6 font-cond text-[clamp(1.75rem,3.5vw,2.75rem)] font-extrabold uppercase leading-[0.95]">
          <a href={bookHref(book.isbn)} className="hover:underline">
            {book.title}
          </a>
        </p>
        <p className="voice text-xl">by {book.author}</p>
      </div>
      <div className="mx-auto w-[min(62vw,15rem)] md:w-[clamp(11rem,21vw,17rem)]">
        <CoverReveal
          book={book}
          size="lg"
          eager
          kicker="Now reading"
          footnote={publicDetails(book) || undefined}
          frameClassName="rotate-[1.5deg] shadow-[10px_10px_0_rgb(var(--c-coral))]"
          href={bookHref(book.isbn)}
        />
      </div>
    </section>
  );
}

/**
 * The shelf of past books for signed-out visitors, with the members' shelf hover: the cover,
 * then the month read, title, author and publication details slide in. Each opens the
 * book's public page. No leaders, votes, comments or member names.
 */
export function PublicShelf({ books }: { books: PublicShelfBook[] }) {
  if (books.length === 0) return null;
  return (
    <section aria-labelledby="public-shelf-heading" className="border-b-2 border-ink px-4 py-12 sm:px-6">
      <p className="kicker">
        The shelf · {books.length} {books.length === 1 ? 'book' : 'books'} read
      </p>
      <h2 id="public-shelf-heading" className="display mb-6 mt-2 text-[clamp(2.5rem,6vw,4rem)]">
        Past <span className="voice text-[0.8em]">headliners</span>
      </h2>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
        {books.map(({ readOn, book }) => (
          <CoverReveal
            key={`${book.isbn}-${readOn}`}
            as="li"
            book={book}
            kicker={monthStamp(readOn)}
            footnote={publicDetails(book) || undefined}
            href={bookHref(book.isbn)}
          />
        ))}
      </ul>
    </section>
  );
}
