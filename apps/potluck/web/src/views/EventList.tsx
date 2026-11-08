import { ErrorNote, Spinner, useApi, useAsync } from '@stacks/web';
import { COURSE_EMOJI, COURSE_LABEL, COURSES } from '../../../api/model';
import { whenText, type EventSummary } from '../types';

const RSVP_TEXT = { going: "You're going", maybe: 'You said maybe', no: "You can't make it" } as const;

/** Home: upcoming potlucks, soonest first, with how full each course is. */
export function EventList() {
  const api = useApi();
  const { data, error, loading } = useAsync(() => api.get<{ events: EventSummary[]; canHost: boolean }>('/events'));
  if (loading && !data) return <Spinner />;
  return (
    <section>
      <div className="list-head">
        <h2>Coming up</h2>
        {data?.canHost && (
          <a className="button" href="#/new">
            + Host a potluck
          </a>
        )}
      </div>
      <ErrorNote error={error} className="error" />
      {data && !data.events.length && <p className="empty">Nothing planned yet. {data.canHost ? 'Host one!' : 'Check back soon.'}</p>}
      <ul className="cards">
        {data?.events.map((e) => (
          <li key={e.id} className={`card${e.cancelled ? ' cancelled' : ''}`}>
            <a href={`#/e/${e.id}`} className="card-link">
              <p className="when">{whenText(e.startsAt)}</p>
              <h3>
                {e.title}
                {e.cancelled && <span className="tag warn">Cancelled</span>}
              </h3>
              <p className="muted">
                {e.place} · {e.headcount} going
              </p>
              <ul className="chips" aria-label="Dishes so far">
                {COURSES.filter((c) => e.needs[c] > 0).map((c) => (
                  <li key={c} className={`chip${e.filled[c] >= e.needs[c] ? ' full' : ''}`}>
                    {COURSE_EMOJI[c]} {COURSE_LABEL[c]} {e.filled[c]}/{e.needs[c]}
                  </li>
                ))}
              </ul>
              {(e.myRsvp || e.myDishes > 0) && (
                <p className="mine">
                  {e.myRsvp ? RSVP_TEXT[e.myRsvp] : ''}
                  {e.myDishes > 0 ? `${e.myRsvp ? ' · ' : ''}bringing ${e.myDishes} dish${e.myDishes > 1 ? 'es' : ''}` : ''}
                </p>
              )}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
