import { ErrorNote, Spinner, useApi, useAsync } from '@stacks/web';
import type { ListSummary } from '../types';

/** Home: your list first, then everyone else's, A-Z. */
export function Lists() {
  const api = useApi();
  const { data, error, loading } = useAsync(() => api.get<{ lists: ListSummary[]; myListId: string }>('/lists'));
  if (loading && !data) return <Spinner />;
  const mine = data?.lists.find((l) => l.mine);
  const others = data?.lists.filter((l) => !l.mine) ?? [];
  return (
    <section>
      <ErrorNote error={error} className="error" />
      {data && (
        <a className="card mine-card" href={`#/l/${data.myListId}`}>
          <span className="ribbon" aria-hidden />
          <h2>Your list</h2>
          <p className="muted">{mine?.items ? `${mine.items} item${mine.items > 1 ? 's' : ''} · tap to edit` : 'Start your list: add what you would love to get.'}</p>
        </a>
      )}
      <h2 className="section-title">Everyone's lists</h2>
      {data && !others.length && <p className="empty">Nobody else has a list yet.</p>}
      <ul className="grid">
        {others.map((l) => (
          <li key={l.listId}>
            <a className="card" href={`#/l/${l.listId}`}>
              <span className="ribbon" aria-hidden />
              <h3>{l.ownerName}</h3>
              <p className="muted">
                {l.items} item{l.items === 1 ? '' : 's'}
                {l.items > 0 && ` · ${l.available} still available`}
              </p>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
