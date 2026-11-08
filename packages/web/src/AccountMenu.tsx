import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { useOptionalStacks } from './auth';
import { initials } from './components';

/** What the platform tells an app about the signed-in person (GET /api/stacks/account). */
export interface AccountData {
  portalUrl: string;
  profileUrl: string;
  inboxUrl: string;
  unread: number;
  app: { slug: string; name: string; roleLabel: string | null };
  apps: { slug: string; name: string; url: string }[];
  manage: { pending: number; href: string } | null;
}

/** An app's own entry in the menu (its settings pages, typically). */
export interface MenuItem {
  label: string;
  href?: string;
  onSelect?: () => void;
}

/** `noAccess`: signed in to the platform, but no role in this private app (offer Request access). */
export type AccountState = 'loading' | 'signedOut' | 'noAccess' | 'pending' | 'signedIn';

/** Demo builds put the persona switcher inside the account menu (see @stacks/demo). */
export interface DemoControls {
  personas: { email: string; name: string; role: string }[];
  current: string | null;
  switchTo(email: string | null): void;
  reset(): void;
}
export const DemoControlsContext = createContext<DemoControls | null>(null);

/**
 * Everything an account menu needs, for apps that draw their own (manifest `accountMenu: "custom"`).
 * Most apps use <AccountMenu /> instead.
 */
export function useAccountMenu(opts: { manageAccessHref?: string } = {}) {
  // Outside a <StacksProvider> (component tests with fakes) the menu just stays in its loading state.
  const stacks = useOptionalStacks();
  const status = stacks?.status ?? 'loading';
  const session = stacks?.session ?? null;
  const api = stacks?.api;
  const accessNotice = stacks?.accessNotice ?? null;
  const [account, setAccount] = useState<AccountData | null>(null);
  useEffect(() => {
    if (status !== 'signedIn' || !api) {
      setAccount(null);
      return;
    }
    let live = true;
    api
      .get<AccountData>('/stacks/account')
      .then((a) => live && setAccount(a))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, status, session?.user.email, session?.role]);

  const state: AccountState =
    status === 'loading'
      ? 'loading'
      : status === 'signedIn'
        ? 'signedIn'
        : accessNotice === 'access_pending'
          ? 'pending'
          : accessNotice === 'access_required'
            ? 'noAccess'
            : 'signedOut';
  const manage = account?.manage ? { ...account.manage, href: opts.manageAccessHref ?? account.manage.href } : null;
  return {
    state,
    user: session?.user ?? null,
    account,
    manage,
    signIn: () => stacks?.signIn(),
    signOut: async () => {
      await stacks?.signOut();
    },
  };
}

const STYLE_ID = 'stacks-account-menu-style';
/*
 * Look: neutral, and themable with CSS variables on any ancestor:
 * --stacks-menu-bg, --stacks-menu-fg, --stacks-menu-muted, --stacks-menu-border,
 * --stacks-menu-accent, --stacks-menu-accent-fg, --stacks-menu-radius, --stacks-menu-font.
 */
