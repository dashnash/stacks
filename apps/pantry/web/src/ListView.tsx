import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, ErrorNote, Modal, Spinner, useApi, type ChannelStatus } from '@stacks/web';
import { MAX_LIST_NAME, MAX_NAME, MAX_QUANTITY, sortItems, type GroceryItem } from '../../api/routes';
import { AddBar } from './AddBar';
import { useLiveList, type ListState } from './live';
import { SwipeRow } from './SwipeRow';
import { UndoToast, useUndo } from './undo';

const STATUS_LABEL: Record<ChannelStatus, string> = { live: 'Live', connecting: 'Connecting…', offline: 'Offline' };

export function ConnectionDot({ status }: { status: ChannelStatus }) {
  return <span className={`dot dot-${status}`} role="img" aria-label={`Connection: ${STATUS_LABEL[status]}`} title={STATUS_LABEL[status]} />;
}

/** Pull down at the top of the page to refresh (touch screens). */
function usePullToRefresh(onRefresh: () => Promise<void>) {
  const [pull, setPull] = useState(0);
  const startY = useRef<number | null>(null);
  const ref = useRef(onRefresh);
  ref.current = onRefresh;
  useEffect(() => {
    const startFn = (e: TouchEvent) => {
      startY.current = window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0]!.clientY : null;
    };
    const moveFn = (e: TouchEvent) => {
      if (startY.current === null) return;
      setPull(Math.max(0, Math.min(100, e.touches[0]!.clientY - startY.current)));
    };
    const endFn = () => {
      setPull((p) => {
        if (p >= 70) void ref.current();
        return 0;
      });
      startY.current = null;
    };
    window.addEventListener('touchstart', startFn, { passive: true });
    window.addEventListener('touchmove', moveFn, { passive: true });
    window.addEventListener('touchend', endFn);
    return () => {
      window.removeEventListener('touchstart', startFn);
      window.removeEventListener('touchmove', moveFn);
      window.removeEventListener('touchend', endFn);
    };
  }, []);
  return pull;
}

function ItemEditor({ item, onSave, onCancel, onDelete }: { item: GroceryItem; onSave: (name: string, quantity: string) => void; onCancel: () => void; onDelete: () => void }) {
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSave(name.trim(), quantity.trim());
  };
  return (
    <form className="editor" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <label className="sr-only" htmlFor={`edit-name-${item.id}`}>
        Name
      </label>
      <input id={`edit-name-${item.id}`} className="edit-name" autoFocus maxLength={MAX_NAME} value={name} onChange={(e) => setName(e.target.value)} />
      <label className="sr-only" htmlFor={`edit-qty-${item.id}`}>
        Quantity
      </label>
      <input id={`edit-qty-${item.id}`} className="edit-qty" placeholder="Qty" maxLength={MAX_QUANTITY} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      <div className="editor-actions">
        <button type="button" className="danger" onClick={onDelete} aria-label={`Delete ${item.name}`}>
          Delete
        </button>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!name.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}

