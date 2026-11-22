# Whee: camera calibration (snap the screen, then one tap)

**Kind:** a platform task (Game kit camera capability: `native/ios`, `native/protocol/v1.json`,
`packages/native`; needs `@dashnash` review), then an app task (`apps/sky-shot/`). Issue #167.
Mock screens: https://claude.ai/artifact/TSD52fiY8gxK1YY4SjM8dy

## Why

Aim is good once calibrated, but calibrating is 10 dot taps per phone, one phone at a time, and it
has to be redone for every screen size, seat and grip. This makes it two seconds of holding the
phone up plus one tap, for every phone at once, with today's dots as the fallback.

## Decisions the owner settled (don't reopen)

- Serve **both** aim modes: absolute (camera-measured) and mouse-like (your saved feel).
- Grips **vary by player**, so the snap is a separate pose (held like a camera) and the grip is
  found by one centre tap afterwards.
- A **native** camera capability is fine (a platform change and an iOS build).
- Must handle a TV across a room (2–4 m), a laptop or monitor (under 1 m) and **several phones at once**.
- Joining and calibrating stay **separate steps**: scanning the join QR doesn't calibrate.
- Mouse-like: crossing any screen takes the **same wrist turn**.
- **Quiet correction during play**: small, capped nudges from near misses.
- Fallback when the camera can't be used: today's **two-pass 5 dots**.

## Choices this spec makes (the owner may change them before the build starts)

