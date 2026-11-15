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
- `auth.google`, `auth.apple`, `auth.signedOut`, `push.*` and `badge.set` are for the portal only: the app refuses
  them from apps. Apps get push for free: whatever they send with `deps.platform.notify` reaches
  people's phones (the portal registers the device; people mute apps in Settings).
- Tests and demos: `installFakeNative({ share: () => ({ completed: true }) })` puts a pretend app
  on the page (`remove()` takes it away); `getNative(globalLike)` builds a client for a given global.
- `versionAtLeast(native.version, '1.2.0')` when a feature needs a newer app.

## Game kit (manifest `"native": ["motion", "haptics", "screen"]`)

The app answers these only for apps that declare the capability (else `forbidden`); `motion` is a
sensitive capability (code-owner review). Each has a web fallback, so the same code runs in Safari.

```ts
// Motion: CoreMotion at up to 100 Hz in the app, DeviceMotionEvent (~60 Hz) in a browser.
if ((await native.motion.requestPermission()) !== 'granted') { /* show "Enable motion" (a tap) */ }
const stop = native.motion.start({ hz: 100, onError: (e) => show(e.code) }, ({ samples }) => {
  for (const s of samples) use(s.gravity, s.attitude); // also userAcceleration, rotationRate, t
});
stop.source;              // 'native' | 'web' | 'none' (also native.motion.source before starting)
await stop.ready;         // { hz }; rejects with NativeError ('unsupported', 'forbidden')
stop();

await native.haptics.impact('heavy');          // light | medium | heavy | soft | rigid
await native.haptics.notification('success');  // success | warning | error
await native.haptics.pattern([{ t: 0, intensity: 1, sharpness: 0.5 }, { t: 0.1, intensity: 0.5, sharpness: 0.2, duration: 0.3 }]);
await native.screen.lockOrientation('portrait'); // portrait | landscape | any (unlock)
await native.screen.immersive(true);             // no status bar, no swipe-back / pull-to-refresh
await native.screen.keepAwake(true);
```

- Samples use CoreMotion's units and axes in both sources: `userAcceleration` and `gravity` in g
  (flat, face up: gravity `{ 0, 0, -1 }`), `rotationRate` in rad/s, `attitude` `{ roll, pitch, yaw }`
  in rad (pitch > 0: top edge up; roll > 0: right edge down), `t` in seconds since start.
  `options.sensors` picks fields; `source: 'web'` forces the browser's events (to compare).
- One motion stream per page in the app: starting another stops the first. The app stops motion and
  undoes orientation lock, immersive and keep awake when the page goes away, and pauses motion
  while it's in the background.
- On the web: haptics use `navigator.vibrate` where it exists and are otherwise silent (never
  throw for lack of support); `keepAwake` uses the Wake Lock API; `lockOrientation` uses
  `screen.orientation.lock` (`unsupported` when refused); `immersive` is `unsupported`.
- Patterns: at most 32 events within 5 s (`MAX_PATTERN_EVENTS`, `MAX_PATTERN_SECONDS`).

**Demos and tests**: `fakeMotion({ wobble: true })` is a pretend CoreMotion: `installFakeNative({
...motion.handlers, ...fakeGameKit() })`, then `motion.set({ roll, pitch })` tilts it (arrow keys,
drag); with `wobble` it sways on its own when untouched, so screenshots move. A fake handler gets
`(args, { emit })` and `installFakeNative(...).emit(channel, payload)` pushes events.
Helpers: `gravityFor(attitude)`, `sampleFromWeb(event, orientation, t0)`, `MOTION_SENSORS`.

