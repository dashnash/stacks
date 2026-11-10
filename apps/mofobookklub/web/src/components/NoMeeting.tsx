import { isAdmin } from '../lib/types';
import { useApi } from '../lib/auth';
import type { Person, User } from '../lib/types';
import { useAsync } from '../lib/useAsync';
import { MeetingForm } from './MeetingForm';

/** Shown when nothing is scheduled: the handed-off leader (or an admin) schedules the next meeting. */
export function NoMeeting({
  user,
  nextLeader,
  canCreateNext,
  onChanged,
}: {
  user: User;
  nextLeader: Person | null;
  canCreateNext: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const api = useApi();
  const canAdmin = isAdmin(user);
  const members = useAsync(() => (canAdmin ? api.members().then((r) => r.users) : Promise.resolve([])), [canAdmin]);
  const youAreNext = nextLeader?.id === user.id;

  return (
    <section
      id="this-month"
      aria-labelledby="next-meeting"
      className="hero grid scroll-mt-20 border-b-2 border-ink lg:grid-cols-[minmax(0,1fr)_minmax(320px,460px)]"
    >
      <div className="min-w-0 border-b-2 border-ink px-4 py-6 sm:px-6 sm:py-8 lg:border-b-0 lg:border-r-2">
        <span className="kicker">Next meeting</span>
        <h1 id="next-meeting" className="display my-4 text-[clamp(4.25rem,13vw,11rem)]">
          {youAreNext ? (
            <>
              You&apos;re <span className="outline-type">up!</span>
            </>
          ) : (
            <>
              Date <span className="outline-type">TBA</span>
            </>
          )}
        </h1>
        <p className="voice max-w-[26ch] text-[clamp(1.6rem,3.2vw,2.5rem)] leading-[1.05]">
          {nextLeader
            ? youAreNext
              ? 'The last leader passed you the torch. Pick a date and open nominations.'
              : `${nextLeader.name} is leading next and will set the date soon.`
            : canAdmin
              ? 'Kick things off: schedule the first meeting and choose who leads it.'
              : 'An admin will schedule the first meeting soon.'}
        </p>
      </div>
      <div className="min-w-0 bg-lav px-4 py-6 sm:px-6 sm:py-8">
        {canCreateNext ? (
          <>
            <p className="kicker mb-4">Schedule it</p>
            <MeetingForm
              members={members.data}
              showLeaderPicker={canAdmin}
              submitLabel="Schedule & open nominations"
              onSubmit={async (input) => {
                await api.createMeeting(input);
                await onChanged();
              }}
            />
          </>
        ) : (
          <div className="flex h-full flex-col justify-end">
            <p className="kicker">Leading next</p>
            <p className="display mt-2 text-[clamp(2.5rem,5vw,3.5rem)]">{nextLeader?.name ?? 'To be decided'}</p>
          </div>
        )}
      </div>
    </section>
  );
}
