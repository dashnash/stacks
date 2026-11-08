import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApi } from '../lib/auth';
import { formatPublished } from '../lib/format';
import type { Edition } from '../lib/types';
import { bookChanges, CoverOption, Field, formFrom, type CoverChoice, type FormState } from './BookEditor';
import { BookCover, ErrorNote, Modal, Spinner } from './ui';

/** "Dune: Deluxe Edition" and "Dune (Penguin Classics)" are both "dune": their covers are worth offering. */
const baseTitle = (title: string) =>
  title
    .toLowerCase()
    .split(/[:(]/)[0]!
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const coverOf = (e: Edition): CoverChoice =>
  e.coverUrl ? { kind: 'url', url: e.coverUrl, width: e.coverWidth || undefined } : { kind: 'none' };

/**
 * The nominate screen: search by title and/or author (Google Books results first), choose the book, check its cover
 * and details, then nominate it. The details are saved onto the book as the nominator chose them.
 */
export function NominateBook({
  initialQuery,
  onLineup,
  onClose,
  onNominated,
}: {
  initialQuery: string;
  /** ISBNs already on The Lineup (they can't be nominated twice). */
  onLineup: Set<string>;
  onClose: () => void;
  onNominated: () => Promise<void> | void;
}) {
  const api = useApi();
  const [terms, setTerms] = useState(initialQuery);
  const [editions, setEditions] = useState<Edition[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<Edition | null>(null);
  const [form, setForm] = useState<FormState>(() => formFrom({ title: '', author: '' }));
  const [cover, setCover] = useState<CoverChoice>({ kind: 'none' });
  const [pasted, setPasted] = useState('');
  const [saving, setSaving] = useState(false);
  // Set once the nomination exists, so a failed details save can be retried without nominating twice.
  const [nominated, setNominated] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const detailsRef = useRef<HTMLFieldSetElement>(null);

  useEffect(() => {
    void search(initialQuery);
    // Once, with the words typed on the shelf.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function search(q: string) {
    q = q.trim();
    if (q.length < 2) return;
    setSearching(true);
    setError(null);
    try {
      setEditions((await api.searchEditions(q)).editions);
    } catch (err) {
      setError(err as Error);
    } finally {
      setSearching(false);
    }
  }

  function choose(e: Edition) {
    setChosen(e);
    setForm(formFrom(e));
    setCover(coverOf(e));
    setPasted('');
    setError(null);
    // The cover and details are below the results: bring them into view.
    requestAnimationFrame(() => detailsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
  }

  const set = (field: keyof FormState) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function nominate(e: FormEvent) {
    e.preventDefault();
    if (!chosen?.isbn) return;
    const isbn = chosen.isbn;
    setSaving(true);
    setError(null);
    try {
      if (!nominated) {
        await api.nominate(isbn);
        setNominated(true);
      }
      // The club's copy of the book is looked up on its own: make it match what the nominator chose.
      const details = await api.bookDetails(isbn).catch(() => null);
      if (details?.canEdit) {
        const stored = details.book;
        const original = formFrom(stored, stored.amazonUrlIsCustom ? stored.amazonUrl : '');
        const sameCover =
          (cover.kind === 'url' && cover.url === stored.coverUrl) || (cover.kind === 'none' && !stored.coverUrl);
        const changes = bookChanges(original, { ...form, amazonUrl: original.amazonUrl }, sameCover ? { kind: 'keep' } : cover);
        if (Object.keys(changes).length > 0) await api.updateBook(isbn, changes);
      }
      await onNominated();
    } catch (err) {
      setError(err as Error);
      setSaving(false);
    }
  }

  const preview = {
    isbn: chosen?.isbn ?? '',
    title: form.title || chosen?.title || '',
    author: form.author || chosen?.author || '',
    coverUrl: cover.kind === 'url' ? cover.url : undefined,
  };
  // Other covers for the same book (other editions in the results), each offered once.
  const covers = chosen
    ? [
        ...new Map(
          (editions ?? [])
            .filter((e) => e.coverUrl && baseTitle(e.title) === baseTitle(chosen.title))
            .map((e) => [e.coverUrl!, e]),
        ).values(),
      ]
    : [];
  const alreadyOn = !!chosen?.isbn && onLineup.has(chosen.isbn);

  return (
    <Modal open onClose={onClose} title="Nominate a book">
      <div className="space-y-5">
        <form
          role="search"
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void search(terms);
          }}
        >
          <label htmlFor="nominate-search" className="kicker block">
            Modify search
          </label>
          <div className="flex gap-2">
            <input
              id="nominate-search"
              className="input"
              type="search"
              value={terms}
              maxLength={200}
              placeholder="Title and/or author"
              onChange={(e) => setTerms(e.target.value)}
            />
            <button type="submit" className="btn-primary shrink-0" disabled={searching || terms.trim().length < 2}>
              Search
            </button>
          </div>
        </form>

        {searching && <Spinner label="Searching Google Books and Open Library" />}
        {editions && !searching && editions.length === 0 && (
          <p className="voice text-lg">Nothing found. Try fewer or different words.</p>
        )}
        {editions && !searching && editions.length > 0 && (
          <ul
            aria-label="Search results"
            className="max-h-[22rem] divide-y divide-ink/15 overflow-y-auto border-y-2 border-ink"
          >
            {editions.map((e, i) => {
              const isChosen = chosen === e;
              const onIt = !!e.isbn && onLineup.has(e.isbn);
              const details = [
                e.source,
                e.publisher,
                e.publishedDate && formatPublished(e.publishedDate),
                e.pageCount && `${e.pageCount} pages`,
              ].filter(Boolean);
              return (
                <li
                  key={`${e.source}-${e.isbn ?? i}`}
                  className={`flex items-center gap-3 px-2 py-2 ${isChosen ? 'bg-coral/15' : ''}`}
                >
                  <BookCover
                    book={{ isbn: e.isbn ?? '', title: e.title, author: e.author, coverUrl: e.coverUrl }}
                    className="w-12"
                    compact
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold leading-tight">{e.title}</p>
                    <p className="text-sm leading-tight text-ink/80">{e.author}</p>
                    <p className="mt-0.5 text-xs text-ink/60">{details.join(' · ')}</p>
                  </div>
                  <button
                    type="button"
                    aria-pressed={isChosen}
                    aria-label={`${isChosen ? 'Chosen' : 'Choose'}: ${e.title} (${e.source})`}
                    className={`shrink-0 !px-3 !py-1 text-sm ${isChosen ? 'btn-primary' : 'btn-ghost'}`}
                    disabled={onIt}
                    onClick={() => choose(e)}
                  >
                    {onIt ? 'On the lineup' : isChosen ? 'Chosen' : 'Choose'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {chosen && (
          <form onSubmit={nominate} className="space-y-5">
            <fieldset ref={detailsRef} className="scroll-mt-4 border-b-2 border-ink pb-5">
              <legend className="kicker pr-2">Cover</legend>
              <div className="flex gap-4">
                <BookCover key={preview.coverUrl ?? 'none'} book={preview} className="w-24" size="sm" />
                <div className="min-w-0 flex-1 space-y-2 text-sm">
                  <p className="text-ink/70">
                    {cover.kind === 'url' ? 'This cover will be used.' : 'No image: the typeset cover will be used.'}
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
                </div>
              </div>
              <div role="group" aria-label="Covers found" className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
                {covers.map((e) => (
                  <CoverOption
                    key={e.coverUrl}
                    selected={cover.kind === 'url' && cover.url === e.coverUrl}
                    onSelect={() => setCover(coverOf(e))}
                    label={`${e.source} cover, ${e.coverWidth ? `${e.coverWidth}px wide` : 'size unknown'}`}
                  >
                    <img
                      src={e.coverUrl}
                      alt=""
                      loading="lazy"
                      className="aspect-[2/3] w-full border-2 border-ink object-cover"
                    />
                    <span>
                      {e.coverWidth ? `${e.coverWidth}px` : '?'} · {e.source}
                    </span>
                  </CoverOption>
                ))}
                <CoverOption
                  selected={cover.kind === 'none'}
                  onSelect={() => setCover({ kind: 'none' })}
                  label="No image (typeset cover)"
                >
                  <BookCover book={{ ...preview, coverUrl: undefined }} className="w-full" size="sm" />
                  <span>No image</span>
                </CoverOption>
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

            <ErrorNote error={error} />
            <div className="flex justify-end gap-2 border-t-2 border-ink pt-4">
              <button type="button" className="btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={saving || alreadyOn}>
                {saving ? 'Nominating…' : nominated ? 'Save details' : 'Nominate'}
              </button>
            </div>
          </form>
        )}
        {!chosen && <ErrorNote error={error} />}
      </div>
    </Modal>
  );
}
