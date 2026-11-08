import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useApi } from '../lib/auth';
import { formatPublished } from '../lib/format';
import type { Book, BookPageBook, BookUpdate, CoverCandidate, Edition } from '../lib/types';
import { BookCover, ErrorNote, Modal, Spinner } from './ui';

export type CoverChoice = { kind: 'keep' } | { kind: 'none' } | { kind: 'url'; url: string; width?: number };

const TEXT_FIELDS = ['title', 'author', 'publisher', 'publishedDate', 'description'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

export interface FormState {
  title: string;
  author: string;
  publisher: string;
  publishedDate: string;
  pageCount: string;
  subjects: string;
  description: string;
  amazonUrl: string;
}

export function formFrom(book: Pick<Book, TextField | 'pageCount' | 'subjects'>, amazonUrl = ''): FormState {
  return {
    title: book.title ?? '',
    author: book.author ?? '',
    publisher: book.publisher ?? '',
    publishedDate: book.publishedDate ?? '',
    pageCount: book.pageCount ? String(book.pageCount) : '',
    subjects: (book.subjects ?? []).join(', '),
    description: book.description ?? '',
    amazonUrl,
  };
}

/** Only what the editor changed, so saving never rewrites untouched fields. */
export function bookChanges(original: FormState, form: FormState, cover: CoverChoice): BookUpdate {
  const changes: BookUpdate = {};
  for (const field of TEXT_FIELDS) {
    if (form[field].trim() !== original[field].trim()) {
      (changes as Record<string, unknown>)[field] =
        form[field].trim() || (field === 'title' || field === 'author' ? '' : null);
    }
  }
  if (form.pageCount.trim() !== original.pageCount.trim()) {
    changes.pageCount = form.pageCount.trim() ? Number(form.pageCount) : null;
  }
  const subjects = (text: string) =>
    text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (subjects(form.subjects).join('|') !== subjects(original.subjects).join('|')) {
    const list = subjects(form.subjects);
    changes.subjects = list.length ? list : null;
  }
  if (form.amazonUrl.trim() !== original.amazonUrl.trim()) changes.amazonUrl = form.amazonUrl.trim() || null;
  if (cover.kind === 'none') changes.coverUrl = null;
  if (cover.kind === 'url') {
    changes.coverUrl = cover.url;
    if (cover.width) changes.coverWidth = cover.width;
  }
  return changes;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="kicker">{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="mt-1 block text-xs text-ink/60">{hint}</span>}
    </label>
  );
}

