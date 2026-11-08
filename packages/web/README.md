# @stacks/web

Browser SDK. Plumbing only: no styles, so your app can look like anything.

```tsx
import { StacksProvider, useStacks, useApi, useAsync } from '@stacks/web';

createRoot(el).render(<StacksProvider><App /></StacksProvider>);

function App() {
  const { status, session, signIn, signOut, accessNotice, refresh } = useStacks();
  // status: 'loading' | 'signedIn' | 'signedOut'
  // session: { user: { email, name, pictureUrl? }, role, canManageAccess } | null
  // signIn(returnTo?) goes through platform sign-in and back to the current page
  // accessNotice: 'access_required' (signed in to the platform, no role here) | 'access_pending' | 'access_denied' (blocked) | null
  // Signed in to the platform = signed in here: the provider signs in silently in the background.
  // signOut() signs out of every app and comes back to this page.
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => api.get<{ items: Item[] }>('/items'), [deps]);
}
```

- `api.get/post/patch/put/del(path, body?)`, `api.request(method, path, body?)`. Errors are `ApiError`
  (`status`, `code`, `message`). A 401 flips the app to signed out.
- Routing: `useHashRoute()` gives `{ path, segments }` for `#/notes/7`; `matchRoute('/notes/:id', path)`.
- Headless components (take `className`/`style`): `Modal` (Escape/backdrop close, focus, scroll lock),
  `Avatar`, `Spinner`, `ErrorNote`, `RequestAccess` (render-prop for custom UI).
- Format: `timeAgo(iso)`, `formatShortDate`, `formatDateTime`, `firstName`.
- `useOptionalStacks()` is `useStacks()` that returns null outside a provider (for components tested with fakes).
- **Account menu (required):** put `<AccountMenu />` at the top right of your header, signed in or
  out. It shows Sign in (or Request access / Access requested / No access · switch account), or the menu: your apps, inbox, settings (platform profile), manage access
  (approvers), your `items`, sign out of everything.
  ```tsx
  <header>… <AccountMenu items={[{ label: 'Reading reminders', href: '#/settings' }]} manageAccessHref="#/admin" /></header>
  ```
  Theme with `--stacks-menu-bg|fg|muted|border|accent|accent-fg|muted-bg|hover|radius|font` on a
  wrapper class. For a fully custom control use `useAccountMenu()` and set `"accountMenu": "custom"`.
  `tools/app-conformance` fails CI if an app's header doesn't have one.
- Remount views that load per-user data when the user changes: `<Board key={session.user.email + session.role} />`.
