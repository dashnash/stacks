import { useState } from 'react';
import { useApi } from '../lib/auth';
import { bookHref } from '../lib/route';
import type { Lineup, NominationView } from '../lib/types';
import { DiscussButton, DiscussionModal } from './Discussion';
import { NominateBook } from './NominateBook';
import { BookCover, ErrorNote, PanelHeading } from './ui';

/** One book on The Lineup: cover, title, who nominated it, and what the viewer can do with it. */
export function NominationCard({
  nomination,
  actions,
  voteSummary = false,
  linked = true,
}: {
  nomination: NominationView;
  actions?: React.ReactNode;
  /** Show the vote count as text (for places without a vote button, like the leader's picker). */
  voteSummary?: boolean;
  /** Link the cover and title to the book's page (off inside popups, which would stay open over it). */
  linked?: boolean;
}) {
  const { book } = nomination;
  const href = bookHref(book.isbn);
  const cover = <BookCover book={book} className="lift-cover w-20 sm:w-24" size="sm" />;
  return (
    <li className="lift-card flex gap-4 border-t-2 border-ink py-4 last:border-b-2">
      {/* The cover and the title both open the book's page; the cover link is skipped when tabbing (the title has it). */}
      {linked ? (
        <a href={href} tabIndex={-1} className="shrink-0 self-start">
          {cover}
        </a>
      ) : (
        cover
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="font-cond text-[clamp(1.5rem,2.6vw,2rem)] font-extrabold uppercase leading-[0.95] [overflow-wrap:anywhere]">
          {linked ? (
            <a href={href} className="lift-title">
              {book.title}
            </a>
          ) : (
            <span className="lift-title">{book.title}</span>
          )}
        </p>
        <p className="voice text-lg leading-tight">{book.author}</p>
        <p className="mt-1 text-sm text-ink/60">
          nominated by {nomination.nominatedBy?.name ?? 'a member'}
          {voteSummary && (
            <span className="font-semibold text-ink">
              {' · '}▲ {nomination.votes} {nomination.votes === 1 ? 'vote' : 'votes'}
            </span>
          )}
        </p>
        {actions && <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-3">{actions}</div>}
      </div>
    </li>
  );
}

/** "▲ 3": toggles the viewer's vote for a Lineup book. */
export function VoteButton({
  nomination,
  busy,
  onToggle,
}: {
  nomination: NominationView;
  busy: boolean;
  onToggle: () => void;
}) {
  const { votes, myVote } = nomination;
  return (
    <button
      type="button"
      aria-pressed={myVote}
      aria-label={`${myVote ? 'Remove your vote for' : 'Vote for'} ${nomination.book.title} (${votes} ${votes === 1 ? 'vote' : 'votes'})`}
      title={myVote ? 'You want to read this. Click to take your vote back.' : 'Want to read this? Vote for it.'}
      className={`btn !gap-1.5 !px-3 !py-1 tabular-nums ${myVote ? 'bg-coral text-ink' : 'bg-transparent text-ink hover:bg-ink/5'}`}
      disabled={busy}
      onClick={onToggle}
    >
      <span aria-hidden>▲</span> {votes}
    </button>
  );
}

/** The Lineup: always open for nominations, and the leader picks the next book from it. */
export function LineupPanel({
  lineup,
  meetingTitle,
  onChanged,
  onPick,
}: {
  lineup: Lineup;
  /** Title of the upcoming meeting, shown on the pick buttons. */
  meetingTitle?: string;
  onChanged: () => Promise<void> | void;
  /** Present when the viewer can pick books for the upcoming meeting. */
  onPick?: (nominationId: string) => Promise<void>;
}) {
  const api = useApi();
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [discussing, setDiscussing] = useState<NominationView | null>(null);
  const [query, setQuery] = useState('');
  // The words searched for, while the nominate screen is open.
  const [nominating, setNominating] = useState<string | null>(null);
  const onLineup = new Set(lineup.nominations.map((n) => n.book.isbn));

  async function act(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  }

  const count = lineup.nominations.length;
  return (
    <section className="panel" aria-labelledby="lineup-heading">
      <p className="kicker">
        Nominations · {count} {count === 1 ? 'book' : 'books'} waiting · most wanted first
      </p>
      <PanelHeading id="lineup-heading" word="The" voice="lineup" />

      <div className="space-y-6">
        <form
          role="search"
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim().length >= 2) setNominating(query.trim());
          }}
        >
          <label htmlFor="book-search" className="sr-only">
            Search by title and/or author
          </label>
          <input
            id="book-search"
            className="input"
            type="search"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title and/or author"
          />
          <button type="submit" className="btn-primary shrink-0" disabled={query.trim().length < 2}>
            Search
          </button>
        </form>
        <ErrorNote error={error} />

        {count === 0 ? (
          <p className="voice text-2xl leading-snug">
            Nothing on the lineup yet. Be the first to make a case for your favourite.
          </p>
        ) : (
          <ul aria-label="The Lineup">
            {lineup.nominations.map((n) => (
              <NominationCard
                key={n.id}
                nomination={n}
                actions={
                  <>
                    <VoteButton
                      nomination={n}
                      busy={busy !== null}
                      onToggle={() => act(n.id, () => (n.myVote ? api.unvote(n.id) : api.vote(n.id)))}
                    />
                    <DiscussButton count={n.commentCount} label="Discuss" onClick={() => setDiscussing(n)} />
                    {onPick && (
                      <button
                        type="button"
                        className="btn-accent !px-4 !py-1.5"
                        disabled={busy !== null}
                        onClick={() => act(n.id, () => onPick(n.id))}
                      >
                        Pick for {meetingTitle ?? 'next meeting'}
                      </button>
                    )}
                    {n.canWithdraw && (
                      <button
                        type="button"
                        className="kicker underline decoration-coral decoration-2 underline-offset-4"
                        disabled={busy !== null}
                        onClick={() => act(n.id, () => api.withdrawNomination(n.id))}
                      >
                        Withdraw
                      </button>
                    )}
                  </>
                }
              />
            ))}
          </ul>
        )}
      </div>

      {discussing && (
        <DiscussionModal
          open
          onClose={() => setDiscussing(null)}
          title={discussing.book.title}
          threads={[{ kind: 'book', id: discussing.book.isbn, label: 'The book' }]}
          onChanged={() => void onChanged()}
        />
      )}
      {nominating !== null && (
        <NominateBook
          initialQuery={nominating}
          onLineup={onLineup}
          onClose={() => setNominating(null)}
          onNominated={async () => {
            setNominating(null);
            setQuery('');
            await onChanged();
          }}
        />
      )}
    </section>
  );
}
