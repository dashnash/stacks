# DashyHQ (iOS and iPadOS)

The Stacks platform in a native shell: a web view on the live site, plus native Google sign-in, the
share sheet, universal links, and later push and device features. Spec: `docs/NATIVE_APP_SPEC.md`.

| Path | What |
| --- | --- |
| `Core/` | `StacksShellCore`, a Foundation-only Swift package: link rules (`NavigationPolicy`), the bridge (`BridgeRouter`, protocol types), version and `/native/config` checks. Tested on Linux and macOS: `swift test --package-path native/ios/Core` |
| `App/` | The iOS layer: `Shell` (WKWebView, navigation, offline, last page), `NativeHandlers` (`app.info`, `auth.google`, `auth.signedOut`, `share`), SwiftUI views |
| `project.yml` | XcodeGen spec; the `.xcodeproj` is generated, not committed |
| `Config/*.xcconfig` | Per-environment settings, **generated** from `stacks.config.json` by `node scripts/ios-xcconfig.mjs` (CI fails if stale) |
| `VERSION` | The marketing version; CI sets the build number |
| `../protocol/v1.json` | The bridge contract, shared with `@stacks/native` |

## On a Mac

```bash
brew install xcodegen
```

```bash
node scripts/ios-xcconfig.mjs && xcodegen generate --spec native/ios/project.yml && open native/ios/DashyHQ.xcodeproj
```

Schemes: **DashyHQ Test** (staging, `*.test.iamdashnash.com`) and **DashyHQ** (production; Run uses
Debug with staging settings, Archive uses Production). Needs Xcode 26 (iOS 26 is the minimum).
Native Google sign-in answers "isn't set up in this build yet" until `googleIosClientIds` is in
`stacks.config.json`; the first entry for an environment is that app's iOS client.

## Rules the code keeps

- Our hosts (`<root>` and `*.<root>`, minus another environment's root under it) load in the app;
  the rest of the web opens in Safari; `mailto:`/`tel:`/`sms:` go to the system.
- The bridge answers only top frames on our hosts over https; `auth.*` only on `auth.<root>`.
- Changing the bridge means changing `native/protocol/v1.json`, `packages/native` and `Core` together.
