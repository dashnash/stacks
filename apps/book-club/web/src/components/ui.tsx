import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Book, Person } from '../lib/types';

export function Avatar({ person, size = 32 }: { person?: Pick<Person, 'name' | 'pictureUrl'>; size?: number }) {
  // Initials from words that start with a letter, so "You (Admin)" becomes "YA" rather than "Y(".
  const initials =
    (person?.name ?? '')
      .split(/\s+/)
      .map((p) => p.match(/\p{L}/u)?.[0] ?? '')
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';
  if (person?.pictureUrl) {
    return (
      <img
        src={person.pictureUrl}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        className="shrink-0 rounded-full border-2 border-ink object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full border-2 border-ink bg-lav font-cond font-extrabold text-ink"
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.42) }}
    >
      {initials}
    </span>
  );
}

/** Poster-cover colors, picked from the ISBN so a book always gets the same one. */
const COVER_STYLES = [
  'bg-lav text-ink',
  'bg-sun text-ink',
  'bg-coral text-ink',
  'bg-ink text-paper',
  'bg-paper text-ink',
];
export const coverStyle = (isbn: string) => COVER_STYLES[Number(isbn.slice(-1)) % COVER_STYLES.length]!;

type CoverBook = Pick<Book, 'title' | 'author' | 'coverUrl' | 'isbn'>;

const PLACEHOLDER_SIZES = {
  sm: { box: 'p-1.5', title: 'text-[0.8rem]', author: 'text-[0.65rem]' },
  md: { box: 'p-2.5', title: 'text-[clamp(1rem,2vw,1.4rem)]', author: 'text-sm' },
  lg: { box: 'p-4', title: 'text-[clamp(1.6rem,3vw,2.6rem)]', author: 'text-lg' },
} as const;

/**
 * A book cover: the real cover image when there is one, otherwise a typeset
 * poster block. `compact` is for thumbnails (just the title's initial).
 * `stamp` is a small label in the top corner, e.g. the month it was read.
 */
export function BookCover({
  book,
  className = 'w-24',
  compact = false,
  stamp,
  eager = false,
  size = 'md',
}: {
  book: CoverBook;
  className?: string;
  compact?: boolean;
  stamp?: string;
  /** Load immediately (for above-the-fold covers) instead of lazily. */
  eager?: boolean;
  /** Lettering scale for the typeset placeholder: card thumbnails (sm), shelf (md), poster (lg). */
  size?: 'sm' | 'md' | 'lg';
}) {
  const stampEl = stamp ? (
    <span className="kicker absolute left-2 top-2 border-2 border-ink bg-paper px-1.5 py-0.5 text-[10px] text-ink">
      {stamp}
    </span>
  ) : null;

  // A cover URL that fails to load (gone, blocked, offline) falls back to the typeset cover,
  // so cards never show an empty frame.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (book.coverUrl && failedUrl !== book.coverUrl) {
    return (
      <div className={`${className} relative aspect-[2/3] max-w-full shrink-0 border-2 border-ink bg-ink`}>
        <img
          src={book.coverUrl}
          alt={`Cover of ${book.title}`}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          {...(eager ? { fetchPriority: 'high' as const } : {})}
          onError={() => setFailedUrl(book.coverUrl ?? null)}
          className="h-full w-full object-cover"
        />
        {stampEl}
      </div>
    );
  }

  const style = coverStyle(book.isbn);
  if (compact) {
    return (
      <div
        role="img"
        aria-label={`Cover of ${book.title}`}
        className={`${className} ${style} flex aspect-[2/3] max-w-full shrink-0 items-center justify-center overflow-hidden border-2 border-ink font-cond text-xl font-black`}
      >
        {book.title
          .replace(/^(the|a|an)\s+/i, '')
          .charAt(0)
          .toUpperCase()}
      </div>
    );
  }
  return (
    <div
      role="img"
      aria-label={`Cover of ${book.title}`}
      className={`${className} ${style} relative flex aspect-[2/3] max-w-full shrink-0 flex-col justify-end overflow-hidden border-2 border-ink ${PLACEHOLDER_SIZES[size].box}`}
    >
      {stampEl}
      <span
        className={`font-cond font-black uppercase leading-[0.92] [overflow-wrap:break-word] ${PLACEHOLDER_SIZES[size].title}`}
      >
        {book.title}
      </span>
      <span className={`voice mt-1 leading-tight opacity-80 ${PLACEHOLDER_SIZES[size].author}`}>{book.author}</span>
    </div>
  );
}

let scrollLocks = 0;
let savedScroll = 0;

/**
 * Pin the page while a popup is open, so swipes scroll the popup and not the page behind it
 * (iOS Safari ignores overflow:hidden on <body>, so the body is fixed in place instead).
 * Nested popups share one lock. Returns the unlock function.
 */
export function lockPageScroll(): () => void {
  if (scrollLocks++ === 0) {
    savedScroll = window.scrollY;
    const body = document.body.style;
    body.position = 'fixed';
    body.top = `-${savedScroll}px`;
    body.left = '0';
    body.right = '0';
    body.overflow = 'hidden';
  }
  return () => {
    if (--scrollLocks > 0) return;
    const body = document.body.style;
    body.position = body.top = body.left = body.right = body.overflow = '';
    window.scrollTo(0, savedScroll);
  };
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** A wider dialog for content with diagrams (e.g. the help overlay). */
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    return lockPageScroll();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  // Rendered at the top of the page so it never inherits colors or stacking from where it was opened.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center overscroll-contain bg-ink/70 p-3 text-ink sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`max-h-[90vh] max-h-[90dvh] w-full ${wide ? 'max-w-4xl' : 'max-w-xl'} overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] border-2 border-ink bg-paper shadow-[8px_8px_0_rgb(var(--c-ink))]`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b-2 border-ink px-5 py-4">
          <h2 className="display text-3xl">{title}</h2>
          <button type="button" className="btn-ghost h-10 w-10 !p-0" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function ErrorNote({ error }: { error?: Error | string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="border-2 border-coral bg-coral/10 px-3 py-2 text-sm font-semibold">
      {typeof error === 'string' ? error : error.message}
    </p>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 text-sm font-semibold">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink/20 border-t-coral" />
      {label}…
    </div>
  );
}

/** "PAST headliners": a condensed headline with an italic serif word. */
export function PanelHeading({ id, word, voice }: { id: string; word: string; voice: string }) {
  return (
    <h2 id={id} className="display mb-6 mt-2 text-[clamp(3rem,6vw,4.5rem)]">
      {word} <span className="voice text-[0.78em]">{voice}</span>
    </h2>
  );
}
