import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useApi } from '@stacks/web';
import { MAX_NAME, MAX_QUANTITY, type HistoryEntry } from '../../api/routes';

/** How far the on-screen keyboard covers the page, so the bar can sit on top of it (iOS Safari). */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}

/**
 * The add bar pinned to the bottom: name, quantity, Add. Typing a name suggests up to 8 names from
 * the list's history; picking one fills the name and its last quantity. ✕ forgets a suggestion.
 */
export function AddBar({ listId, onAdd }: { listId: string; onAdd: (item: { name: string; quantity?: string }) => Promise<boolean> }) {
  const api = useApi();
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [suggestions, setSuggestions] = useState<HistoryEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const asked = useRef(0);
  const inset = useKeyboardInset();

  useEffect(() => {
    const q = name.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    const n = ++asked.current;
    const t = setTimeout(() => {
      api
        .get<{ suggestions: HistoryEntry[] }>(`/lists/${encodeURIComponent(listId)}/suggestions?q=${encodeURIComponent(q)}`)
        .then((r) => n === asked.current && setSuggestions(r.suggestions))
        .catch(() => n === asked.current && setSuggestions([]));
    }, 120);
    return () => clearTimeout(t);
  }, [api, listId, name]);

  // Hide a suggestion that is exactly what's typed (nothing left to complete).
  const shown = open ? suggestions.filter((s) => !(s.name === name.trim() && (s.lastQuantity ?? '') === quantity.trim())) : [];

  function pick(s: HistoryEntry) {
    setName(s.name);
    setQuantity(s.lastQuantity ?? '');
    setOpen(false);
    setActive(-1);
    qtyRef.current?.focus();
  }

  async function forget(s: HistoryEntry) {
    setSuggestions((list) => list.filter((x) => x.key !== s.key));
    await api.del(`/lists/${encodeURIComponent(listId)}/suggestions/${encodeURIComponent(s.key)}`).catch(() => undefined);
    nameRef.current?.focus();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return; // whitespace-only names are ignored
    setBusy(true);
    const q = quantity.trim();
    const ok = await onAdd({ name: n, ...(q ? { quantity: q } : {}) });
    setBusy(false);
    if (ok) {
      setName('');
      setQuantity('');
      setOpen(false);
      setActive(-1);
      nameRef.current?.focus();
    }
  }

  function keys(e: KeyboardEvent<HTMLInputElement>) {
    if (!shown.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % shown.length : (i - 1 + shown.length) % shown.length));
    } else if (e.key === 'Enter' && active >= 0 && shown[active]) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <form className="addbar" onSubmit={submit} style={inset ? { bottom: inset } : undefined}>
      {shown.length > 0 && (
        <ul className="suggest" aria-label="Suggestions">
          {shown.map((s, i) => (
            <li key={s.key} className={i === active ? 'active' : undefined}>
              <button type="button" className="suggest-pick" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
                <span>{s.name}</span>
                {s.lastQuantity && <span className="muted">{s.lastQuantity}</span>}
              </button>
              <button type="button" className="suggest-forget" aria-label={`Forget ${s.name}`} onMouseDown={(e) => e.preventDefault()} onClick={() => void forget(s)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="addbar-row">
        <label className="sr-only" htmlFor="add-name">
          Item
        </label>
        <input
          id="add-name"
          ref={nameRef}
          className="add-name"
          placeholder="Add an item"
          autoComplete="off"
          enterKeyHint="done"
          maxLength={MAX_NAME}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={keys}
        />
        <label className="sr-only" htmlFor="add-qty">
          Quantity
        </label>
        <input id="add-qty" ref={qtyRef} className="add-qty" placeholder="Qty" autoComplete="off" maxLength={MAX_QUANTITY} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <button type="submit" className="primary" disabled={busy || !name.trim()}>
          Add
        </button>
      </div>
    </form>
  );
}
