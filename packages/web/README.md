# @stacks/web

Browser SDK. Plumbing only: no styles, so your app can look like anything.

```tsx
import { StacksProvider, useStacks, useApi, useAsync } from '@stacks/web';

createRoot(el).render(<StacksProvider><App /></StacksProvider>);

function App() {
  const { status, session, signIn, signOut, accessNotice, refresh } = useStacks();
  // status: 'loading' | 'signedIn' | 'signedOut'
  // session: { user: { id, name, pictureUrl?, email? }, role, canManageAccess } | null  (email only with needsEmail)
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
- **Build info (required):** put `<BuildVersion />` somewhere on every screen, usually the footer: it
  shows "Build 1a2b3c4" linking to the commit (CI sets `VITE_STACKS_BUILD_SHA`/`VITE_STACKS_REPO_URL`;
  local builds say "Build dev"). Takes `className`/`style`. `tools/app-conformance` checks for it.
- **Realtime** (manifest module `realtime`; channels declared in the API, see `@stacks/api`):
  ```tsx
  const { status, publish } = useChannel<Wave>('room/lobby', (w) => toast(`${w.name} waved`), {
    publish: true,                 // ask for publish rights (the channel's guard decides)
    onResync: () => void reload(), // every (re)connect: refetch, events may have been missed
  });
  // status: 'connecting' | 'live' | 'offline' (signed out or refused: offline)
  await publish({ name });         // ≤ 4 KB JSON; rejects unless live
  ```
  One shared WebSocket per tab for every channel on the page; tokens refresh before they expire;
  reconnects with jittered backoff; closes after the page is hidden 30 s and reconnects (with a
  resync) when it's visible again. Your own publishes don't come back unless `echo: true`. Event
  data from other browsers is untrusted: check its shape before showing it.
- **Game rooms** (manifest module `gameServer`; rooms and routes in `@stacks/api`, the game itself in
  `@stacks/game-server`):
  ```tsx
  const buffer = useMemo(() => createStateBuffer<State>(), []);        // optional smoothing
  const room = useGameRoom<State, Input, Event>(roomId, {
    onState: (state, meta) => buffer.push(state, meta),   // raw server state, ~tickHz times a second
    onEvent: (e) => shake(e),                             // reliable game events
  });
  // room.status: 'starting' (server coming up, up to a minute) | 'connecting' | 'live' | 'ended' | 'offline'
  // room.players, room.you, room.rttMs, room.over ({ reason, results }), room.error ('full' | 'not_found' | 'signed_out' | 'left')
  room.sendInput({ x, y });        // unreliable: dropped unless live; send the latest, ≤ 60 a second count
  room.sendEvent('bump');          // reliable; false unless live
  await room.leave();              // give up your seat (unmounting only disconnects: the seat is kept 20 s)
  const frame = buffer.sample();   // each animation frame: the state 100 ms ago, interpolated
  ```
  It joins (a fresh ticket per connection), does WebRTC with trickle ICE over the realtime channels,
  keeps two data channels (`state` unreliable, `events` reliable), pings for RTT, and reconnects
  when the connection drops. It interpolates nothing itself: `interpolate(a, b, t)` blends two states
  (numbers lerp, list items match by `id`), `createStateBuffer({ delayMs })` does it over time. Works
  in Safari and the iOS app's web view with no extra bridge.
- Remount views that load per-user data when the user changes: `<Board key={session.user.id + session.role} />`.
