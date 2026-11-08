import { useState, type FormEvent } from 'react';
import { ErrorNote, Spinner, useApi, useAsync } from '@stacks/web';
import { COURSE_EMOJI, COURSE_LABEL, COURSES, MAX_GUESTS, TAGS, type Course, type RsvpStatus, type Tag } from '../../../api/model';
import { isOver, whenText, type EventDetail } from '../types';

function useAction(reload: () => Promise<unknown>) {
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (err) {
      setError(err as Error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function RsvpBox({ id, current, guests: currentGuests, reload }: { id: string; current: RsvpStatus | null; guests: number; reload: () => Promise<unknown> }) {
  const api = useApi();
  const { error, busy, run } = useAction(reload);
  const [guests, setGuests] = useState(currentGuests);
  const choose = (status: RsvpStatus, g = guests) => run(() => api.put(`/events/${id}/rsvp`, { status, guests: g }));
  return (
    <section className="panel">
      <h3>Are you coming?</h3>
      <div className="segmented" role="group" aria-label="Your RSVP">
        {(['going', 'maybe', 'no'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={current === s} disabled={busy} onClick={() => void choose(s)}>
            {s === 'going' ? "I'm going" : s === 'maybe' ? 'Maybe' : "Can't make it"}
          </button>
        ))}
      </div>
      {current === 'going' && (
        <label className="inline">
          Bringing guests
          <select
            value={guests}
            disabled={busy}
            onChange={(e) => {
              setGuests(Number(e.target.value));
              void choose('going', Number(e.target.value));
            }}
          >
            {Array.from({ length: MAX_GUESTS + 1 }, (_, n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
      <ErrorNote error={error} className="error" />
    </section>
  );
}

function AddDish({ id, course, reload }: { id: string; course: Course; reload: () => Promise<unknown> }) {
  const api = useApi();
  const { error, busy, run } = useAction(reload);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [serves, setServes] = useState('');
  const [tags, setTags] = useState<Tag[]>([]);
  if (!open)
    return (
      <button type="button" className="add" onClick={() => setOpen(true)}>
        + Bring {COURSE_LABEL[course].toLowerCase().replace(/s$/, '')}
      </button>
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => api.post(`/events/${id}/dishes`, { course, name, tags, ...(serves ? { serves: Number(serves) } : {}) }));
    if (ok) setOpen(false);
  };
  return (
    <form className="dish-form" onSubmit={(e) => void submit(e)}>
      <label>
        What are you bringing?
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={course === 'drinks' ? 'Lemonade' : 'Mac & cheese'} required />
      </label>
      <label>
        Serves (optional)
        <input type="number" min={1} max={100} value={serves} onChange={(e) => setServes(e.target.value)} />
      </label>
      <fieldset>
        <legend>It is…</legend>
        {TAGS.map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={tags.includes(t)} onChange={(e) => setTags(e.target.checked ? [...tags, t] : tags.filter((x) => x !== t))} />
            {t}
          </label>
        ))}
      </fieldset>
      <div className="row">
        <button type="button" className="link" onClick={() => setOpen(false)}>
          Never mind
        </button>
        <button type="submit" className="button" disabled={busy || !name.trim()}>
          Sign up
        </button>
      </div>
      <ErrorNote error={error} className="error" />
    </form>
  );
}

/** One potluck: details, your RSVP, dishes by course (sign up where there's room), who's coming. */
export function EventPage({ id }: { id: string }) {
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => api.get<EventDetail>(`/events/${encodeURIComponent(id)}`), [id]);
  const { error: actionError, run } = useAction(reload);
  if (loading && !data) return <Spinner />;
  if (!data) return <ErrorNote error={error} className="error" />;
  const { event, dishes, rsvps } = data;
  const open = !event.cancelled && !isOver(event);
  const mine = rsvps.find((r) => r.mine);
  const going = rsvps.filter((r) => r.status === 'going');
  const maybe = rsvps.filter((r) => r.status === 'maybe');

  return (
    <article>
      <a href="#/" className="back">
        ← All potlucks
      </a>
      <header className="event-head">
        <p className="when">{whenText(event.startsAt)}</p>
        <h2>
          {event.title}
          {event.cancelled && <span className="tag warn">Cancelled</span>}
          {!event.cancelled && isOver(event) && <span className="tag">Over</span>}
        </h2>
        <p>📍 {event.place}</p>
        {event.notes && <p className="notes">{event.notes}</p>}
        <p className="muted">
          Hosted by {event.hostName} · {data.headcount} going
        </p>
        {data.canEdit && !event.cancelled && (
          <div className="row gap">
            <a className="button secondary" href={`#/e/${event.id}/edit`}>
              Edit
            </a>
            <button
              type="button"
              className="link danger"
              onClick={() => window.confirm(`Cancel ${event.title}? Everyone will see it as cancelled.`) && void run(() => api.post(`/events/${event.id}/cancel`))}
            >
              Cancel potluck
            </button>
          </div>
        )}
      </header>

      {open && <RsvpBox id={event.id} current={mine?.status ?? null} guests={mine?.guests ?? 0} reload={reload} />}

      {COURSES.filter((c) => event.needs[c] > 0).map((c) => {
        const list = dishes.filter((d) => d.course === c);
        const room = event.needs[c] - list.length;
        return (
          <section key={c} className="course" aria-label={COURSE_LABEL[c]}>
            <h3>
              {COURSE_EMOJI[c]} {COURSE_LABEL[c]}{' '}
              <span className={`count${room <= 0 ? ' full' : ''}`}>
                {list.length}/{event.needs[c]}
              </span>
            </h3>
            <ul className="dishes">
              {list.map((d) => (
                <li key={d.id}>
                  <div>
                    <p className="dish-name">
                      {d.name}
                      {d.serves ? <span className="muted"> · serves {d.serves}</span> : null}
                    </p>
                    <p className="muted small">
                      {d.mine ? 'You' : d.bringerName}
                      {d.tags.map((t) => (
                        <span key={t} className="tag diet">
                          {t}
                        </span>
                      ))}
                    </p>
                  </div>
                  {d.canRemove && open && (
                    <button type="button" className="link" aria-label={`Remove ${d.name}`} onClick={() => void run(() => api.del(`/events/${event.id}/dishes/${d.id}`))}>
                      {d.mine ? 'Drop' : 'Remove'}
                    </button>
                  )}
                </li>
              ))}
              {Array.from({ length: Math.max(room, 0) }, (_, i) => (
                <li key={`open${i}`} className="open-slot">
                  Open spot
                </li>
              ))}
            </ul>
            {open && room > 0 && <AddDish id={event.id} course={c} reload={reload} />}
          </section>
        );
      })}
      <ErrorNote error={actionError} className="error" />

      <section className="panel">
        <h3>Who's coming</h3>
        {!going.length && !maybe.length && <p className="muted">No RSVPs yet.</p>}
        {going.length > 0 && (
          <p>
            <strong>Going:</strong> {going.map((r) => (r.mine ? 'You' : r.name) + (r.guests ? ` +${r.guests}` : '')).join(', ')}
          </p>
        )}
        {maybe.length > 0 && (
          <p>
            <strong>Maybe:</strong> {maybe.map((r) => (r.mine ? 'You' : r.name)).join(', ')}
          </p>
        )}
      </section>
    </article>
  );
}
