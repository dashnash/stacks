import { ErrorNote, Spinner, useAsync } from '@stacks/web';
import { usePortal } from '../portal';
import { accessBadge, AppPreview } from './Catalog';

/** An app's public page: what it is, and the way in. */
export function AppPage({ slug }: { slug: string }) {
  const { api, status, refresh } = usePortal();
  const signedIn = status === 'signedIn';
  const { data, error, reload } = useAsync(() => (signedIn ? api.catalog() : api.publicCatalog()), [signedIn, slug]);
  const app = data?.apps.find((a) => a.slug === slug);
  if (error) return <ErrorNote error={error} className="error" />;
  if (!data) return <Spinner />;
  if (!app) return <p>That app doesn't exist (or was archived). <a href="#/">See all apps</a></p>;
  const badge = accessBadge(app);
  return (
    <article className="card">
      <p className="muted small">
        <a href="#/">Apps</a> / {app.category ?? 'Apps'}
      </p>
      <h1>{app.name}</h1>
      <p className="lead">{app.tagline}</p>
      <AppPreview app={app} className="large" />
      <p>{app.description}</p>
      <p>
        <span className={`pill ${badge.tone}`}>{badge.text}</span>
      </p>
      <div className="row-gap">
        {app.access === 'BLOCKED' ? (
          <p className="muted">You don't have access to this app. Ask its owner if you think that's a mistake.</p>
        ) : (app.access && app.access !== 'PENDING') || app.visibility === 'public' || !signedIn ? (
          <a className="button" href={app.url}>
            Open {app.name}
          </a>
        ) : app.access === 'PENDING' ? (
          <p className="muted">Your request is waiting for approval. You'll get a notification.</p>
        ) : (
          <button
            type="button"
            className="button"
            onClick={() =>
              void api
                .requestAccess(app.slug)
                .then(reload)
                .then(refresh)
            }
          >
            Request access
          </button>
        )}
      </div>
      <p className="muted small">Link: {app.url}</p>
    </article>
  );
}
