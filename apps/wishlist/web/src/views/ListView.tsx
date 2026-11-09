import { useState, type FormEvent } from 'react';
import { ErrorNote, Spinner, useApi, useAsync } from '@stacks/web';
import { PRIORITIES, PRIORITY_LABEL, type Priority, type WishItem } from '../../../api/model';
import { money, type ListPage, type OtherItem } from '../types';

function useRun(reload: () => Promise<unknown>) {
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

function ItemForm({ initial, onDone, reload }: { initial?: WishItem; onDone: () => void; reload: () => Promise<unknown> }) {
  const api = useApi();
  const { error, busy, run } = useRun(reload);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [link, setLink] = useState(initial?.link ?? '');
  const [price, setPrice] = useState(initial?.price?.toString() ?? '');
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? 'like');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { title, link: link || undefined, price: price ? Number(price) : undefined, priority, notes };
    const ok = await run(() => (initial ? api.patch(`/me/items/${initial.id}`, body) : api.post('/me/items', body)));
    if (ok) onDone();
  };
  return (
    <form className="card form" onSubmit={(e) => void submit(e)}>
      <label>
        What is it?
        <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} required placeholder="Wool socks" />
      </label>
      <label>
        Link (optional)
        <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" />
      </label>
      <div className="two">
        <label>
          About how much? ($)
          <input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label>
          How much do you want it?
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Notes (size, color…)
        <input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <ErrorNote error={error} className="error" />
      <div className="row">
        <button type="button" className="link" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="button" disabled={busy || !title.trim()}>
          {initial ? 'Save' : 'Add to my list'}
        </button>
      </div>
    </form>
  );
}

function NoteEditor({ note, reload }: { note: string; reload: () => Promise<unknown> }) {
  const api = useApi();
  const { error, busy, run } = useRun(reload);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note);
  if (!editing)
    return (
      <div className="note">
        <p>{note || <span className="muted">Add a note: sizes, favorite colors, things you don't want.</span>}</p>
        <button type="button" className="link" onClick={() => setEditing(true)}>
          {note ? 'Edit note' : 'Add note'}
        </button>
      </div>
    );
  return (
    <form
      className="note"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => api.put('/me/note', { note: text })).then((ok) => ok && setEditing(false));
      }}
    >
      <label>
        Note for your family
        <textarea value={text} maxLength={300} rows={2} onChange={(e) => setText(e.target.value)} />
      </label>
      <ErrorNote error={error} className="error" />
      <button type="submit" className="button" disabled={busy}>
        Save note
      </button>
    </form>
  );
}

function ItemBody({ item }: { item: WishItem }) {
  return (
    <div className="item-body">
      <p className="item-title">
        {item.link ? (
          <a href={item.link} target="_blank" rel="noreferrer">
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </p>
      <p className="muted small">
        <span className={`prio ${item.priority}`}>{PRIORITY_LABEL[item.priority]}</span>
        {item.price !== null && ` · ${money(item.price)}`}
        {item.notes && ` · ${item.notes}`}
      </p>
    </div>
  );
}

/** One person's list. Yours: edit it, with no hint of what's claimed. Someone else's: claim things. */
export function ListView({ listId }: { listId: string }) {
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => api.get<ListPage>(`/lists/${encodeURIComponent(listId)}`), [listId]);
  const { error: actionError, busy, run } = useRun(reload);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  if (loading && !data) return <Spinner />;
  if (!data) return <ErrorNote error={error} className="error" />;
  const { list, items, canModerate } = data;
  const base = `/lists/${list.listId}/items`;

  return (
    <section>
      <a href="#/" className="back">
        ← All lists
      </a>
      <h2>{list.mine ? 'Your list' : `${list.ownerName}'s list`}</h2>
      {list.mine ? <NoteEditor note={list.note} reload={reload} /> : list.note && <p className="note">{list.note}</p>}
      {list.mine && <p className="surprise">🎁 No peeking: you'll never see what's been claimed from your list.</p>}

      {list.mine && !adding && (
        <button type="button" className="button add" onClick={() => setAdding(true)}>
          + Add something
        </button>
      )}
      {list.mine && adding && <ItemForm onDone={() => setAdding(false)} reload={reload} />}

      {!items.length && <p className="empty">{list.mine ? 'Your list is empty.' : `${list.ownerName} hasn't added anything yet.`}</p>}
      <ul className="items">
        {items.map((item) => {
          if (list.mine) {
            if (editing === item.id) return <li key={item.id}><ItemForm initial={item} onDone={() => setEditing(null)} reload={reload} /></li>;
            return (
              <li key={item.id} className="card item">
                <ItemBody item={item} />
                <div className="actions">
                  <button type="button" className="link" onClick={() => setEditing(item.id)} aria-label={`Edit ${item.title}`}>
                    Edit
                  </button>
                  <button type="button" className="link danger" disabled={busy} onClick={() => void run(() => api.del(`/me/items/${item.id}`))} aria-label={`Remove ${item.title}`}>
                    Remove
                  </button>
                </div>
              </li>
            );
          }
          const o = item as OtherItem;
          return (
            <li key={o.id} className={`card item ${o.status}`}>
              <ItemBody item={o} />
              <div className="actions">
                {o.status === 'available' && (
                  <button type="button" className="button small" disabled={busy} onClick={() => void run(() => api.post(`${base}/${o.id}/claim`))} aria-label={`Claim ${o.title}`}>
                    I'll get this
                  </button>
                )}
                {o.status === 'mine' && (
                  <>
                    <span className="pill mine">You're getting this</span>
                    <label className="check">
                      <input type="checkbox" checked={!!o.bought} disabled={busy} onChange={(e) => void run(() => api.patch(`${base}/${o.id}/claim`, { bought: e.target.checked }))} />
                      Bought
                    </label>
                    <button type="button" className="link" disabled={busy} onClick={() => void run(() => api.del(`${base}/${o.id}/claim`))} aria-label={`Unclaim ${o.title}`}>
                      Unclaim
                    </button>
                  </>
                )}
                {o.status === 'taken' && <span className="pill taken">Someone's got it</span>}
                {canModerate && (
                  <button type="button" className="link danger" disabled={busy} onClick={() => window.confirm(`Remove "${o.title}" from ${list.ownerName}'s list?`) && void run(() => api.del(`${base}/${o.id}`))} aria-label={`Remove ${o.title} (organizer)`}>
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <ErrorNote error={actionError} className="error" />
    </section>
  );
}
