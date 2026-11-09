import { ErrorNote, Spinner, useApi, useAsync } from '@stacks/web';
import { money, type ClaimGroup } from '../types';

/** Everything you've said you'll get, by person: your shopping list. */
export function MyClaims() {
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => api.get<{ groups: ClaimGroup[] }>('/me/claims'));
  if (loading && !data) return <Spinner />;
  const total = data?.groups.flatMap((g) => g.items).filter((i) => !i.bought).reduce((n, i) => n + (i.price ?? 0), 0) ?? 0;
  return (
    <section>
      <h2>My claims</h2>
      <ErrorNote error={error} className="error" />
      {data && !data.groups.length && <p className="empty">You haven't claimed anything yet. Pick something from someone's list!</p>}
      {data && data.groups.length > 0 && <p className="muted">Still to buy: about {money(total)}</p>}
      {data?.groups.map((g) => (
        <div key={g.listId} className="group">
          <h3>
            <a href={`#/l/${g.listId}`}>For {g.ownerName}</a>
          </h3>
          <ul className="items">
            {g.items.map((i) => (
              <li key={i.id} className={`card item${i.bought ? ' bought' : ''}`}>
                <div className="item-body">
                  <p className="item-title">{i.title}</p>
                  <p className="muted small">{[money(i.price), i.notes].filter(Boolean).join(' · ')}</p>
                </div>
                <label className="check">
                  <input type="checkbox" checked={i.bought} onChange={(e) => void api.patch(`/lists/${g.listId}/items/${i.id}/claim`, { bought: e.target.checked }).then(reload)} />
                  Bought
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
