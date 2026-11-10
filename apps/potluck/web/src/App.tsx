import { AccountMenu, BuildVersion, matchRoute, Spinner, useApi, useAsync, useHashRoute, useStacks } from '@stacks/web';
import { manifest } from '../../api/manifest';
import { EditEvent, NewEvent } from './views/EventForm';
import { EventList } from './views/EventList';
import { EventPage } from './views/EventPage';

/** Signed out (or signed in without access yet): what Potluck is, and how many are coming up. */
function Landing() {
  const api = useApi();
  const { signIn, accessNotice } = useStacks();
  const summary = useAsync(() => api.get<{ upcoming: number }>('/public/summary'));
  return (
    <section className="hero">
      <p className="hero-emoji" aria-hidden>
        🍲🥗🍰🥤
      </p>
      <p className="lead">{manifest.tagline}</p>
      <p>{manifest.description}</p>
      {accessNotice === 'access_pending' ? (
        <p role="status" className="notice">
          Your request is with the hosts. You'll get a notification when you're in.
        </p>
      ) : accessNotice === 'access_denied' ? (
        <p role="status" className="notice">
          This account doesn't have access to Potluck.
        </p>
      ) : (
        <button type="button" className="button big" onClick={() => signIn()}>
          {accessNotice === 'access_required' ? 'Ask to join' : 'Sign in or ask to join'}
        </button>
      )}
      {summary.data && (
        <p className="muted small">
          {summary.data.upcoming === 0 ? 'No potlucks planned right now.' : `${summary.data.upcoming} potluck${summary.data.upcoming > 1 ? 's' : ''} coming up.`}
        </p>
      )}
    </section>
  );
}

function SignedIn() {
  const { path } = useHashRoute();
  const edit = matchRoute('/e/:id/edit', path);
  const event = matchRoute('/e/:id', path);
  if (path === '/new') return <NewEvent />;
  if (edit) return <EditEvent id={edit.id!} />;
  if (event) return <EventPage id={event.id!} />;
  return <EventList />;
}

export function App() {
  const { status, session } = useStacks();
  return (
    <div className="page">
      {/* Platform rule: the account menu sits at the top right of the header (tools/app-conformance). */}
      <header className="top">
        <a href="#/" className="brand">
          <span aria-hidden>🥘</span> {manifest.name}
        </a>
        <AccountMenu className="account" />
      </header>
      <main>{status === 'loading' ? <Spinner /> : status === 'signedIn' && session ? <SignedIn key={`${session.user.id}:${session.role}`} /> : <Landing />}</main>
      <footer className="foot muted small">
        {manifest.name} · made for sharing · <BuildVersion className="build" />
      </footer>
    </div>
  );
}
