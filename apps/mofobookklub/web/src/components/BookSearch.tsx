import { useState, type FormEvent } from 'react';
import { useApi } from '../lib/auth';
import { looksLikeIsbn } from '../lib/format';
import type { BookCandidate } from '../lib/types';
import { BookCover, ErrorNote, Spinner } from './ui';

/**
 * Find a book by title, author or ISBN and act on it (nominate it, pick it…).
 * Typing an ISBN skips the search and acts on it directly.
 */
export function BookSearch({
  id,
  actionLabel,
  onChoose,
  disabledIsbns = new Set<string>(),
  disabledLabel = 'Added',
}: {
  id: string;
  actionLabel: string;
  onChoose: (isbn: string) => Promise<void>;
  disabledIsbns?: Set<string>;
  disabledLabel?: string;
}) {
  const api = useApi();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<BookCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busyIsbn, setBusyIsbn] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  async function choose(isbn: string) {
    setBusyIsbn(isbn);
    setError(null);
    try {
      await onChoose(isbn);
      setResults(null);
      setQuery('');
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusyIsbn(null);
    }
  }

  async function search(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    setError(null);
    if (looksLikeIsbn(q)) return choose(q);
    setSearching(true);
    try {
      setResults((await api.searchBooks(q)).results);
    } catch (err) {
      setError(err as Error);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={search} className="flex gap-2" role="search">
        <label htmlFor={id} className="sr-only">
          Search by title, author or ISBN
        </label>
        <input id={id} className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title, author or ISBN" />
        <button type="submit" className="btn-primary shrink-0" disabled={searching || busyIsbn !== null || query.trim().length < 2}>
          {looksLikeIsbn(query) ? actionLabel : 'Search'}
        </button>
      </form>
      <ErrorNote error={error} />
      {searching && <Spinner label="Searching the stacks" />}
      {results && (
        <div className="border-2 border-ink bg-white">
          <div className="flex items-center justify-between border-b-2 border-ink px-3 py-2">
            <p className="kicker">Search results</p>
            <button type="button" className="text-xs font-semibold underline" onClick={() => setResults(null)}>
              Clear
            </button>
          </div>
          {results.length === 0 && <p className="voice px-3 py-4 text-lg">No books with an ISBN matched that search.</p>}
          <ul className="max-h-80 overflow-y-auto">
            {results.map((r) => (
              <li key={r.isbn} className="flex items-center gap-3 border-b border-ink/20 px-3 py-2 last:border-b-0">
                <BookCover book={r} className="w-10" compact />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-cond text-xl font-extrabold uppercase leading-tight">{r.title}</p>
                  <p className="voice truncate text-base">
                    {r.author}
                    {r.year ? ` · ${r.year}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-ghost shrink-0 !px-4 !py-1.5"
                  disabled={disabledIsbns.has(r.isbn) || busyIsbn !== null}
                  onClick={() => choose(r.isbn)}
                >
                  {disabledIsbns.has(r.isbn) ? disabledLabel : busyIsbn === r.isbn ? 'Working…' : actionLabel}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