const CSS = `
.stacks-am{position:relative;display:inline-flex;font:var(--stacks-menu-font,inherit);color:var(--stacks-menu-fg,#111)}
.stacks-am-chip{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:3px 12px 3px 3px;border:1px solid var(--stacks-menu-border,rgba(0,0,0,.18));border-radius:999px;background:var(--stacks-menu-bg,#fff);color:inherit;font:inherit;cursor:pointer}
.stacks-am-chip:focus-visible,.stacks-am-item:focus-visible{outline:2px solid var(--stacks-menu-accent,#2f5bd3);outline-offset:2px}
.stacks-am-btn{display:inline-flex;align-items:center;min-height:36px;padding:0 16px;border-radius:999px;border:0;background:var(--stacks-menu-accent,#2f5bd3);color:var(--stacks-menu-accent-fg,#fff);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.stacks-am-avatar{width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;background:var(--stacks-menu-muted-bg,#e8e4dc);color:var(--stacks-menu-fg,#111);overflow:hidden;flex-shrink:0}
.stacks-am-avatar img{width:100%;height:100%;object-fit:cover}
.stacks-am-name{max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stacks-am-dot{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#d93025;color:#fff;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
.stacks-am-panel{position:absolute;right:0;top:calc(100% + 8px);z-index:2147482000;width:280px;max-height:min(80vh,560px);overflow:auto;padding:8px;border:1px solid var(--stacks-menu-border,rgba(0,0,0,.14));border-radius:var(--stacks-menu-radius,12px);background:var(--stacks-menu-bg,#fff);color:var(--stacks-menu-fg,#111);box-shadow:0 10px 30px rgba(0,0,0,.18);text-align:left}
.stacks-am-head{padding:8px 10px 10px;border-bottom:1px solid var(--stacks-menu-border,rgba(0,0,0,.1));margin-bottom:6px}
.stacks-am-head strong{display:block}
.stacks-am-sub{display:block;font-size:.85em;color:var(--stacks-menu-muted,#666);overflow-wrap:anywhere}
.stacks-am-label{padding:8px 10px 4px;font-size:.75em;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--stacks-menu-muted,#666)}
.stacks-am-item{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;text-decoration:none;cursor:pointer}
.stacks-am-item:hover,.stacks-am-item:focus{background:var(--stacks-menu-hover,rgba(0,0,0,.06))}
.stacks-am-sep{border:0;border-top:1px solid var(--stacks-menu-border,rgba(0,0,0,.1));margin:6px 0}
.stacks-am-demo select{max-width:100%;font:inherit}
@media (max-width:520px){
  .stacks-am-name{display:none}
  .stacks-am-chip{padding-right:3px}
  .stacks-am-panel{position:fixed;left:8px;right:8px;top:60px;width:auto}
}`;

function useStyles() {
  useEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }, []);
}

