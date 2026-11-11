# @stacks/native

What a page can ask of the Stacks iOS app (DashyHQ), with web fallbacks, so the same code runs in
Safari, tests and demo mode. Wire format: `native/protocol/v1.json`.

```ts
import { native, NativeError } from '@stacks/native';

native.available;            // true inside the app
native.has('share');         // this app version understands the call
await native.share({ url, text, title }); // share sheet in the app, navigator.share elsewhere
const info = await native.call('app.info'); // { version, build, platform, protocol }
```

- Calls throw `NativeError` with `code`: `unsupported` (not in the app, or an older app), `forbidden`
  (not allowed from this page), `cancelled` (the person backed out), `failed`.
- `auth.google`, `auth.signedOut`, `push.*` and `badge.set` are for the portal only: the app refuses
  them from apps. Apps get push for free: whatever they send with `deps.platform.notify` reaches
  people's phones (the portal registers the device; people mute apps in Settings).
- Hardware (haptics, motion, camera, …) arrives in later phases and will be declared in the manifest.
- Tests and demos: `installFakeNative({ share: () => ({ completed: true }) })` puts a pretend app
  on the page (`remove()` takes it away); `getNative(globalLike)` builds a client for a given global.
- `versionAtLeast(native.version, '1.2.0')` when a feature needs a newer app.