/** A cover the editor can pick: an image (or "no image"), outlined when chosen. */
export function CoverOption({
  selected,
  onSelect,
  label,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      title={label}
      onClick={onSelect}
      className={`flex flex-col items-stretch gap-1 border-2 p-1 text-left text-[0.7rem] font-semibold leading-tight ${
        selected ? 'border-coral bg-coral/15' : 'border-transparent hover:border-ink/30'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Popup for fixing a book (for admins and the book's nominator): its details, its cover (pick one the sources have,
 * paste an image link, or use the typeset cover) and its Amazon link.
 */
export function BookEditor({
  book,
  onClose,
  onSaved,
  title = 'Edit book',
  intro,
  autoLookup = false,
  cancelLabel = 'Cancel',
}: {
  book: BookPageBook;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  /** Popup title, e.g. "Check the details" right after nominating. */
  title?: string;
  /** A line above the controls, e.g. why the editor opened. */
  intro?: ReactNode;
  /** Look the book up as soon as the editor opens (covers and details to choose from). */
  autoLookup?: boolean;
  cancelLabel?: string;
}) {
  const api = useApi();
  const [original] = useState(() => formFrom(book, book.amazonUrlIsCustom ? book.amazonUrl : ''));
  const [form, setForm] = useState(original);
  const [cover, setCover] = useState<CoverChoice>({ kind: 'keep' });
  const [pasted, setPasted] = useState('');
  const [lookup, setLookup] = useState<{ found: Book | null; covers: CoverCandidate[] } | null>(null);
  // Free-text search for other editions, when the ISBN's own record is wrong or thin.
  const [terms, setTerms] = useState(() => `${book.title} ${book.author}`);
  const [editions, setEditions] = useState<Edition[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [looking, setLooking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (autoLookup) void lookUp();
    // Once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (field: keyof FormState) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function lookUp() {
    setLooking(true);
    setError(null);
    try {
      setLookup(await api.lookUpBook(book.isbn));
    } catch (err) {
      setError(err as Error);
    } finally {
      setLooking(false);
    }
  }

  async function searchEditions() {
    const q = terms.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    try {
      setEditions((await api.lookUpBook(book.isbn, q)).editions);
    } catch (err) {
      setError(err as Error);
    } finally {
      setSearching(false);
    }
  }

  /** Replace the form's details with what the sources say (they still have to save). */
  function applyFound(found: Book) {
    setForm((f) => ({
      ...formFrom({ ...found, title: found.title || f.title, author: found.author || f.author }),
      amazonUrl: f.amazonUrl,
    }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const changes = bookChanges(original, form, cover);
    if (Object.keys(changes).length === 0) return onClose();
    setSaving(true);
    setError(null);
    try {
      await api.updateBook(book.isbn, changes);
      await onSaved();
    } catch (err) {
      setError(err as Error);
      setSaving(false);
    }
  }

  const preview: Book =
    cover.kind === 'none'
      ? { ...book, coverUrl: undefined }
      : cover.kind === 'url'
        ? { ...book, coverUrl: cover.url }
        : book;
  const isChosen = (url: string) => cover.kind === 'url' && cover.url === url;

  return (
    <Modal open onClose={onClose} title={title}>
      <form onSubmit={save} className="space-y-5">
        {intro && <p className="leading-relaxed">{intro}</p>}
        {/* Cover and lookup first: picking the right edition is usually the main job. */}
        <fieldset className="border-b-2 border-ink pb-5">
          <legend className="kicker pr-2">Cover</legend>
          <div className="flex gap-4">
            <BookCover key={preview.coverUrl ?? 'none'} book={preview} className="w-24" size="sm" />
            <div className="min-w-0 flex-1 space-y-2 text-sm">
              <p className="text-ink/70">
                {cover.kind === 'keep'
                  ? book.coverUrl
                    ? `Current cover${book.coverWidth ? `, ${book.coverWidth}px wide` : ''}${book.coverPinned ? ' (chosen by hand)' : ''}.`
                    : 'No image: the typeset cover is shown.'
                  : cover.kind === 'none'
                    ? 'Will use the typeset cover.'
                    : 'Will use the chosen image.'}
              </p>
              <div className="flex gap-2">
                <input
                  className="input !py-1.5"
                  type="url"
                  inputMode="url"
                  placeholder="Paste an image link (https://…)"
                  aria-label="Cover image link"
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-ghost !px-3 !py-1.5"
                  disabled={!pasted.trim()}
                  onClick={() => setCover({ kind: 'url', url: pasted.trim() })}
                >
                  Use
                </button>
              </div>
              {cover.kind !== 'keep' && (
                <button type="button" className="kicker hover:text-coral" onClick={() => setCover({ kind: 'keep' })}>
                  Undo cover change
                </button>
              )}
            </div>
          </div>

          <div className="mt-4">
            <button type="button" className="btn-ghost !px-4 !py-1.5" onClick={() => void lookUp()} disabled={looking}>
              {lookup ? 'Look up by ISBN again' : 'Find covers & details'}
            </button>
            {looking && (
              <div className="mt-3">
                <Spinner label="Asking Open Library and Google Books" />
              </div>
            )}
          </div>
          {lookup && !looking && (
            <div className="mt-3 space-y-3">
              <div role="group" aria-label="Covers found" className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {lookup.covers.map((c) => (
                  <CoverOption
                    key={c.url}
                    selected={isChosen(c.url)}
                    onSelect={() => setCover({ kind: 'url', url: c.url, width: c.width || undefined })}
                    label={`${c.source} cover, ${c.width ? `${c.width}px wide` : 'size unknown'}`}
                  >
                    <img
                      src={c.url}
                      alt=""
                      loading="lazy"
                      className="aspect-[2/3] w-full border-2 border-ink object-cover"
                    />
                    <span>
                      {c.width ? `${c.width}px` : '?'} · {c.source}
                    </span>
                  </CoverOption>
                ))}
                <CoverOption
                  selected={cover.kind === 'none'}
                  onSelect={() => setCover({ kind: 'none' })}
                  label="No image (typeset cover)"
                >
                  <BookCover book={{ ...book, coverUrl: undefined }} className="w-full" size="sm" />
                  <span>No image</span>
                </CoverOption>
              </div>
              {lookup.covers.length === 0 && (
                <p className="text-sm text-ink/70">No covers found. Paste a link instead.</p>
              )}
              {lookup.found ? (
                <button
                  type="button"
                  className="kicker underline hover:text-coral"
                  onClick={() => applyFound(lookup.found!)}
                >
                  Use these details in the form below (then save)
                </button>
              ) : (
                <p className="text-sm text-ink/70">The sources have no details for this ISBN.</p>
              )}
            </div>
          )}

          <div className="mt-5 space-y-2">
            <label htmlFor={`edition-search-${book.isbn}`} className="kicker block">
              Not right? Search other editions
            </label>
            <div className="flex gap-2">
              <input
                id={`edition-search-${book.isbn}`}
                className="input !py-1.5"
                type="search"
                value={terms}
                maxLength={200}
                placeholder="Title, author, publisher…"
                onChange={(e) => setTerms(e.target.value)}
                onKeyDown={(e) => {
                  // Enter searches here instead of saving the whole form.
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void searchEditions();
                  }
                }}
              />
              <button
                type="button"
                className="btn-ghost shrink-0 !px-4 !py-1.5"
                onClick={() => void searchEditions()}
                disabled={searching || !terms.trim()}
              >
                Search
              </button>
            </div>
            {searching && <Spinner label="Searching Open Library and Google Books" />}
            {editions && !searching && editions.length === 0 && (
              <p className="text-sm text-ink/70">Nothing found. Try fewer or different words.</p>
            )}
            {editions && !searching && editions.length > 0 && (
              <ul aria-label="Editions found" className="divide-y divide-ink/15 border-y-2 border-ink">
                {editions.map((e, i) => {
                  const details = [
                    e.publisher,
                    e.publishedDate && formatPublished(e.publishedDate),
                    e.pageCount && `${e.pageCount} pages`,
                    e.isbn && `ISBN ${e.isbn}`,
                  ].filter(Boolean);
                  const chosen = !!e.coverUrl && isChosen(e.coverUrl);
                  return (
                    <li key={`${e.source}-${e.isbn ?? i}-${i}`} className="flex gap-3 py-3">
                      <BookCover
                        book={{ isbn: e.isbn ?? book.isbn, title: e.title, author: e.author, coverUrl: e.coverUrl }}
                        className="w-14"
                        compact
                      />
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="font-semibold leading-tight">{e.title}</p>
                        <p className="leading-tight text-ink/80">{e.author}</p>
                        <p className="mt-0.5 text-xs text-ink/60">
                          {[e.source, ...details, e.coverWidth ? `cover ${e.coverWidth}px` : '']
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          {e.coverUrl && (
                            <button
                              type="button"
                              aria-pressed={chosen}
                              className={`!px-3 !py-0.5 text-xs ${chosen ? 'btn-primary' : 'btn-ghost'}`}
                              onClick={() =>
                                setCover({ kind: 'url', url: e.coverUrl!, width: e.coverWidth || undefined })
                              }
                            >
                              {chosen ? 'Cover chosen' : 'Use cover'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn-ghost !px-3 !py-0.5 text-xs"
                            onClick={() => applyFound({ ...e, isbn: book.isbn })}
                          >
                            Use details
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title">
            <input className="input" value={form.title} onChange={set('title')} required maxLength={300} />
          </Field>
          <Field label="Author">
            <input className="input" value={form.author} onChange={set('author')} required maxLength={300} />
          </Field>
          <Field label="Publisher">
            <input className="input" value={form.publisher} onChange={set('publisher')} maxLength={200} />
          </Field>
          <Field label="Published" hint="e.g. 2021-05-04, or just 2021">
            <input className="input" value={form.publishedDate} onChange={set('publishedDate')} maxLength={40} />
          </Field>
          <Field label="Pages">
            <input
              className="input"
              type="number"
              min={1}
              inputMode="numeric"
              value={form.pageCount}
              onChange={set('pageCount')}
            />
          </Field>
          <Field label="Subjects" hint="Separated by commas">
            <input className="input" value={form.subjects} onChange={set('subjects')} />
          </Field>
        </div>
        <Field label="Description">
          <textarea
            className="input min-h-[7rem] resize-y"
            value={form.description}
            onChange={set('description')}
            maxLength={5000}
          />
        </Field>
        <Field
          label="Amazon link"
          hint={`Leave empty to use ${book.amazonUrlIsCustom ? 'the link built from the ISBN' : book.amazonUrl}`}
        >
          <input
            className="input"
            type="url"
            inputMode="url"
            placeholder="https://www.amazon.com/…"
            value={form.amazonUrl}
            onChange={set('amazonUrl')}
          />
        </Field>

        <ErrorNote error={error} />
        <div className="flex justify-end gap-2 border-t-2 border-ink pt-4">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {cancelLabel}
          </button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
