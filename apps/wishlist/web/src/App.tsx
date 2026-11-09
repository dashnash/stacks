import { AccountMenu, matchRoute, Spinner, useHashRoute, useStacks } from '@stacks/web';
import { manifest } from '../../api/manifest';
import { Lists } from './views/Lists';
import { ListView } from './views/ListView';
import { MyClaims } from './views/MyClaims';

/** Signed out (or no access yet): what Wishlist is. No names, no lists. */
function Landing() {
  const { signIn, accessNotice } = useStacks();
  return (
    <section className="hero">
      <p className="hero-emoji" aria-hidden>
        🎁
      </p>
      <p className="lead">{manifest.tagline}</p>
      <p>{manifest.description}</p>
      {accessNotice === 'access_pending' ? (
        <p role="status" className="notice">
          Your request is with the organizers. You'll get a notification when you're in.
        </p>
      ) : accessNotice === 'access_denied' ? (
        <p role="status" className="notice">
          This account doesn't have access to Wishlist.
        </p>
      ) : (
        <button type="button" className="button big" onClick={() => signIn()}>
          {accessNotice === 'access_required' ? 'Ask to join' : 'Sign in or ask to join'}
        </button>
      )}
    </section>
  );
}

function SignedIn() {
  const { path } = useHashRoute();
  const list = matchRoute('/l/:id', path);
  return (
    <>
      <nav className="tabs" aria-label="Sections">
        <a href="#/" aria-current={path === '/' || !!list ? 'page' : undefined}>
          Lists
        </a>
        <a href="#/claims" aria-current={path === '/claims' ? 'page' : undefined}>
          My claims
        </a>
      </nav>
      {path === '/claims' ? <MyClaims /> : list ? <ListView listId={list.id!} /> : <Lists />}
    </>
  );
}

export function App() {
  const { status, session } = useStacks();
  return (
    <div className="page">
      {/* Platform rule: the account menu sits at the top right of the header (tools/app-conformance). */}
      <header className="top">
        <a href="#/" className="brand">
          <span aria-hidden>🎀</span> {manifest.name}
        </a>
        <AccountMenu className="account" />
      </header>
      <main>{status === 'loading' ? <Spinner /> : status === 'signedIn' && session ? <SignedIn key={`${session.user.email}:${session.role}`} /> : <Landing />}</main>
      <footer className="foot muted small">{manifest.name} · surprises intact</footer>
    </div>
  );
}
