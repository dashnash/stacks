import type { ReactNode } from 'react';
import { formatPublished } from '../lib/format';
import { kindleBuyUrl } from '../lib/kindle';
import { HOME_HREF } from '../lib/route';
import { BookCover, ErrorNote, Spinner } from './ui';

/** What a book page shows about the book itself (members and visitors alike). */
export interface SpreadBook {
  isbn: string;
  title: string;
  author: string;
  coverUrl?: string;
  amazonUrl?: string;
  publisher?: string;
  publishedDate?: string;
  pageCount?: number;
  description?: string;
  subjects?: string[];
}

/** The "← Back to the Klub" bar at the top of a book page. */
export function BackToKlub() {
  return (
    <div className="border-b-2 border-ink px-4 py-3 sm:px-6">
      <a href={HOME_HREF} className="kicker hover:text-coral">
        ← Back to the Klub
      </a>
    </div>
  );
}

/** A book page while it loads, or when it couldn't be loaded. */
export function BookPageLoading({ error }: { error?: Error | null }) {
  return (
    <>
      <BackToKlub />
      <div className="min-h-[50vh] px-4 py-10 sm:px-6">
        {error ? <ErrorNote error={error} /> : <Spinner label="Fetching the book" />}
      </div>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t-2 border-ink py-3">
      <dt className="kicker text-ink/60">{label}</dt>
      <dd className="mt-1 font-semibold">{children}</dd>
    </div>
  );
}

/**
 * The top of a book page: the cover beside the title, author, buy links, description,
 * publishing facts and subjects. `actions` go after the buy links, `afterActions` just under
 * them, and `children` at the end of the text column.
 */
export function BookSpread({
  book,
  status,
  titleId,
  actions,
  afterActions,
  children,
  className = '',
}: {
  book: SpreadBook;
  status?: string | null;
  titleId: string;
  actions?: ReactNode;
  afterActions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const facts: [string, ReactNode][] = [
    ['Publisher', book.publisher],
    ['Published', book.publishedDate && formatPublished(book.publishedDate)],
    ['Pages', book.pageCount?.toLocaleString()],
    ['ISBN', <span className="tabular-nums">{book.isbn}</span>],
  ];
  return (
    <article
      aria-labelledby={titleId}
      className={`grid gap-8 px-4 py-8 sm:px-6 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:gap-12 lg:py-12 ${className}`}
    >
      <div className="mx-auto w-[min(46vw,13rem)] md:mx-0 md:w-full">
        <div className="rotate-[-1deg] shadow-[10px_10px_0_rgb(var(--c-coral))]">
          <BookCover key={book.coverUrl ?? 'none'} book={book} className="w-full" size="lg" eager />
        </div>
      </div>

      <div className="min-w-0">
        {status && <p className="kicker">{status}</p>}
        <h1 id={titleId} className="display mt-3 text-[clamp(2.75rem,7vw,5.5rem)] [overflow-wrap:anywhere]">
          {book.title}
        </h1>
        <p className="voice mt-2 text-[clamp(1.5rem,3vw,2.25rem)] leading-tight">by {book.author}</p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <a
            href={book.amazonUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary !px-5 !py-3"
            aria-label={`Buy ${book.title} on Amazon (opens in a new tab)`}
          >
            <span aria-hidden>🛒</span> Buy on Amazon
          </a>
          <a
            href={kindleBuyUrl(book)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost !px-5 !py-3"
            aria-label={`Buy ${book.title} for Kindle on Amazon's website (opens in a new tab)`}
          >
            <span aria-hidden>📱</span> Buy for Kindle
          </a>
          {actions}
        </div>
        {afterActions}

        {book.description && (
          <p className="mt-8 max-w-[65ch] whitespace-pre-line text-[1.05rem] leading-relaxed">{book.description}</p>
        )}

        <dl className="mt-8 grid max-w-2xl grid-cols-2 gap-x-6 sm:grid-cols-4">
          {facts
            .filter(([, value]) => value)
            .map(([name, value]) => (
              <Fact key={name} label={name}>
                {value}
              </Fact>
            ))}
        </dl>
        {book.subjects && book.subjects.length > 0 && (
          <ul aria-label="Subjects" className="mt-4 flex flex-wrap gap-2">
            {book.subjects.map((s) => (
              <li key={s} className="border-2 border-ink px-2.5 py-0.5 text-sm font-semibold">
                {s}
              </li>
            ))}
          </ul>
        )}
        {children}
      </div>
    </article>
  );
}
