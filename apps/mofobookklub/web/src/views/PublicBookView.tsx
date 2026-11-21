import { useEffect } from 'react';
import { useOptionalStacks } from '@stacks/web';
import { BackToKlub, BookPageLoading, BookSpread } from '../components/BookSpread';
import { useApi } from '../lib/auth';
import { monthStamp, posterDate } from '../lib/format';
import { useAsync } from '../lib/useAsync';

/**
 * A book's page for signed-out visitors: cover, details and a link to buy it. Members see
 * more (votes, the discussion) once they sign in; nothing about members shows here.
 */
export function PublicBookView({ isbn, commentId }: { isbn: string; commentId?: string }) {
  const api = useApi();
  const signIn = useOptionalStacks()?.signIn;
  const page = useAsync(() => api.publicBook(isbn), [isbn]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [isbn]);

  if (!page.data) return <BookPageLoading error={page.error} />;

  const { book, readOn, meetsOn } = page.data;
  const status = meetsOn
    ? (() => {
        const d = posterDate(meetsOn);
        return `Now reading · meeting ${d.weekday} ${d.month} ${d.day}`;
      })()
    : readOn.length
      ? `Read in ${readOn.map((r) => monthStamp(r)).join(', ')}`
      : null;
  return (
    <>
      <BackToKlub />
      <BookSpread book={book} status={status} titleId="public-book-title">
        {commentId ? (
          // Someone shared a comment: signing in comes back to this same link.
          <div className="mt-8 space-y-3">
            <p className="voice text-xl">Someone shared a comment from the discussion of this book.</p>
            <button type="button" className="btn-primary" onClick={() => signIn?.()}>
              Sign in to see the discussion
            </button>
          </div>
        ) : (
          <p className="mt-8 text-sm text-ink/60">Members: sign in at the top right for votes and the discussion.</p>
        )}
      </BookSpread>
    </>
  );
}
