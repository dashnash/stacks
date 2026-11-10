import { useState, type ReactNode } from 'react';
import { daysUntil, monthStamp, posterDate } from '../lib/format';
import { bookHref } from '../lib/route';
import type { MeetingPhase, MeetingView } from '../lib/types';
import { CoverReveal } from './CoverReveal';
import { DiscussionModal, type ThreadRef } from './Discussion';

const PHASE_LABEL: Record<MeetingPhase, string> = {
  PLANNING: 'Book TBD',
  SELECTED: 'Book picked',
  PAST: 'Done',
};

/** The date as a poster headline: "THU NOV 19", with the day in outline. */
export function DateHeadline({ iso, id, compact = false }: { iso: string; id?: string; compact?: boolean }) {
  const d = posterDate(iso);
  return (
    <h1
      id={id}
      className={`display my-4 ${compact ? 'text-[clamp(4.25rem,11vw,10.5rem)]' : 'text-[clamp(4.25rem,15vw,13.5rem)]'}`}
    >
      {d.weekday} {d.month} <span className="outline-type">{d.day}</span>
    </h1>
  );
}

function Countdown({ iso }: { iso: string }) {
  const days = daysUntil(iso);
  const [label, value] =
    days > 1
      ? ['Days to go', String(days)]
      : days === 1
        ? ['See you', 'Tmrw']
        : days === 0
          ? ['Happening', 'Today']
          : ['Held', `${-days}d ago`];
  return (
    <div className="col-span-2 flex flex-col justify-end bg-lav px-4 py-5 sm:px-6 lg:col-span-1">
      <dt className="kicker">{label}</dt>
      <dd className="display mt-2 text-[clamp(4.5rem,10vw,8rem)]">{value}</dd>
    </div>
  );
}

function SideCell({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 border-b-2 border-ink px-4 py-5 sm:px-6 ${className}`}>
      <dt className="kicker">{label}</dt>
      <dd className="mt-2">{children}</dd>
    </div>
  );
}

export function NextMeetingHero({ meeting, onChanged }: { meeting: MeetingView; onChanged?: () => void }) {
  const [discussing, setDiscussing] = useState<number | null>(null);
  const threads: ThreadRef[] = [
    ...(meeting.book ? [{ kind: 'book' as const, id: meeting.book.isbn, label: 'The book' }] : []),
    { kind: 'meeting', id: meeting.id, label: 'The meeting' },
  ];
  const count = (n: number) => `${n} ${n === 1 ? 'comment' : 'comments'}`;
  const d = posterDate(meeting.dateTime);
  const leaderName = meeting.leader?.name ?? meeting.leaderId;

  return (
    <section
      id="this-month"
      aria-labelledby="next-meeting"
      className="hero grid scroll-mt-20 border-b-2 border-ink lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]"
    >
      <div className="flex min-w-0 flex-col gap-8 border-b-2 border-ink px-4 py-6 sm:px-6 sm:py-8 md:flex-row md:items-start md:justify-between lg:border-b-0 lg:border-r-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <span className="kicker bg-coral px-2 py-1 text-ink">{PHASE_LABEL[meeting.phase]}</span>
            <span className="kicker">Next meeting · {meeting.title}</span>
          </div>
          <DateHeadline iso={meeting.dateTime} id="next-meeting" compact={!!meeting.book} />
          {/* Just the time and the host: the book is on the cover and in the side panel. */}
          <p className="voice flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[clamp(1.6rem,3.2vw,2.75rem)] leading-[1.05]">
            <span>
              {d.time} {d.zone}
            </span>
            <span>
              <span className="kicker font-sans not-italic">Host:</span>{' '}
              <mark className="bg-sun px-1.5 not-italic text-ink">{leaderName}</mark>
            </span>
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            {meeting.videoUrl && (
              <a href={meeting.videoUrl} target="_blank" rel="noreferrer" className="btn-primary !px-6 !py-3 text-base">
                Join the video call <span aria-hidden>→</span>
              </a>
            )}
            {meeting.book && (
              <button type="button" className="btn-ghost !px-5 !py-3" onClick={() => setDiscussing(0)}>
                <span aria-hidden>💬</span> Talk about the book · {count(meeting.bookCommentCount)}
              </button>
            )}
            <button type="button" className="btn-ghost !px-5 !py-3" onClick={() => setDiscussing(threads.length - 1)}>
              <span aria-hidden>💬</span> Meeting chat · {count(meeting.commentCount)}
            </button>
          </div>
        </div>
        {meeting.book && (
          <figure className="w-[min(62vw,15rem)] shrink-0 self-center md:mt-2 md:w-[clamp(11rem,21vw,19rem)] md:self-start">
            <CoverReveal
              book={meeting.book}
              size="lg"
              eager
              kicker={monthStamp(meeting.dateTime)}
              footnote={[`led by ${leaderName}`, meeting.nominatedBy && `nominated by ${meeting.nominatedBy.name}`]
                .filter(Boolean)
                .join(' · ')}
              frameClassName="rotate-[1.5deg] shadow-[10px_10px_0_rgb(var(--c-coral))]"
              href={bookHref(meeting.book.isbn)}
            />
            <figcaption className="kicker mt-5 text-center">Now reading</figcaption>
          </figure>
        )}
      </div>

      <dl className="grid grid-cols-2 lg:grid-cols-1 lg:grid-rows-[auto_auto_1fr]">
        <SideCell label="Leader" className="border-r-2 lg:border-r-0">
          <span className="display block text-[clamp(2rem,4vw,2.75rem)]">{leaderName}</span>
          <span className="voice mt-1 block text-lg leading-tight text-ink/80">picks who leads next</span>
        </SideCell>
        <SideCell label="Reading">
          {meeting.book ? (
            <>
              <span className="display line-clamp-3 block text-[clamp(1.75rem,3.4vw,2.5rem)]">
                {meeting.book.title}
              </span>
              <span className="voice mt-1 block text-lg leading-tight text-ink/80">by {meeting.book.author}</span>
              {meeting.nominatedBy && (
                <span className="kicker mt-2 block text-ink/60">Nominated by {meeting.nominatedBy.name}</span>
              )}
            </>
          ) : (
            <>
              <span className="display block text-[clamp(2rem,4vw,2.75rem)]">TBD</span>
              <span className="voice mt-1 block text-lg leading-tight text-ink/80">
                the leader picks from The Lineup
              </span>
            </>
          )}
        </SideCell>
        <Countdown iso={meeting.dateTime} />
      </dl>

      {discussing !== null && (
        <DiscussionModal
          open
          onClose={() => setDiscussing(null)}
          title={meeting.title}
          threads={discussing === 0 ? threads : [...threads].reverse()}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}