export function ListView({ listId }: { listId: string }) {
  const api = useApi();
  const live = useLiveList(listId);
  const { state, apply, setItems, refresh } = live;
  const undo = useUndo();
  const [editing, setEditing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pull = usePullToRefresh(refresh);
  const base = `/lists/${encodeURIComponent(listId)}`;

  /** Run a write; show its result (or, if the item is already gone, drop it and catch up). */
  async function write<T extends Partial<ListState>>(request: () => Promise<T>): Promise<T | null> {
    setActionError(null);
    try {
      const res = await request();
      if (res.list && res.items) apply({ list: res.list, items: res.items });
      return res;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setEditing(null);
        await refresh();
      } else setActionError(err as Error);
      return null;
    }
  }

  const restore = (items: GroceryItem[]) => write(() => api.post<ListState>(`${base}/items/restore`, { items })).then(() => undefined);

  async function toggle(item: GroceryItem) {
    const done = !item.done;
    // Show it at once: the row moves while the request is in flight.
    setItems((items) => sortItems(items.map((i) => (i.id === item.id ? { ...i, done, ...(done ? { doneAt: new Date().toISOString() } : { doneAt: undefined }) } : i))));
    const res = await write(() => api.patch<ListState>(`${base}/items/${encodeURIComponent(item.id)}`, { done }));
    if (res) undo.offer({ label: `${done ? 'Checked off' : 'Unchecked'} ${item.name}`, undo: () => restore([item]) });
  }

  async function remove(item: GroceryItem) {
    setEditing(null);
    setItems((items) => items.filter((i) => i.id !== item.id));
    const res = await write(() => api.del<ListState & { removed: GroceryItem }>(`${base}/items/${encodeURIComponent(item.id)}`));
    if (res) undo.offer({ label: `Removed ${item.name}`, undo: () => restore([res.removed]) });
  }

  async function clearComplete() {
    const res = await write(() => api.post<ListState & { removed: GroceryItem[] }>(`${base}/clear-complete`));
    if (res && res.removed.length) undo.offer({ label: `Cleared ${res.removed.length} done ${res.removed.length === 1 ? 'item' : 'items'}`, undo: () => restore(res.removed) });
  }

  async function save(item: GroceryItem, name: string, quantity: string) {
    setEditing(null);
    if (name === item.name && quantity === (item.quantity ?? '')) return;
    await write(() => api.patch<ListState>(`${base}/items/${encodeURIComponent(item.id)}`, { name, quantity }));
  }

  async function add(item: { name: string; quantity?: string }): Promise<boolean> {
    return !!(await write(() => api.post<ListState>(`${base}/items`, { items: [item] })));
  }

  async function toggleMute() {
    if (!state) return;
    const muted = !state.muted;
    live.setMuted(muted);
    try {
      await api.put(`${base}/mute`, { muted });
    } catch (err) {
      live.setMuted(!muted);
      setActionError(err as Error);
    }
  }

  const renameSaved = useRef(false);
  async function rename(e: FormEvent) {
    e.preventDefault();
    // Enter submits and the input's blur follows: save once.
    if (renameSaved.current) return;
    renameSaved.current = true;
    const name = renaming?.trim();
    setRenaming(null);
    if (name && name !== state?.list.name) await write(() => api.patch<{ list: ListState['list'] }>(base, { name }).then((r) => ({ ...r, items: state!.items })));
  }

  async function deleteList() {
    setConfirmDelete(false);
    try {
      await api.del(base);
      window.location.hash = '#/';
    } catch (err) {
      setActionError(err as Error);
    }
  }

  if (live.deleted)
    return (
      <section className="gone">
        <p>This list was deleted.</p>
        <a href="#/">Back to all lists</a>
      </section>
    );
  if (!state) return live.error ? <ErrorNote error={live.error} className="error" /> : <Spinner />;

  const { list, items, muted } = state;
  const done = items.filter((i) => i.done).length;
  return (
    <section className="list" aria-labelledby="list-title">
      {pull > 0 && (
        <p className="pull muted small" style={{ height: pull / 2 }}>
          {pull >= 70 ? 'Release to refresh' : 'Pull to refresh'}
        </p>
      )}
      <div className="list-head">
        <a href="#/" className="back" aria-label="All lists">
          ‹
        </a>
        {renaming !== null ? (
          <form className="rename" onSubmit={rename}>
            <label className="sr-only" htmlFor="rename">
              List name
            </label>
            <input id="rename" autoFocus maxLength={MAX_LIST_NAME} value={renaming} onChange={(e) => setRenaming(e.target.value)} onBlur={rename} />
          </form>
        ) : (
          <h2 id="list-title">
            <button type="button" className="title-button" title="Tap to rename"
              onClick={() => {
                renameSaved.current = false;
                setRenaming(list.name);
              }}
            >
              {list.name}
            </button>
          </h2>
        )}
        <ConnectionDot status={live.status} />
        <button type="button" className="icon" aria-pressed={!muted} aria-label={muted ? `Unmute ${list.name}` : `Mute ${list.name}`} title={muted ? 'Notifications off' : 'Notifications on'} onClick={() => void toggleMute()}>
          {muted ? '🔕' : '🔔'}
        </button>
        <button type="button" className="icon" aria-label={`Delete ${list.name}`} title="Delete list" onClick={() => setConfirmDelete(true)}>
          🗑
        </button>
      </div>
      <ErrorNote error={actionError} className="error" />
      {!items.length && <p className="empty muted">Nothing on the list. Add something below.</p>}
      <ul className="items" aria-label={list.name}>
        {items.map((item) => (
          <SwipeRow key={item.id} done={item.done} onDone={() => void toggle(item)} onRemove={() => void remove(item)}>
            {editing === item.id ? (
              <ItemEditor item={item} onCancel={() => setEditing(null)} onDelete={() => void remove(item)} onSave={(n, q) => void save(item, n, q)} />
            ) : (
              <div className="item">
                <input type="checkbox" className="check" checked={item.done} onChange={() => void toggle(item)} aria-label={`${item.done ? 'Uncheck' : 'Check off'} ${item.name}`} />
                <button type="button" className="item-main" onClick={() => setEditing(item.id)} aria-label={`Edit ${item.name}`}>
                  <span className="item-name">{item.name}</span>
                  {item.quantity && <span className="item-qty">{item.quantity}</span>}
                </button>
              </div>
            )}
          </SwipeRow>
        ))}
      </ul>
      {done > 0 && (
        <button type="button" className="clear" onClick={() => void clearComplete()}>
          Clear complete ({done})
        </button>
      )}
      <p className="hint muted small">Swipe right: done · far left: remove · tap: edit</p>
      <UndoToast undo={undo} />
      <AddBar listId={listId} onAdd={add} />
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${list.name}?`} className="dialog" backdropClassName="backdrop">
        <h3>Delete “{list.name}”?</h3>
        <p>Its {items.length} items and its suggestions go too, for everyone. This can't be undone.</p>
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={() => setConfirmDelete(false)}>
            Keep it
          </button>
          <button type="button" className="danger solid" onClick={() => void deleteList()}>
            Delete list
          </button>
        </div>
      </Modal>
    </section>
  );
}
