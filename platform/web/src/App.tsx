import { useEffect, useState } from 'react';
import { Avatar, Spinner, useHashRoute } from '@stacks/web';
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
  const { me, status, signOut } = usePortal();
  const [menu, setMenu] = useState(false);
  const route = useHash();
  useEffect(() => setMenu(false), [route.path]);
  const manages = !!me && me.managesApps > 0;
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
        {me && (
          <a href="#/notifications" aria-label={`Notifications${me.unread ? `, ${me.unread} unread` : ''}`}>
            Inbox <Badge count={me.unread} label="unread" />
          </a>
        )}
        {status === 'signedOut' && (
          <a href="#/signin" className="button small">
            Sign in
          </a>
        )}
        {me && (
          <div className="menu">
            <button type="button" className="avatar-button" aria-expanded={menu} aria-label="Account menu" onClick={() => setMenu(!menu)}>
              <Avatar person={{ name: me.user.name, pictureUrl: me.user.pictureUrl ?? undefined }} size={30} className="avatar" />
            </button>
            {menu && (
              <div className="menu-panel">
                <p className="muted">{me.user.email}</p>
                <a href="#/profile">Profile</a>
                {manages && <a href="#/admin/audit">Activity</a>}
                <button type="button" onClick={() => void signOut()}>
                  Sign out of everything
                </button>
              </div>
            )}
          </div>
        )}
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
  else if (path === '/profile') view = status === 'signedIn' ? <Profile /> : <SignIn />;
  else if (path === '/notifications') view = status === 'signedIn' ? <Notifications /> : <SignIn />;
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
