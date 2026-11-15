# DashyHQ (iOS and iPadOS)

The Stacks platform in a native shell: a web view on the live site, plus native Google sign-in, the
share sheet, universal links, and later push and device features. Spec: `docs/NATIVE_APP_SPEC.md`.

| Path | What |
| --- | --- |
| `Core/` | `StacksShellCore`, a Foundation-only Swift package: link rules (`NavigationPolicy`), the bridge (`BridgeRouter`, protocol types), version and `/native/config` checks. Tested on Linux and macOS: `swift test --package-path native/ios/Core` |
| `App/` | The iOS layer: `Shell` (WKWebView, navigation, offline, last page), `NativeHandlers` (every bridge call), `GameKitHardware` (CoreMotion streamed per frame, haptics, orientation lock, immersive, keep awake; undone when the page goes away) and `NativeConfigStore` (who declared what), SwiftUI views |
| `project.yml` | XcodeGen spec; the `.xcodeproj` is generated, not committed |
| `Config/*.xcconfig` | Per-environment settings, **generated** from `stacks.config.json` by `node scripts/ios-xcconfig.mjs` (CI fails if stale) |
| `VERSION` | The marketing version; CI sets the build number |
| `App/Icon/icon.svg` | The icon's master (an original shuriken, no faces). Edit it, then run `node scripts/render-icons.mjs`: it remakes both PNGs below and the portal's favicon |
| `App/Assets.xcassets` | The app icon (`AppIcon-1024.png`, 1024×1024, opaque) and the staging app's `AppIcon-Test` (the same with a yellow TEST band along the bottom), both rendered from `App/Icon/icon.svg` |
| `../protocol/v1.json` | The bridge contract, shared with `@stacks/native` |

## On a Mac

```bash
brew install xcodegen
```

```bash
node scripts/ios-xcconfig.mjs && xcodegen generate --spec native/ios/project.yml && open native/ios/DashyHQ.xcodeproj
```

Schemes: **DashyHQ Test** (staging, `*.test.dashnash.ninja`) and **DashyHQ** (production; Run uses
Debug with staging settings, Archive uses Production). Needs Xcode 26 (iOS 26 is the minimum).
Native Google sign-in answers "isn't set up in this build yet" until `googleIosClientIds` is in
`stacks.config.json`; the first entry for an environment is that app's iOS client.

## Releases

Every merge to `main` that changes the app (and the 1st of every other month) signs both apps and uploads
them to TestFlight: the **Sign and upload to TestFlight** job in `.github/workflows/ios.yml`. One-time
setup (Apple, Google, GitHub secrets): `docs/IOS_SETUP.md`. Bump `VERSION` for a new marketing version.

CI stamps every build with the commit it was built from (`STACKS_GIT_COMMIT` → Info.plist
`StacksGitCommit` → `app.info`); the portal's footer shows it in the app, e.g. "App 1.0.0 (4201) ·
0123abc". Builds from Xcode say "local". TestFlight's build numbers can only be numbers, so the
**TestFlight notes** job puts the commit in each build's "What to Test" note instead
("Commit 0123abc: <PR title> (#N)" and a link).

Release configs (Staging, Production) sign manually with an Apple Distribution certificate and an
App Store profile that CI makes for each run (the profile's name comes in as `DASHYHQ_PROFILE`). Debug, the config you run from Xcode (both schemes), signs automatically for your
own device.

## Rules the code keeps

- Our hosts (`<root>` and `*.<root>`, minus another environment's root under it) load in the app;
  the rest of the web opens in Safari; `mailto:`/`tel:`/`sms:` go to the system.
- The bridge answers only top frames on our hosts over https; `auth.*` only on `auth.<root>`.
- Changing the bridge means changing `native/protocol/v1.json`, `packages/native` and `Core` together.
