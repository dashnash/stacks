# Native bridge protocol

How web pages (the portal and every app) talk to the Stacks iOS app, DashyHQ. `v1.json` is the
contract: the global the app injects, the request and reply envelopes, the error codes and every
call with an example of its arguments and result. `packages/native` (TypeScript) and `native/ios`
(Swift) both test against it, so change all three together.

- The app injects `window.stacksNative = { protocol, platform, version, calls, call(name, args) }`
  at document start; `call` resolves to the reply envelope. Pages use `@stacks/native`, never this.
- `origins`: `any` (every app and the portal) or `auth` (only the portal's own main frame, on
  `auth.<domain>`). The app answers `forbidden` to anything else, and to iframes.
- New calls are additions to protocol 1. Changing a call's meaning needs protocol 2, and the app's
  `minShellVersion` in `stacks.config.json` bumped when the web starts depending on it.
