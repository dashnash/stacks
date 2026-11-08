import { useEffect, useState } from 'react';
import { BookEditor } from '../components/BookEditor';
import { Thread } from '../components/Discussion';
import { VoteButton } from '../components/LineupPanel';
import { BackToKlub, BookPageLoading, BookSpread } from '../components/BookSpread';
import { ErrorNote, PanelHeading } from '../components/ui';
import { useApi } from '../lib/auth';
import { formatShortDate, monthStamp } from '../lib/format';
import type { BookDetails } from '../lib/types';
import { useAsync } from '../lib/useAsync';

/** Where the book stands in the Klub: on The Lineup, being read, or on the shelf. */
function status(details: BookDetails): string | null {
  const upcoming = details.meetings.find((m) => m.status === 'UPCOMING');
  if (upcoming) return `Now reading · ${upcoming.title}`;
  if (details.nomination) return `On The Lineup · nominated by ${details.nomination.nominatedBy?.name ?? 'a member'}`;
  const read = details.meetings.find((m) => m.status === 'PAST');
  if (read) return `Read in ${monthStamp(read.dateTime)}`;
  return null;
}

/**
 * A book's page: its cover and details, a link to buy it, votes (when it's on The
 * Lineup), the meetings that read it and its discussion. Admins and whoever nominated it can fix its details,
 * cover and Amazon link.
 */
export function BookView({ isbn, onChanged }: { isbn: string; onChanged?: () => void }) {
  const api = useApi();
  const details = useAsync(() => api.bookDetails(isbn), [isbn]);
  const [voting, setVoting] = useState(false);
  const [voteError, setVoteError] = useState<Error | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [isbn]);

  const data = details.data;
  if (!data) {
    return (
      <main>
        <BookPageLoading error={details.error} />
      </main>
    );
  }

  const { book, nomination } = data;

  async function toggleVote() {
    if (!nomination) return;
    setVoting(true);
    setVoteError(null);
    try {
      await (nomination.myVote ? api.unvote(nomination.id) : api.vote(nomination.id));
      await details.reload();
      onChanged?.();
    } catch (err) {
      setVoteError(err as Error);
    } finally {
      setVoting(false);
    }
  }

  const label = status(data);
  return (
    <main>
      <BackToKlub />
      <BookSpread
        book={book}
        status={label}
        titleId="book-title"
        className="border-b-2 border-ink"
        actions={
          <>
            {nomination && (
              <VoteButton
                nomination={{ ...nomination, book, commentCount: data.commentCount }}
                busy={voting}
                onToggle={() => void toggleVote()}
              />
            )}
            {/* A button, not a #link: hash changes are page changes here. */}
            <button
              type="button"
              className="btn-ghost !px-4 !py-2"
              onClick={() => document.getElementById('book-talk')?.scrollIntoView({ behavior: 'smooth' })}
            >
              <span aria-hidden>💬</span> {data.commentCount} {data.commentCount === 1 ? 'comment' : 'comments'}
            </button>
            {data.canEdit && (
              <button type="button" className="btn-ghost !px-4 !py-2" onClick={() => setEditing(true)}>
                <span aria-hidden>✎</span> Edit book
              </button>
            )}
          </>
        }
        afterActions={
          <>
            <ErrorNote error={voteError} />
            {nomination && (
              <p className="mt-2 text-sm text-ink/60">
                {nomination.votes} {nomination.votes === 1 ? 'member wants' : 'members want'} to read this next.
              </p>
            )}
          </>
        }
      >
        {data.meetings.length > 0 && (
          <div className="mt-8">
            <p className="kicker">At the Klub</p>
            <ul className="mt-2 space-y-1">
              {data.meetings.map((m) => (
                <li key={m.id}>
                  <span className="font-semibold">{m.status === 'UPCOMING' ? 'Up next' : 'Read'}</span> ·{' '}
                  {formatShortDate(m.dateTime)} · led by {m.leader?.name ?? 'a member'}
                </li>
              ))}
            </ul>
          </div>
        )}
      </BookSpread>

      <section id="book-talk" className="panel scroll-mt-20" aria-labelledby="book-talk-heading">
        <p className="kicker">Spoilers welcome</p>
        <PanelHeading id="book-talk-heading" word="The" voice="conversation" />
        <div className="max-w-3xl">
          <Thread thread={{ kind: 'book', id: book.isbn, label: 'The book' }} onChanged={() => void details.reload()} />
        </div>
      </section>

      {data.canEdit && editing && (
        <BookEditor
          book={book}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await details.reload();
            onChanged?.();
          }}
        />
      )}
    </main>
  );
}
