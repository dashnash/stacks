import { useEffect, useState } from 'react';
import { ErrorNote, formatDateTime, Spinner } from '@stacks/web';
import type { AuditEvent } from '../api';
import { usePortal } from '../portal';

export function AuditLog({ initialApp }: { initialApp?: string }) {
  const { api } = usePortal();
  const [filters, setFilters] = useState({ app: initialApp ?? '', actor: '', action: '' });
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = async (before?: string) => {
    try {
      const res = await api.audit({ ...filters, before });
      setEvents((prev) => (before && prev ? [...prev, ...res.events] : res.events));
      setNext(res.nextBefore);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.app, filters.actor, filters.action]);

  return (
    <section>
      <h1>Activity</h1>
      <p className="muted">Everything people did across the apps you manage, newest first.</p>
      <div className="filters">
        {(['app', 'actor', 'action'] as const).map((f) => (
          <input
            key={f}
            aria-label={`Filter by ${f}`}
            placeholder={f === 'app' ? 'App (slug)' : f === 'actor' ? 'Person (email or id)' : 'Action, e.g. grant'}
            defaultValue={filters[f]}
            onKeyDown={(e) => e.key === 'Enter' && setFilters({ ...filters, [f]: (e.target as HTMLInputElement).value.trim() })}
            onBlur={(e) => setFilters({ ...filters, [f]: e.target.value.trim() })}
          />
        ))}
      </div>
      <ErrorNote error={error} className="error" />
      {!events && !error && <Spinner />}
      {events && (
        <div className="grid-scroll">
          <table className="grid audit">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">App</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={`${e.app}-${e.id}`}>
                  <td className="nowrap">{formatDateTime(e.at)}</td>
                  <td>{e.app}</td>
                  <td>
                    {e.actorName}
                    <span className="muted small block">{e.actorEmail}</span>
                  </td>
                  <td>
                    <code>{e.action}</code> {e.label}
                  </td>
                  <td className="muted small">{e.details ? JSON.stringify(e.details) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!events.length && <p className="muted pad">No activity matches.</p>}
        </div>
      )}
      {next && (
        <button type="button" className="button secondary small" onClick={() => void load(next)}>
          Load older
        </button>
      )}
    </section>
  );
}
