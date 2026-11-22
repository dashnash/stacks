# #61 Sharing flows: share any page from DashyHQ, and an SDK for app-specific shares

There is no way to share a page from the DashyHQ app today. The share sheet bridge (`share`) and
universal links exist, but nothing calls them, and the shell has no chrome to put a button on. This
adds a native **Share** button on every page in the app, lets a page change or turn off what it
shares, gives apps an SDK hook to share their own things (a link to one item), and ships the first
one: sharing a Book Club comment.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Page share control | A **floating native button** in the shell, bottom-right inside the safe area: 44 pt circle, system material blur, SF Symbol `square.and.arrow.up`, VoiceOver label "Share this page". It replaces the spec's "full-bleed, no chrome" rule with "full-bleed plus one share button". |
| Where it shows | Every in-app page: the portal (`auth.<domain>`, all of its pages) and every app. Hidden in immersive mode (`screen.immersive`), on the offline screen, while the keyboard is up, and on pages that turn it off. It fades to 30 % while the page scrolls and comes back 0.6 s after scrolling stops. |
| What it shares | By default the main frame's current URL (fragment included) and `document.title` (`webView.title`). On sign-in plumbing (`/authorize`, the portal's `#/signin?next=…`) it shares `handoffURL(url)` (the app being signed in to), so nobody shares a sign-in link. |
| Page override | A page may set its own `{ url, title, text }` or hide the button. A setting is **scoped to the page URL it was made on**: once the URL changes (a hash route, `pushState`, a new document), the shell goes back to the default until the page sets it again. A new document clears it. |
| Bridge | New call `share.page` (`origins: "any"`, main frame only, no capability). Args `{ page, url?, title?, text?, hidden? }`, where `page` is `location.href` at the time of the call. `url` must be `https:`. Result `{}`. Protocol stays v1 (additive); older shells don't list it, so the SDK no-ops. |
| Web SDK | `@stacks/web` gains `useShareTarget(target \| null)` (sets the override while mounted, clears it on unmount; `null` hides the button) and `useShare()` → `{ available, share({ url?, title?, text? }) }`. `url` may be relative (`#/book/1/comment/c1`) and resolves against the page. `share` swallows `cancelled`. `@stacks/native` gains `native.canShare` and `native.setPageShare(...)`. |
| Desktop / no share sheet | **Hidden.** `available` / `canShare` is true only in the app (`has('share')`) or where `navigator.share` exists (iOS/macOS Safari, mobile browsers). There is no clipboard fallback. Apps render their share buttons only when `available`. |
| Link previews | **Per-app static.** `stacksLinkPreview()`, a Vite plugin from `@stacks/web/vite`, reads `app.manifest.json` and injects `og:title` (name), `og:description` (tagline), `og:site_name`, `og:url`, `twitter:card`, and `og:image` when `web/public/og-image.png` exists, with absolute URLs to the app's production site (`<slug>.<production rootDomain>` from `stacks.config.json`, or `DOMAIN_NAME` when set). The deploy never set `DOMAIN_NAME` and one build serves both environments, so Book Club's hand-written tags had relative `og:image` URLs until now; its `__SITE_URL__` uses the same helper (`appSiteUrl`). The plugin is plain ESM JavaScript (`packages/web/vite.mjs` + `vite.d.mts`) because Vite loads its config with Node, which can't import TypeScript from a workspace package. It skips any tag the page already has (Book Club keeps its hand-written ones). Added to `templates/app` and every existing app's `vite.config.ts`. Previews never carry per-page content, so private apps leak nothing. |
| Book Club pilot | Same PR. Book comments get a **Share** button (when `available`) linking to `#/book/<isbn>/comment/<commentId>`. Opening it shows the book page, scrolls to the comment and highlights it for ~2 s. A deleted or unknown comment shows "That comment is no longer here" above the thread. A signed-out recipient sees the public book page with "Sign in to see the discussion" (the sign-in returns to the same link). |
| Meeting comments | Meeting threads live in modals with no route, so **v1 shares book comments only**. Meeting comments get no Share button. A `#/meeting/<id>/comment/<cid>` route is a follow-up. |
| Bottom-right overlap | The shell sets `--stacks-native-share-inset: 64px` on `<html>` (a user script, app only) so an app with a fixed bottom-right control can pad for the button, or the page can hide the button with `useShareTarget(null)`. |
| Shell version | `native/ios/VERSION` 1.0.0 → 1.1.0. `minShellVersion` is unchanged: an older shell just has no button. |

