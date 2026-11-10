import { useMemo, useState } from 'react';
import { Avatar, ErrorNote, Spinner, useAsync } from '@stacks/web';
import type { Grid } from '../api';
import { usePortal } from '../portal';

type GridApp = Grid['apps'][number];

/** Can the viewer pick this role (or move someone off their current one) in this app? */
const allowed = (app: GridApp, roleId: string | null) => !roleId || roleId === 'PENDING' || roleId === 'BLOCKED' || app.canManageApprovers || !app.roles.find((r) => r.id === roleId)?.canManageAccess;

export function toCsv(grid: Grid, apps: GridApp[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = ['name', 'email', ...apps.map((a) => a.slug)];
  const rows = grid.users.map((u) => [u.name, u.email, ...apps.map((a) => grid.grants.find((g) => g.app === a.slug && g.userId === u.id)?.role ?? '')]);
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}

function Cell({ app, email, role, onSet }: { app: GridApp; email: string; role: string | null; onSet: (role: string | null) => void }) {
  const locked = !allowed(app, role);
  if (role === 'PENDING') {
    return (
      <div className="pending-cell">
        <span className="pill warn">Requested</span>
        {app.defaultRole && (
          <button type="button" className="link" onClick={() => onSet(app.defaultRole)} aria-label={`Approve ${email} for ${app.name}`}>
            Approve
          </button>
        )}
        <button type="button" className="link muted" onClick={() => onSet(null)} aria-label={`Dismiss ${email}'s request for ${app.name}`}>
          Dismiss
        </button>
        <button type="button" className="link muted" onClick={() => onSet('BLOCKED')} aria-label={`Block ${email} from ${app.name}`}>
          Block
        </button>
      </div>
    );
  }
  return (
    <select
      aria-label={`${email} in ${app.name}`}
      value={role ?? ''}
      disabled={locked}
      className={role === 'BLOCKED' ? 'blocked' : role ? 'has-role' : ''}
      onChange={(e) => onSet(e.target.value || null)}
    >
      <option value="">—</option>
      {app.roles.map((r) => (
        <option key={r.id} value={r.id} disabled={!allowed(app, r.id)}>
          {r.label}
        </option>
      ))}
      <option value="BLOCKED">Blocked</option>
    </select>
  );
}

export function AccessGrid({ initialApp }: { initialApp?: string }) {
  const { api, refresh } = usePortal();
  const { data, error, loading, reload } = useAsync(() => api.grid());
  const [appFilter, setAppFilter] = useState(initialApp ?? '');
  const [search, setSearch] = useState('');
  const [pendingOnly, setPendingOnly] = useState(!!initialApp);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkApp, setBulkApp] = useState('');
  const [bulkRole, setBulkRole] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const apps = useMemo(() => (data?.apps ?? []).filter((a) => !appFilter || a.slug === appFilter), [data, appFilter]);
  const roleOf = (slug: string, userId: string) => data?.grants.find((g) => g.app === slug && g.userId === userId)?.role ?? null;
  const q = search.trim().toLowerCase();
  const users = (data?.users ?? []).filter(
    (u) => (!q || `${u.name} ${u.email}`.toLowerCase().includes(q)) && (!pendingOnly || apps.some((a) => roleOf(a.slug, u.id) === 'PENDING')),
  );

  const set = async (slug: string, userId: string, role: string | null) => {
    setProblem(null);
    try {
      await api.setRole(slug, userId, role);
    } catch (err) {
      const who = data?.users.find((u) => u.id === userId);
      setProblem(`${who?.email ?? userId} in ${slug}: ${(err as Error).message}`);
    }
    await reload();
    void refresh();
  };

  const applyBulk = async () => {
    for (const userId of selected) await set(bulkApp, userId, bulkRole === '-' ? null : bulkRole);
    setSelected(new Set());
  };

  if (error) return <ErrorNote error={error.message.includes('manage') ? "You don't manage access to any app yet." : error} className="error" />;
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const bulkTarget = data.apps.find((a) => a.slug === bulkApp);

  return (
    <section>
      <div className="catalog-head">
        <div>
          <h1>Access</h1>
          <p className="muted">
            {data.isPlatformAdmin ? 'Every person and app on the platform.' : 'People in the apps you manage.'} Changes take effect on their next request.
          </p>
        </div>
        <button
          type="button"
          className="button small secondary"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([toCsv(data, apps)], { type: 'text/csv' }));
            const a = Object.assign(document.createElement('a'), { href: url, download: 'stacks-access.csv' });
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export CSV
        </button>
      </div>
      <div className="filters">
        <input type="search" placeholder="Search people" aria-label="Search people" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="App" value={appFilter} onChange={(e) => setAppFilter(e.target.value)}>
          <option value="">All apps</option>
          {data.apps.map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} /> Requests only
        </label>
      </div>
      {selected.size > 0 && (
        <div className="bulk" role="region" aria-label="Change selected people">
          <span>{selected.size} selected</span>
          <select aria-label="Bulk app" value={bulkApp} onChange={(e) => (setBulkApp(e.target.value), setBulkRole(''))}>
            <option value="">App…</option>
            {data.apps.map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.name}
              </option>
            ))}
          </select>
          <select aria-label="Bulk role" value={bulkRole} disabled={!bulkTarget} onChange={(e) => setBulkRole(e.target.value)}>
            <option value="">Role…</option>
            <option value="-">No access</option>
            {bulkTarget?.roles.filter((r) => allowed(bulkTarget, r.id)).map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <button type="button" className="button small" disabled={!bulkApp || !bulkRole} onClick={() => void applyBulk()}>
            Apply
          </button>
        </div>
      )}
      <ErrorNote error={problem} className="error" />
      <div className="grid-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th scope="col" className="sticky">
                Person
              </th>
              {apps.map((a) => (
                <th scope="col" key={a.slug}>
                  {a.name}
                  {a.status === 'archived' && <span className="muted small"> (archived)</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <th scope="row" className="sticky">
                  <label className="person">
                    <input
                      type="checkbox"
                      aria-label={`Select ${u.email}`}
                      checked={selected.has(u.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(u.id);
                        else next.delete(u.id);
                        setSelected(next);
                      }}
                    />
                    <Avatar person={{ name: u.name, pictureUrl: u.pictureUrl ?? undefined }} size={28} className="avatar" />
                    <span>
                      {u.name}
                      <span className="muted small block">{u.email}</span>
                    </span>
                  </label>
                </th>
                {apps.map((a) => (
                  <td key={a.slug}>
                    <Cell app={a} email={u.email} role={roleOf(a.slug, u.id)} onSet={(r) => void set(a.slug, u.id, r)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!users.length && <p className="muted pad">No one matches.</p>}
      </div>
    </section>
  );
}
