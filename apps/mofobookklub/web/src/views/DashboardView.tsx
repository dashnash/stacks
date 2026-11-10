import { isAdmin } from '../lib/types';
import { useCallback, useEffect, useState } from 'react';
import { BookHistory } from '../components/BookHistory';
import { Header } from '../components/Header';
import { Marquee, marqueeItems } from '../components/Marquee';
import { MeetingActions, ScheduleNextAction } from '../components/MeetingActions';
import { NextMeetingHero } from '../components/NextMeetingHero';
import { NoMeeting } from '../components/NoMeeting';
import { QuoteBand } from '../components/QuoteBand';
import { ErrorNote, Spinner } from '../components/ui';
import { LineupPanel } from '../components/LineupPanel';
import { useApi } from '../lib/auth';
import { useRoute } from '../lib/route';
import { AdminView } from './AdminView';
import { BookView } from './BookView';
import { LegalLinks } from './SignInView';
import type { User } from '../lib/types';
import { useAsync } from '../lib/useAsync';

export function DashboardView({ user }: { user: User }) {
  const api = useApi();
  const canAdmin = isAdmin(user);
  const next = useAsync(() => api.nextMeeting(), []);
  const history = useAsync(() => api.history(), []);
  const lineup = useAsync(() => api.lineup(), []);
  const pending = useAsync(
    () => (canAdmin ? api.access().then((r) => r.pending) : Promise.resolve([])),
    [canAdmin],
  );
  const route = useRoute();

  // Coming back from a book page via "This month" / "Shelf": jump to that section.
  const anchor = route.name === 'home' ? route.anchor : undefined;
  useEffect(() => {
    if (anchor) document.getElementById(anchor)?.scrollIntoView();
  }, [anchor]);

  const refresh = useCallback(async () => {
    await Promise.all([next.reload(), history.reload(), lineup.reload()]);
  }, [next, history, lineup]);

  const data = next.data;
  const meeting = data?.meeting ?? null;

  return (
    <div className="min-h-screen">
      <Header
        onAdmin={canAdmin ? () => (window.location.hash = '#/admin') : undefined}
        pendingCount={pending.data?.length ?? 0}
        // Only the people the meeting is waiting on get the header strip; admins step in from the admin page.
        meetingActions={
          meeting && meeting.leaderId === user.id ? (
            <MeetingActions meeting={meeting} user={user} onChanged={refresh} />
          ) : data && !data.meeting && data.nextLeader?.id === user.id ? (
            <ScheduleNextAction youAreNext />
          ) : undefined
        }
      />

      {route.name === 'book' && <BookView isbn={route.isbn} onChanged={() => void refresh()} />}
      {route.name === 'admin' && (
        <AdminView
          user={user}
          tab={route.tab}
          meeting={meeting}
          nextLeader={data && !data.meeting ? data.nextLeader : null}
          pending={pending.data ?? []}
          onChanged={async () => {
            await Promise.all([pending.reload(), refresh()]);
          }}
        />
      )}
      {/* Hidden rather than unmounted on a book page, so coming back is instant and keeps its place. */}
      <main hidden={route.name !== 'home'}>
        {(next.error || (!data && next.loading)) && (
          <div className="px-4 py-6 sm:px-6">
            <ErrorNote error={next.error} />
            {!data && next.loading && <Spinner />}
          </div>
        )}

        {meeting && <NextMeetingHero meeting={meeting} onChanged={() => void next.reload()} />}
        {data && !data.meeting && (
          <NoMeeting user={user} nextLeader={data.nextLeader} canCreateNext={data.canCreateNext} onChanged={refresh} />
        )}
        <Marquee items={marqueeItems(meeting, lineup.data)} label={meeting?.book ? 'Now reading' : 'On The Lineup'} />

        <div className="grid border-b-2 border-ink lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="border-b-2 border-ink lg:border-b-0 lg:border-r-2">
            {lineup.data ? (
              <LineupPanel
                lineup={lineup.data}
                meetingTitle={meeting?.title}
                onChanged={refresh}
                onPick={
                  meeting && lineup.data.canPick
                    ? async (nominationId) => {
                        await api.chooseBook(meeting.id, { nominationId });
                      }
                    : undefined
                }
              />
            ) : (
              <div className="panel">
                <ErrorNote error={lineup.error} />
                {lineup.loading && <Spinner />}
              </div>
            )}
          </div>
          {history.data ? (
            <BookHistory meetings={history.data.meetings} onChanged={() => void history.reload()} />
          ) : (
            <div className="panel">
              <ErrorNote error={history.error} />
            </div>
          )}
        </div>

        <QuoteBand />
      </main>
      <LegalLinks />
    </div>
  );
}
