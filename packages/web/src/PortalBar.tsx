import { useEffect, useState, type CSSProperties } from 'react';
import { useStacks } from './auth';
import { initials } from './components';

export type PortalBarMode = 'shown' | 'minimized' | 'off';

interface BarData {
  portalUrl: string;
  unread: number;
  apps: { slug: string; name: string; url: string }[];
}

const STORAGE_KEY = 'stacks.portalBar.open';

function readOpen(fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeOpen(open: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? '1' : '0');
  } catch {
    // ignore: the bar still works for this visit
  }
}

const font = '13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif';
// Bottom-right: apps usually keep their own account menu at the top right.
const shell: CSSProperties = { position: 'fixed', bottom: 12, right: 12, zIndex: 2147482000, font, color: '#111', display: 'flex', flexDirection: 'column-reverse', alignItems: 'flex-end' };
const pill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 32,
  padding: '0 10px 0 4px',
  border: '1px solid rgba(0,0,0,.15)',
  borderRadius: 999,
  background: 'rgba(255,255,255,.92)',
  boxShadow: '0 1px 4px rgba(0,0,0,.15)',
  cursor: 'pointer',
  font,
  color: '#111',
};
const panel: CSSProperties = {
  marginBottom: 6,
  width: 240,
  maxWidth: 'calc(100vw - 20px)',
  padding: 8,
  border: '1px solid rgba(0,0,0,.12)',
  borderRadius: 12,
  background: '#fff',
  boxShadow: '0 6px 20px rgba(0,0,0,.18)',
};
const row: CSSProperties = { display: 'block', padding: '7px 8px', borderRadius: 8, color: '#111', textDecoration: 'none' };

/**
 * The platform's light overlay: switch apps, see notifications, sign out everywhere. Rendered by
 * <StacksProvider> for signed-in users unless the app turns it off; minimizes to a small pill and
 * remembers that choice.
 */
export function PortalBar({ mode = 'minimized' }: { mode?: PortalBarMode }) {
  const { status, session, api, signOut } = useStacks();
  const [open, setOpen] = useState(() => readOpen(mode === 'shown'));
  const [data, setData] = useState<BarData | null>(null);

  useEffect(() => {
    if (status !== 'signedIn') return;
    let live = true;
    api
      .get<BarData>('/stacks/bar')
      .then((d) => live && setData(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, status, session?.user.email]);

  if (mode === 'off' || status !== 'signedIn' || !session) return null;
  const toggle = () => {
    setOpen(!open);
    writeOpen(!open);
  };
  const here = typeof window === 'undefined' ? '' : window.location.origin;
  const otherApps = (data?.apps ?? []).filter((a) => !a.url.startsWith(here) || a.url === '#/');

  return (
    <div style={shell} data-stacks-portal-bar="">
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" style={pill} onClick={toggle} aria-expanded={open} aria-controls="stacks-portal-panel" aria-label={open ? 'Hide the apps menu' : 'Show the apps menu'}>
          <span
            aria-hidden
            style={{ width: 24, height: 24, borderRadius: '50%', background: '#e8e4dc', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 11, overflow: 'hidden' }}
          >
            {session.user.pictureUrl ? <img src={session.user.pictureUrl} alt="" width={24} height={24} referrerPolicy="no-referrer" /> : initials(session.user.name)}
          </span>
          <span>Apps</span>
          {!!data?.unread && (
            <span aria-label={`${data.unread} unread notifications`} style={{ minWidth: 18, height: 18, borderRadius: 9, background: '#d93025', color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>
              {data.unread}
            </span>
          )}
        </button>
      </div>
      {open && (
        <nav id="stacks-portal-panel" style={panel} aria-label="Your apps">
          <div style={{ padding: '4px 8px 8px', color: '#555' }}>
            Signed in as <strong style={{ color: '#111' }}>{session.user.name}</strong>
          </div>
          {otherApps.map((a) => (
            <a key={a.slug} href={a.url} style={row}>
              {a.name}
            </a>
          ))}
          <hr style={{ border: 0, borderTop: '1px solid #eee', margin: '6px 0' }} />
          <a href={data?.portalUrl ?? '#'} style={row}>
            All apps{data?.unread ? ` · ${data.unread} new` : ''}
          </a>
          <button type="button" onClick={() => void signOut()} style={{ ...row, width: '100%', textAlign: 'left', border: 0, background: 'none', cursor: 'pointer', font }}>
            Sign out of everything
          </button>
        </nav>
      )}
    </div>
  );
}
