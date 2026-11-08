import { AccountMenuView, Spinner, useAsync, useHashRoute } from '@stacks/web';
import { Badge, parseHash, usePortal } from './portal';
import { AccessGrid } from './views/AccessGrid';
import { AppPage } from './views/AppPage';
import { AuditLog } from './views/AuditLog';
import { Catalog } from './views/Catalog';
import { Notifications } from './views/Notifications';
import { Profile } from './views/Profile';
import { SignIn } from './views/SignIn';

function useHash() {
  useHashRoute(); // re-render on hash changes
  return parseHash(window.location.hash);
}

function Header() {
  const { api, me, status, signOut } = usePortal();
  const route = useHash();
  const manages = !!me && me.managesApps > 0;
  const catalog = useAsync(() => (status === 'signedIn' ? api.catalog() : Promise.resolve(null)), [status]);
  const myApps = (catalog.data?.apps ?? []).filter((a) => a.access && a.access !== 'PENDING' && a.access !== 'BLOCKED');
  return (
    <header className="topbar">
      <a href="#/" className="brand">
        Stacks
      </a>
      <nav className="nav">
        <a href="#/" aria-current={route.path === '/' ? 'page' : undefined}>
          Apps
        </a>
        {manages && (
          <a href="#/admin/access" aria-current={route.path.startsWith('/admin') ? 'page' : undefined}>
            Access <Badge count={me.pendingRequests} label="pending requests" />
          </a>
        )}
        <AccountMenuView
          className="account"
          state={status === 'loading' ? 'loading' : me ? 'signedIn' : 'signedOut'}
          user={me ? { email: me.user.email, name: me.user.name, ...(me.user.pictureUrl ? { pictureUrl: me.user.pictureUrl } : {}) } : null}
          subtitle={me?.user.isPlatformAdmin ? 'Platform admin' : null}
          apps={myApps.map((a) => ({ slug: a.slug, name: a.name, url: a.url }))}
          allAppsHref="#/"
          inbox={me ? { href: '#/notifications', unread: me.unread } : null}
          settingsHref="#/profile"
          manage={manages ? { pending: me.pendingRequests, href: '#/admin/access' } : null}
          items={manages ? [{ label: 'Activity', href: '#/admin/audit' }] : undefined}
          onSignIn={() => (window.location.hash = '#/signin')}
          onSignOut={() => void signOut()}
        />
      </nav>
    </header>
  );
}

export function App() {
  const { status } = usePortal();
  const { path, query } = useHash();
  let view;
  if (status === 'loading') view = <Spinner className="pad" />;
  else if (path === '/signin') view = <SignIn next={query.next} />;
  else if (path.startsWith('/app/')) view = <AppPage slug={decodeURIComponent(path.slice(5))} />;
  else if (path === '/profile') view = status === 'signedIn' ? <Profile from={query.from} /> : <SignIn />;
  else if (path === '/notifications') view = status === 'signedIn' ? <Notifications from={query.from} /> : <SignIn />;
  else if (path === '/admin/access') view = status === 'signedIn' ? <AccessGrid initialApp={query.app} /> : <SignIn />;
  else if (path === '/admin/audit') view = status === 'signedIn' ? <AuditLog initialApp={query.app} /> : <SignIn />;
  else view = <Catalog signedOutNotice={query.signedOut === '1'} />;
  return (
    <div className="shell">
      <Header />
      <main className="content">{view}</main>
    </div>
  );
}
