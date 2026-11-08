import { useState } from 'react';
import { useApi } from '../lib/auth';
import type { BookChoice, MeetingView } from '../lib/types';
import { useAsync } from '../lib/useAsync';
import { BookSearch } from './BookSearch';
import { NominationCard } from './LineupPanel';
import { ErrorNote, Spinner } from './ui';

/**
 * The leader's picker: browse The Lineup (picking one takes it off the list) or
 * search for any other book.
 */
export function ChooseBook({ meeting, onChosen }: { meeting: MeetingView; onChosen: () => Promise<void> | void }) {
  const api = useApi();
  const lineup = useAsync(() => api.lineup(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  async function choose(choice: BookChoice) {
    await api.chooseBook(meeting.id, choice);
    await onChosen();
  }

  /** Lineup picks report errors here; search picks report them in the search box. */
  async function pickNomination(id: string) {
    setBusy(id);
    setError(null);
    try {
      await choose({ nominationId: id });
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(null);
    }
  }

  const nominations = lineup.data?.nominations ?? [];
  return (
    <div className="space-y-6">
      {meeting.book && (
        <p className="voice text-xl leading-snug">
          Currently <span className="not-italic font-semibold">{meeting.book.title}</span>. Picking another puts{' '}
          {meeting.nominatedBy ? 'it back on The Lineup' : 'this one aside'}.
        </p>
      )}
      <ErrorNote error={error ?? lineup.error} />
      <section aria-labelledby="choose-lineup">
        <p id="choose-lineup" className="kicker mb-2">
          From The Lineup · {nominations.length} · most wanted first
        </p>
        {lineup.loading && !lineup.data ? (
          <Spinner />
        ) : nominations.length === 0 ? (
          <p className="voice text-xl">The Lineup is empty. Search for any book below.</p>
        ) : (
          <ul>
            {nominations.map((n) => (
              <NominationCard
                linked={false}
                key={n.id}
                nomination={n}
                voteSummary
                actions={
                  <button
                    type="button"
                    className="btn-accent !px-4 !py-1.5"
                    disabled={busy !== null}
                    onClick={() => void pickNomination(n.id)}
                  >
                    {busy === n.id ? 'Picking…' : 'Pick this one'}
                  </button>
                }
              />
            ))}
          </ul>
        )}
      </section>
      <section>
        <p className="kicker mb-2">Or any other book</p>
        <BookSearch id="choose-search" actionLabel="Pick" onChoose={(isbn) => choose({ isbn })} />
      </section>
    </div>
  );
}
