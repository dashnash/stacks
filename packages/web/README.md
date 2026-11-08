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
  // accessNotice: 'access_pending' | 'access_denied' | null (after a private-app sign-in attempt)
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
- The portal bar (bottom-right pill: other apps, inbox count, sign out of everything) is rendered by
  `<StacksProvider portalBar="minimized|shown|off">`; pass the manifest's `portalBar`.
- Remount views that load per-user data when the user changes: `<Board key={session.user.email + session.role} />`.
