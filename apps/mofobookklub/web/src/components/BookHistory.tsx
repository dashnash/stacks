import { useMemo, useState } from 'react';
import { formatShortDate, monthStamp } from '../lib/format';
import { bookHref } from '../lib/route';
import type { PastMeeting } from '../lib/types';
import { CoverReveal } from './CoverReveal';
import { DiscussionModal } from './Discussion';
import { PanelHeading } from './ui';

export function BookHistory({ meetings, onChanged }: { meetings: PastMeeting[]; onChanged?: () => void }) {
  const [year, setYear] = useState<string>('all');
  const [discussing, setDiscussing] = useState<PastMeeting | null>(null);
  const years = useMemo(
    () => [...new Set(meetings.map((m) => String(new Date(m.dateTime).getFullYear())))].sort().reverse(),
    [meetings],
  );
  const shown = year === 'all' ? meetings : meetings.filter((m) => String(new Date(m.dateTime).getFullYear()) === year);

  return (
    <section id="shelf" className="panel scroll-mt-20" aria-labelledby="history-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="kicker">
            The shelf · {meetings.length} {meetings.length === 1 ? 'book' : 'books'} read
          </p>
          <PanelHeading id="history-heading" word="Past" voice="headliners" />
        </div>
        {years.length > 1 && (
          <div>
            <label htmlFor="history-year" className="sr-only">
              Filter by year
            </label>
            <select id="history-year" className="input !w-auto !py-2" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="all">All years</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="voice text-2xl leading-snug">No books on the shelf yet. Your first finished meeting will appear here.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {shown.map((m) => (
            <CoverReveal
              key={m.id}
              as="li"
              book={m.book}
              title={m.title}
              kicker={monthStamp(m.dateTime)}
              footnote={`led by ${m.leader?.name ?? m.leaderEmail}`}
              tooltip={formatShortDate(m.dateTime)}
              href={m.book ? bookHref(m.book.isbn) : undefined}
              action={
                <button
                  type="button"
                  className="btn-inverse !px-3 !py-1 text-xs"
                  onClick={() => setDiscussing(m)}
                  aria-label={`Discuss ${m.book?.title ?? m.title} (${m.bookCommentCount + m.commentCount} comments)`}
                >
                  <span aria-hidden>💬</span> {m.bookCommentCount + m.commentCount || 'Discuss'}
                </button>
              }
            />
          ))}
          {year === 'all' && (
            <li aria-hidden className="flex aspect-[2/3] w-full flex-col items-center justify-center border-2 border-dashed border-ink text-center">
              <span className="display text-3xl">Next?</span>
              <span className="voice text-lg">you decide</span>
            </li>
          )}
        </ul>
      )}
      {discussing && (
        <DiscussionModal
          open
          onClose={() => setDiscussing(null)}
          title={discussing.book?.title ?? discussing.title}
          threads={[
            ...(discussing.book ? [{ kind: 'book' as const, id: discussing.book.isbn, label: 'The book' }] : []),
            { kind: 'meeting', id: discussing.id, label: `The ${monthStamp(discussing.dateTime)} meeting` },
          ]}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}
