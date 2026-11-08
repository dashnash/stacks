import type { ReactNode } from 'react';
import type { Book } from '../lib/types';
import { BookCover } from './ui';

const TITLE_SIZE = {
  md: 'text-[clamp(1.25rem,2.2vw,1.6rem)]',
  lg: 'text-[clamp(1.75rem,3vw,2.6rem)]',
} as const;

/**
 * A book cover that shows just the cover until hovered, focused or tapped; then the
 * cover softens and the details slide in from the left over it. Used on the meeting
 * poster and the Past headliners shelf.
 *
 * The card is focusable (tabIndex), which is how keyboards and touch screens reveal
 * it. The details stay in the accessibility tree while hidden.
 */
export function CoverReveal({
  book,
  title,
  kicker,
  footnote,
  as: Tag = 'div',
  size = 'md',
  eager = false,
  className = '',
  frameClassName = '',
  tooltip,
  action,
  href,
}: {
  /** The book; when missing, a dashed "No book recorded" card is shown. */
  book?: Book;
  /** Title to show when there is no book. */
  title?: string;
  kicker?: string;
  footnote?: string;
  as?: 'div' | 'li';
  size?: 'md' | 'lg';
  eager?: boolean;
  className?: string;
  /** Extra classes for the frame (the element that lifts on hover), e.g. a resting tilt. */
  frameClassName?: string;
  tooltip?: string;
  /** A control shown at the foot of the revealed details, e.g. a Discuss button. */
  action?: ReactNode;
  /**
   * The book's page. The title becomes a link that covers the whole card, so clicking
   * anywhere on it opens the page, while `action` buttons stay clickable on top.
   */
  href?: string;
}) {
  // A linked card is reached by tabbing to its link, so the card itself isn't focusable.
  return (
    <Tag className={`lift-card reveal-card ${className}`} tabIndex={href ? undefined : 0} title={tooltip}>
      {/* The frame carries the border so it stays crisp while the cover inside blurs. */}
      <div
        className={`lift-cover relative overflow-hidden border-2 border-ink ${book ? '' : 'border-dashed'} ${frameClassName}`}
      >
        {book ? (
          <BookCover book={book} className="reveal-media w-full !border-0" size={size} eager={eager} />
        ) : (
          <div className="reveal-media relative flex aspect-[2/3] w-full items-end p-2.5">
            {kicker && <span className="kicker absolute left-2 top-2">{kicker}</span>}
            <span className="voice text-lg">No book recorded</span>
          </div>
        )}
        <div
          className={`reveal-panel absolute inset-y-0 left-0 flex w-full flex-col justify-end text-paper ${size === 'lg' ? 'p-5' : 'p-3'}`}
        >
          {kicker && <span className="kicker text-sun">{kicker}</span>}
          <p
            className={`mt-2 font-cond font-extrabold uppercase leading-[0.92] [overflow-wrap:break-word] ${TITLE_SIZE[size]}`}
          >
            {href ? (
              <a href={href} className="lift-title stretched-link focus-visible:outline-none">
                {book?.title ?? title}
              </a>
            ) : (
              <span className="lift-title">{book?.title ?? title}</span>
            )}
          </p>
          {book && (
            <p className={`voice mt-1 leading-tight text-paper/85 ${size === 'lg' ? 'text-xl' : 'text-base'}`}>
              {book.author}
            </p>
          )}
          {footnote && <p className={`mt-3 text-paper/70 ${size === 'lg' ? 'text-sm' : 'text-xs'}`}>{footnote}</p>}
          {href && (
            <p className={`kicker mt-3 text-sun ${size === 'lg' ? '' : 'text-[0.65rem]'}`} aria-hidden>
              More about the book →
            </p>
          )}
          {action && <div className="relative z-10 mt-3">{action}</div>}
        </div>
      </div>
    </Tag>
  );
}