export interface AccountMenuViewProps {
  state: AccountState;
  user: { email: string; name: string; pictureUrl?: string } | null;
  /** e.g. "Owner of MOFO Book Klub". */
  subtitle?: string | null;
  /** The person's apps, linked. The current app can be left in; it is shown as the current one. */
  apps?: { slug: string; name: string; url: string }[];
  currentApp?: string;
  allAppsHref?: string;
  inbox?: { href: string; unread: number } | null;
  settingsHref?: string;
  manage?: { pending: number; href: string } | null;
  /** App-specific entries (its own settings pages). */
  items?: MenuItem[];
  onSignIn(): void;
  onSignOut(): void;
  /** Shown in place of "Sign in" when access to this app has been requested. */
  pendingLabel?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * The account control every Stacks app and the portal put at the top right of their header:
 * a "Sign in" button when signed out, "Access requested" while a request waits, and an avatar
 * chip that opens the menu (your apps, inbox, settings, manage access, app items, sign out).
 */
export function AccountMenuView(props: AccountMenuViewProps) {
  useStyles();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const demo = useContext(DemoControlsContext);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]!.focus();
  };

  const rootProps = { ref: root, className: ['stacks-am', props.className].filter(Boolean).join(' '), style: props.style, 'data-stacks-account-menu': props.state };

  if (props.state === 'loading') {
    return <div {...rootProps} aria-busy="true" style={{ ...props.style, minWidth: 96, minHeight: 36 }} />;
  }
  if (props.state === 'signedOut' || ((props.state === 'pending' || props.state === 'noAccess') && !props.user)) {
    // Sign in; or, signed in to the platform without a role here, ask for one (only on click).
    const label = props.state === 'pending' ? (props.pendingLabel ?? 'Access requested · check again') : props.state === 'noAccess' ? 'Request access' : 'Sign in';
    return (
      <div {...rootProps}>
        <button type="button" className="stacks-am-btn" onClick={props.onSignIn}>
          {label}
        </button>
      </div>
    );
  }

  const user = props.user!;
  const others = (props.apps ?? []).filter((a) => a.slug !== props.currentApp);
  const unread = props.inbox?.unread ?? 0;
  const badge = unread + (props.manage?.pending ?? 0);
  const item = (key: string, label: ReactNode, opts: { href?: string; onSelect?: () => void; aside?: ReactNode }) =>
    opts.href ? (
      <a key={key} role="menuitem" className="stacks-am-item" href={opts.href} onClick={() => close(false)}>
        <span>{label}</span>
        {opts.aside}
      </a>
    ) : (
      <button
        key={key}
        type="button"
        role="menuitem"
        className="stacks-am-item"
        onClick={() => {
          close(false);
          opts.onSelect?.();
        }}
      >
        <span>{label}</span>
        {opts.aside}
      </button>
    );

  return (
    <div {...rootProps} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="stacks-am-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Account menu for ${user.name}${badge ? `, ${badge} new` : ''}`}
        onClick={() => setOpen(!open)}
      >
        <span className="stacks-am-avatar" aria-hidden>
          {user.pictureUrl ? <img src={user.pictureUrl} alt="" referrerPolicy="no-referrer" /> : initials(user.name)}
        </span>
        <span className="stacks-am-name">{user.name}</span>
        {badge > 0 && <span className="stacks-am-dot" aria-hidden>{badge}</span>}
      </button>
      {open && (
        <div ref={panel} id={menuId} role="menu" aria-label="Account" className="stacks-am-panel">
          <div className="stacks-am-head" role="presentation">
            <strong>{user.name}</strong>
            <span className="stacks-am-sub">{user.email}</span>
            {props.subtitle && <span className="stacks-am-sub">{props.subtitle}</span>}
          </div>
          {others.length > 0 && <div className="stacks-am-label" role="presentation">Your apps</div>}
          {others.slice(0, 6).map((a) => item(`app-${a.slug}`, a.name, { href: a.url }))}
          {props.allAppsHref && item('all', 'All apps', { href: props.allAppsHref })}
          {props.inbox && item('inbox', 'Inbox', { href: props.inbox.href, aside: unread > 0 ? <span className="stacks-am-dot">{unread}</span> : undefined })}
          {props.settingsHref && item('settings', 'Settings', { href: props.settingsHref })}
          {props.manage &&
            item('manage', 'Manage access', { href: props.manage.href, aside: props.manage.pending > 0 ? <span className="stacks-am-dot" aria-label={`${props.manage.pending} requests`}>{props.manage.pending}</span> : undefined })}
          {props.items && props.items.length > 0 && <hr className="stacks-am-sep" />}
          {props.items?.map((it, i) => item(`item-${i}`, it.label, { href: it.href, onSelect: it.onSelect }))}
          {demo && (
            <>
              <hr className="stacks-am-sep" />
              <div className="stacks-am-label" role="presentation">Demo: try the app as</div>
              <div className="stacks-am-item stacks-am-demo" role="presentation">
                <select aria-label="Try the app as" value={demo.current ?? ''} onChange={(e) => demo.switchTo(e.target.value || null)}>
                  {demo.personas.map((p) => (
                    <option key={p.email} value={p.email}>
                      {p.name} ({p.role})
                    </option>
                  ))}
                </select>
              </div>
              {item('demo-reset', 'Demo: reset sample data', { onSelect: demo.reset })}
            </>
          )}
          <hr className="stacks-am-sep" />
          {item('signout', 'Sign out', { onSelect: props.onSignOut, aside: <span className="stacks-am-sub">all apps</span> })}
        </div>
      )}
    </div>
  );
}

/**
 * The account control for apps: put it at the top right of your header.
 *
 *   <AccountMenu items={[{ label: 'Reading reminders', href: '#/settings' }]} manageAccessHref="#/admin" />
 */
export function AccountMenu({
  items,
  manageAccessHref,
  className,
  style,
}: {
  /** App-specific entries, e.g. the app's own settings page. */
  items?: MenuItem[];
  /** Your app's own access page, if it has one; otherwise the portal's grid for this app. */
  manageAccessHref?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const { state, user, account, manage, signIn, signOut } = useAccountMenu({ manageAccessHref });
  return (
    <AccountMenuView
      state={state}
      user={user}
      subtitle={account?.app.roleLabel ? `${account.app.roleLabel} · ${account.app.name}` : null}
      apps={account?.apps}
      currentApp={account?.app.slug}
      allAppsHref={account?.portalUrl}
      inbox={account ? { href: account.inboxUrl, unread: account.unread } : null}
      settingsHref={account?.profileUrl}
      manage={manage}
      items={items}
      onSignIn={signIn}
      onSignOut={() => void signOut()}
      className={className}
      style={style}
    />
  );
}