- **Markers are four QR codes**, one per corner, found with Vision's barcode request
  (`VNDetectBarcodesRequest`, which returns each code's payload and its four corner points). No
  third-party detector. Each payload is `whee-cal:<nonce>:<corner>`; `<nonce>` is a random per-room
  value, not the join link, so a snap can't calibrate against the wrong screen or join anything.
- **Rays, not distance.** The call returns the direction from the phone to each code (unit vectors
  in the motion stream's reference frame), which is all aiming needs. No physical screen size, no
  depth. Snapping from somewhere other than your seat is a known limit (the copy says "from where
  you'll play"); ARKit triangulation can come later if it matters.
- **The page never sees camera frames.** The app shows its own full-screen camera view with Cancel
  and returns geometry only.
- **No web fallback for the camera** in v1: Safari and older apps get `unsupported` and the dots.

## What changes

### PR 1: Game kit camera capability (platform)

- Manifest `"native": ["camera"]`; a **sensitive** capability like `motion` (code-owner review).
  `NSCameraUsageDescription`: "Apps you use in DashyHQ can use the camera to find your screen when
  you calibrate a game." Protocol `v1.json` gains `camera.locate`.
- `native.camera.locate({ codes: string[], holdMs = 1500, timeoutMs = 10_000 })` →
  `{ found: { [payload]: { corners: [Vec3, Vec3, Vec3, Vec3] } }, t }`.
  - Shows the app's camera view (with a "4 of 4 · hold still" line the call's options can label)
    and resolves once every code in `codes` has been seen steadily for `holdMs`: corners averaged
    over that hold, each a unit vector in the same reference frame as `motion` attitude
    (CoreMotion `xArbitraryZVertical`), so the page can combine them with motion samples.
    The app does the camera-to-device rotation and lens intrinsics.
  - Throws `NativeError`: `unsupported` (no camera or an old app), `forbidden` (capability not
    declared, or camera permission refused), `cancelled` (Cancel), `failed` with
    `reason: 'timeout'` (not all codes seen within `timeoutMs`).
  - Needs `motion` running (it reads the attitude at each frame); one call at a time per page; the
    camera stops when the call settles or the page goes away.
- Fakes: `fakeCamera({ locate })` for `installFakeNative`, plus a helper
  `screenRays({ yaw, pitch, widthRad, aspect })` that returns the corner rays of a pretend screen,
  for tests and demo mode.
- Docs: `packages/native/README.md` (Game kit), `docs/NATIVE_APP_SPEC.md`, `PLATFORM_SPEC.md` if the
  capability list is there.

### PR 2: Whee (app task)

1. **Snap step** on every controller connect, replacing Initialize when the app has `camera`
   (`native.has('camera.locate')`):
   - The screen shows four QR codes at its corners (about 12% of the window's height, white margin,
     on a light ground so a TV's contrast holds) with "Hold your phone up and snap this screen".
   - The phone calls `native.camera.locate` with the room's four payloads.
   - From the four corner rays, derive the existing absolute parameters: the reference pose
     pointing at the screen's centre (where the diagonals cross), `fovGain` from its angular width
     and `ratioY` from angular height over width. The perspective error of the existing linear
     model is small for a seated player; switch to a homography only if tests show over 1% error.
2. **Centre tap** in the player's grip, with a live crosshair: the phone's attitude at the tap and
   the measured centre ray give the barrel axis in the phone's frame, so every grip works. Then
   the stage is done (`calibrated` with `stage: 'snap'`).
3. **Several phones at once:** snap and centre tap don't use the shared dots, so they run in
   parallel, each with its own crosshair colour. The codes stay up while anyone is calibrating; the
   lobby lists each player's state; Start stays disabled until everyone is ready or skipped.
   Dots (the fallback) keep today's one-at-a-time queue.
4. **Mouse-like feel:** sensitivity is already in screen widths per radian, so the same wrist turn
   crosses any screen. Your saved default (`PUT /tuning`) loads on connect, so nothing is redone
   on a new screen. The snap sets the centre for `place`.
5. **Quiet correction during play** (Rounds and Range, never Training):
   - Only shots that miss by under 1.5× the target's radius count.
   - Absolute: move `offsetX/Y` by 5% of the error per shot.
   - Mouse-like: if a jump overshoots (error along the move's direction), lower the gain by
     5% of the relative error; raise it if it falls short.
   - Total change capped at ±0.05 screen widths of offset and ±15% of gain from the calibrated
     values; reset on Re-calibrate. Nothing is shown; the room's telemetry keeps the drift.
6. **Fallback:** the two-pass 5 dots when `locate` throws (`unsupported`, `forbidden`,
   `failed`), with the reason on the phone and "Try camera again". `cancelled` returns to the snap
   step's choice ("Snap again" or "Use dots").
7. **Re-calibrate** (menu): snap and tap again; "Use dots" runs the dots' step 2.

## Tests

- `packages/native`: `camera.locate` over the bridge (found, each error code, `has`), the fake and
  `screenRays`.
- Whee:
  - From `screenRays` for a TV (31° wide) and a laptop (40° wide), with and without a pistol grip,
    after the centre tap the crosshair lands within 1% of each corner and the centre.
  - Several phones calibrate at once; Start waits for all.
  - Every fallback path ends in the two-pass dots.
  - The correction during play converges on a biased player and never passes its caps; it's off
    in Training; Re-calibrate resets it.
  - Demo mode uses the fake camera.

## Merge plan

1. PR 1 (Game kit camera capability): wait for deploy.
2. PR 2 (Whee camera calibration): wait for deploy. Safe before the app build: older apps get
   the dots.
3. Owner: build and install the iOS app with the camera capability (TestFlight), then try a snap
   on the TV and a laptop.

## Owner steps

- The iOS build with `NSCameraUsageDescription` (and agreeing to the permission text above).

## Later (not in this spec)

- ARKit triangulation, so a snap from elsewhere in the room still holds.
- A web camera fallback (`getUserMedia` plus a JS QR detector) for Safari.
- A homography for absolute aim if seated perspective error turns out to matter.

## How to check the work

- `npm test -w packages/native -w apps/sky-shot`, `npm run verify-app -- sky-shot`.
- On staging with the new app: join from two phones, snap and tap on each at the same time, then
  play Rounds in absolute mode: the crosshair lands on what you point at, from your seat, on a TV
  and on a laptop.