## Changes

**Protocol** (`native/protocol/v1.json`): add `share.page` to `calls` and the call list, with a fixture.

**iOS Core** (`native/ios/Core`, Foundation-only, tested on Linux):
- `PageShare.swift`: the per-page state machine. `set(_ args, currentURL)`, `clear()` on commit,
  `target(currentURL:title:) -> ShareTarget?` (nil = hidden), `isVisible(currentURL:)`, default
  URL through `NavigationPolicy.handoffURL`. Rejects non-https `url`.
- `Bridge.swift`: `"share.page": .any`; injected script call list.

**iOS App** (`native/ios/App`):
- `ShareButton` (SwiftUI) overlaid in `ShellView`, bottom-trailing, hidden per the rules above,
  fades while scrolling (KVO on `scrollView.contentOffset`, not the scroll view's delegate, which
  WKWebView owns) and hides with the keyboard (`keyboardWillShow/Hide`).
- `Shell`: holds a `PageShare`, publishes visibility, observes `webView.url` (KVO) to re-evaluate,
  clears on `didCommit`, presents the share sheet from the button (the same `UIActivityViewController`
  code as the `share` handler, factored into one `presentShareSheet(items:title:from:)` that
  anchors the iPad popover to the button).
- `NativeHandlers`: `share.page` handler. A user script sets `--stacks-native-share-inset`.

**`@stacks/native`**: `canShare`, `setPageShare({ url?, title?, text?, hidden? })` (adds `page`,
no-ops when the call is missing), the `Calls` type, fake support, and the README.

**`@stacks/web`**: `useShareTarget`, `useShare` (depends on `@stacks/native`), README section
"Sharing". `@stacks/web/vite` export: `stacksLinkPreview()`.

**Apps**: `templates/app/web/vite.config.ts` and each app's `vite.config.ts` use `stacksLinkPreview()`
(a mechanical, platform-owned rollout). Book Club: a `comment` route in `lib/route.ts`, `BookView`
passing the focused comment to `Thread`, `CommentNode` with a stable `id="comment-<id>"`, the
highlight and the Share button, the missing-comment notice and the signed-out prompt.

**Docs**: `docs/NATIVE_APP_SPEC.md` (Shell behaviour: the Chrome and Share rows, the bridge table,
the build plan line), `docs/PLATFORM_SPEC.md` (SDK surface: sharing), `packages/*/README.md`, and
this spec in `docs/specs/README.md`.

## Tests

- Swift Core (`PageShareTests`): default target is the current URL and title; an override applies
  only while the URL matches `page`; it resets after a URL change and on commit; `hidden` hides
  only that page; a non-https `url` is refused; sign-in plumbing shares the handoff URL. Bridge:
  `share.page` is accepted from any of our main frames, refused from iframes, and present in the
  injected call list. The protocol fixture round-trips.
- `@stacks/native`: `canShare` in the app, with `navigator.share`, and with neither;
  `setPageShare` sends `page` and no-ops on an old shell.
- `@stacks/web`: `useShareTarget` sets on mount, re-sets on change and clears on unmount;
  `useShare` resolves relative URLs, swallows `cancelled` and is unavailable on desktop.
  `stacksLinkPreview` injects the tags, skips existing ones and uses absolute URLs only with `DOMAIN_NAME`.
- Book Club: `parseRoute('#/book/123/comment/c1')`; the Share button is present only when sharing
  is available and shares the right link; a focused comment is scrolled to and highlighted; a missing
  comment shows the notice; signed out shows the sign-in prompt. The demo keeps working.
- `tools/app-conformance` and `tools/new-app` stay green (the template builds with the plugin).

## Acceptance (agent)

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run verify-app -- mofobookklub`,
`cdk synth -c env=staging`, the Swift Core tests (`swift test` in `native/ios/Core`, if a toolchain
is available here; otherwise CI's Linux job).

## Acceptance (owner, after merge)

On DashyHQ Test from TestFlight (1.1.0): the Share button is on the portal and on every app and
opens the share sheet with the page's link; it hides in Gyro Gym's immersive mode. Share a Book
Club comment over Messages; the preview shows Book Club's card; tapping it opens the app on that
comment, highlighted.
