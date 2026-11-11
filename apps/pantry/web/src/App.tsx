import { useState, type FormEvent } from 'react';
import { AccountMenu, BuildVersion, ErrorNote, matchRoute, RequestAccess, Spinner, useApi, useHashRoute, useStacks } from '@stacks/web';
import { manifest } from '../../api/manifest';
import { MAX_LIST_NAME, type ListMeta } from '../../api/routes';
import { useLiveLists } from './live';
import { ConnectionDot, ListView } from './ListView';

/** Signed out (or signed in without access yet): what Pantry is, and how to get in. No list data. */
function Landing() {
  return (
    <section className="hero">
      <p className="lead">{manifest.tagline}</p>
      <p>Pantry is a shared grocery list for your household. Everyone in it sees every list, adds things as they run out, and checks them off in the shop with a swipe. Changes show up on everyone's phone straight away.</p>
      <ul className="perks">
        <li>Swipe right to check off, far left to remove, with Undo</li>
        <li>Suggestions from what the list has had before, quantities included</li>
        <li>One gentle notification when someone adds things, not one per item</li>
      </ul>
      {/* The SDK's request-access state: our own button signs in (which files a request when needed). */}
      <RequestAccess>
        {({ notice, signIn: go }) =>
          notice === 'access_pending' ? (
            <p role="status" className="notice">Your request is with the household's owner. You'll get a notification when you're in.</p>
          ) : notice === 'access_denied' ? (
            <p role="status" className="notice">This Google account doesn't have access to Pantry.</p>
          ) : (
            <button type="button" className="primary big" onClick={go}>
              {notice === 'access_required' ? 'Request access' : 'Sign in with Google'}
            </button>
          )
        }
      </RequestAccess>
      <p className="muted small">Pantry is private: ask for access, and the household's owner lets you in.</p>
    </section>
  );
}

function ListIndex() {
  const api = useApi();
  const { lists, error, status, refresh } = useLiveLists();
  const [name, setName] = useState('');
  const [saveError, setSaveError] = useState<Error | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaveError(null);
    try {
      const { list } = await api.post<{ list: ListMeta }>('/lists', { name: name.trim() });
      setName('');
      await refresh();
      window.location.hash = `#/l/${list.id}`;
    } catch (err) {
      setSaveError(err as Error);
    }
  }

  return (
    <section aria-labelledby="lists-title">
      <div className="list-head">
        <h2 id="lists-title">Your lists</h2>
        <ConnectionDot status={status} />
      </div>
      {!lists ? error ? <ErrorNote error={error} className="error" /> : <Spinner /> : null}
      {lists && !lists.length && <p className="empty muted">No lists yet. Start one below.</p>}
      <ul className="lists">
        {lists?.map((l) => (
          <li key={l.id}>
            <a href={`#/l/${l.id}`} className="list-link">
              <span className="list-name">
                {l.name}
                {l.muted && (
                  <span className="muted-tag" title="Notifications off" aria-label="(muted)">
                    {' '}
                    🔕
                  </span>
                )}
              </span>
              <span className="counts">
                {l.open} to get{l.done ? ` · ${l.done} done` : ''}
              </span>
            </a>
          </li>
        ))}
      </ul>
      <form className="new-list" onSubmit={create}>
        <label htmlFor="new-list">New list</label>
        <div className="addbar-row">
          <input id="new-list" placeholder="e.g. Weekly shop" maxLength={MAX_LIST_NAME} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="primary" disabled={!name.trim()}>
            Create
          </button>
        </div>
        <ErrorNote error={saveError} className="error" />
      </form>
    </section>
  );
}

function Home() {
  const { path } = useHashRoute();
  const open = matchRoute('/l/:id', path);
  return open ? <ListView key={open.id} listId={open.id!} /> : <ListIndex />;
}

export function App() {
  const { status, session } = useStacks();
  return (
    <div className="page">
      {/* Platform rule: the account menu sits at the top right of the header (tools/app-conformance). */}
      <header className="top">
        <a href="#/" className="brand">
          <span aria-hidden="true">🥕</span> {manifest.name}
        </a>
        <AccountMenu className="account" />
      </header>
      <main>{status === 'loading' ? <Spinner /> : status === 'signedIn' && session ? <Home key={`${session.user.id}:${session.role}`} /> : <Landing />}</main>
      {/* Platform rule: the build is shown on every screen (tools/app-conformance). */}
      <footer className="foot muted small">
        {manifest.name} · built on Stacks · <BuildVersion className="build" />
      </footer>
    </div>
  );
}
