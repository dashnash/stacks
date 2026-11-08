import { useMemo, useState } from 'react';
import { ErrorNote, Spinner, useAsync } from '@stacks/web';
import type { CatalogApp } from '../api';
import { usePortal } from '../portal';

export function accessBadge(app: CatalogApp): { text: string; tone: string } {
  if (app.access === 'PENDING') return { text: 'Requested', tone: 'warn' };
  if (app.access === 'BLOCKED') return { text: 'No access', tone: 'muted' };
  if (app.access) return { text: app.accessLabel ?? app.access, tone: 'ok' };
  return app.visibility === 'public' ? { text: 'Open to all', tone: 'info' } : { text: 'Private', tone: 'muted' };
}

function AppCard({ app, onChange }: { app: CatalogApp; onChange: () => void }) {
  const { api, status } = usePortal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const badge = accessBadge(app);
  const canOpen = app.access && app.access !== 'PENDING' && app.access !== 'BLOCKED';

  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="app-card">
      <div className="app-card-top">
        <span className="app-icon" aria-hidden>
          {app.name.slice(0, 1)}
        </span>
        <div className="grow">
          <h3>
            <a href={`#/app/${app.slug}`}>{app.name}</a>
          </h3>
          <p className="muted">{app.tagline}</p>
        </div>
        {status === 'signedIn' && (
          <button
            type="button"
            className={`star${app.favorite ? ' on' : ''}`}
            aria-pressed={app.favorite}
            aria-label={app.favorite ? `Remove ${app.name} from favorites` : `Add ${app.name} to favorites`}
            onClick={run(() => api.setFavorite(app.slug, !app.favorite))}
          >
            {app.favorite ? '★' : '☆'}
          </button>
        )}
      </div>
      <div className="app-card-bottom">
        <span className={`pill ${badge.tone}`}>{badge.text}</span>
        {app.access === 'BLOCKED' ? null : canOpen || app.visibility === 'public' || status === 'signedOut' ? (
          <a className="button small" href={app.url}>
            Open
          </a>
        ) : app.access === 'PENDING' ? (
          <span className="muted small">Waiting for approval</span>
        ) : (
          <button type="button" className="button small secondary" disabled={busy} onClick={run(() => api.requestAccess(app.slug))}>
            Request access
          </button>
        )}
      </div>
      <ErrorNote error={error} className="error" />
    </li>
  );
}

export function Catalog({ signedOutNotice }: { signedOutNotice?: boolean }) {
  const { api, status, refresh } = usePortal();
  const signedIn = status === 'signedIn';
  const { data, error, loading, reload } = useAsync<{ apps: CatalogApp[]; recent?: string[] }>(() => (signedIn ? api.catalog() : api.publicCatalog()), [signedIn]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  const apps = data?.apps ?? [];
  const categories = useMemo(() => [...new Set(apps.map((a) => a.category).filter((c): c is string => !!c))].sort(), [apps]);
  const q = query.trim().toLowerCase();
  const shown = apps.filter((a) => (!category || a.category === category) && (!q || `${a.name} ${a.tagline} ${a.description}`.toLowerCase().includes(q)));
  const favorites = shown.filter((a) => a.favorite);
  const recent = (data?.recent ?? []).map((s) => shown.find((a) => a.slug === s)).filter((a): a is CatalogApp => !!a && !a.favorite).slice(0, 4);
  const rest = shown.filter((a) => !favorites.includes(a) && !recent.includes(a));
  const changed = () => {
    void reload();
    void refresh();
  };

  return (
    <>
      {signedOutNotice && <p className="notice">You're signed out of every app.</p>}
      <div className="catalog-head">
        <div>
          <h1>Apps</h1>
          <p className="muted">{signedIn ? 'Everything on the platform. Open the ones you use, or ask for access.' : 'Sign in once with Google to use any app here.'}</p>
        </div>
        <input className="search" type="search" placeholder="Search apps" aria-label="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {categories.length > 1 && (
        <div className="chips" role="group" aria-label="Filter by category">
          <button type="button" aria-pressed={!category} onClick={() => setCategory(null)}>
            All
          </button>
          {categories.map((c) => (
            <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      {loading && !data ? <Spinner /> : <ErrorNote error={error} className="error" />}
      {favorites.length > 0 && (
        <section>
          <h2>Favorites</h2>
          <ul className="app-grid">{favorites.map((a) => <AppCard key={a.slug} app={a} onChange={changed} />)}</ul>
        </section>
      )}
      {recent.length > 0 && (
        <section>
          <h2>Recently used</h2>
          <ul className="app-grid">{recent.map((a) => <AppCard key={a.slug} app={a} onChange={changed} />)}</ul>
        </section>
      )}
      {(favorites.length > 0 || recent.length > 0) && rest.length > 0 && <h2>All apps</h2>}
      <ul className="app-grid">{rest.map((a) => <AppCard key={a.slug} app={a} onChange={changed} />)}</ul>
      {data && !shown.length && <p className="muted">No apps match.</p>}
    </>
  );
}
