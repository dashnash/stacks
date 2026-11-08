import { useState, type FormEvent } from 'react';
import { ErrorNote, Spinner, useApi, useAsync } from '@stacks/web';
import { COURSE_EMOJI, COURSE_LABEL, COURSES, MAX_PER_COURSE, type Needs, type PotluckEvent } from '../../../api/model';

/** `datetime-local` works in the browser's time zone; the API stores ISO (UTC). */
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function Form({ initial, onSaved }: { initial?: PotluckEvent; onSaved: (id: string) => void }) {
  const api = useApi();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [startsAt, setStartsAt] = useState(initial ? toLocalInput(initial.startsAt) : '');
  const [place, setPlace] = useState(initial?.place ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [needs, setNeeds] = useState<Needs>(initial?.needs ?? { mains: 3, sides: 3, desserts: 2, drinks: 2 });
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { title, startsAt: new Date(startsAt).toISOString(), place, notes, needs };
      const res = initial ? await api.patch<{ event: PotluckEvent }>(`/events/${initial.id}`, body) : await api.post<{ event: PotluckEvent }>('/events', body);
      onSaved(res.event.id);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel event-form" onSubmit={(e) => void submit(e)}>
      <label>
        Name
        <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Fall Harvest Potluck" required />
      </label>
      <label>
        When
        <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
      </label>
      <label>
        Where (only members see this)
        <input value={place} maxLength={200} onChange={(e) => setPlace(e.target.value)} placeholder="14 Maple Court" required />
      </label>
      <label>
        Notes
        <textarea value={notes} maxLength={1000} rows={3} onChange={(e) => setNotes(e.target.value)} placeholder="Bring a chair!" />
      </label>
      <fieldset className="needs">
        <legend>How many of each?</legend>
        {COURSES.map((c) => (
          <label key={c}>
            {COURSE_EMOJI[c]} {COURSE_LABEL[c]}
            <input type="number" min={0} max={MAX_PER_COURSE} value={needs[c]} onChange={(e) => setNeeds({ ...needs, [c]: Math.max(0, Math.min(MAX_PER_COURSE, Number(e.target.value) || 0)) })} />
          </label>
        ))}
      </fieldset>
      <ErrorNote error={error} className="error" />
      <div className="row">
        <a href={initial ? `#/e/${initial.id}` : '#/'} className="link">
          Back
        </a>
        <button type="submit" className="button" disabled={busy}>
          {initial ? 'Save changes' : 'Post potluck'}
        </button>
      </div>
      {!initial && <p className="muted small">Everyone in Potluck gets a notification when you post.</p>}
    </form>
  );
}

export function NewEvent() {
  return (
    <section>
      <a href="#/" className="back">
        ← All potlucks
      </a>
      <h2>Host a potluck</h2>
      <Form onSaved={(id) => (window.location.hash = `#/e/${id}`)} />
    </section>
  );
}

export function EditEvent({ id }: { id: string }) {
  const api = useApi();
  const { data, error } = useAsync(() => api.get<{ event: PotluckEvent }>(`/events/${encodeURIComponent(id)}`), [id]);
  if (error) return <ErrorNote error={error} className="error" />;
  if (!data) return <Spinner />;
  return (
    <section>
      <h2>Edit {data.event.title}</h2>
      <Form initial={data.event} onSaved={(saved) => (window.location.hash = `#/e/${saved}`)} />
    </section>
  );
}
