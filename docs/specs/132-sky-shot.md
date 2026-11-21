# Sky Shot: a desktop screen, an iPhone light gun

**Kind:** app task (`apps/sky-shot/` only), after the platform change in
[`131-device-seats.md`](131-device-seats.md) has shipped. Issue #132.

An original game in the retro light-gun genre: targets fly across a big screen (a desktop browser);
you aim and fire with an iPhone held like a gun. It combines what Gyro Gym proved (CoreMotion at
100 Hz through the Game kit) with `@stacks/game-server` rooms. It is a **prototype and a test
bench**: the aim mapping and the trigger are tunable live in the game, so the best approach can be
found by playing rather than guessed.

It is not a copy of any existing game: no ducks, dog, sprites, sounds, level layouts or look from
one. Targets are our own (flat vector birds, clay discs, balloons).

## Decisions the owner settled (don't reopen)

| Topic | Decision |
| --- | --- |
| Transport | `gameServer` rooms (server-authoritative, WebRTC to Fargate). |
| Screen vs controller | Two **seats keyed per device** for the same user (platform change, own spec). |
| Pairing | The screen shows a QR code (a universal link to the controller page with the room id); the iPhone camera opens it in DashyHQ. The 4-char room code is shown under it as a fallback. |
| Aim | Not fixed: **absolute**, **relative** and **hybrid** mapping, all tunable live from a panel on the screen. |
| Where the mapping runs | On the **game server**. The phone streams raw motion; the tuning config lives in room state. |
| Trigger | **Tap** and **flick**, both in v1, chosen in the tuning panel. Volume button: phase 2 platform spec ([`133-volume-buttons.md`](133-volume-buttons.md)). |
| Hit truth | Server, **with lag compensation** (rewind targets to what the screen showed). |
| Players | 1 gun in v1; state, protocol and UI designed for 2 (per-seat crosshair colour, per-seat score). |
| Modes | **Rounds** (the game) and **Range** (slow or static targets for tuning). |
| Look | Flat vector arcade: bold shapes and colours, no pixel art. Now the **Dusk** theme; more looks in [#144](144-sky-shot-themes.md). |
| Audience | Signed-in members only. Controller in DashyHQ (100 Hz) **and** Mobile Safari (DeviceMotion, ~60 Hz). Desktop mouse fallback. In-browser demo with a fake phone. |
| Persistence | **Leaderboard** and a **shot telemetry log**. No saved tuning presets. |
| Telemetry path | A capped buffer in the room's `results`; the app API copies it to the app table (30-day TTL). |

## Roles

- **Owner** (`OWNER`): manages access; sees every player's telemetry; can remove leaderboard rows.
- **Shooter** (`SHOOTER`, default): any signed-in member. Plays and sees their own telemetry.

Signed-out visitors see the title screen, the leaderboard (first names) and a "Sign in to play"
button. The demo (below) is the signed-out way to see it move.

## Manifest

```json
{
  "slug": "sky-shot", "name": "Sky Shot", "category": "Games", "visibility": "public",
  "modules": ["realtime", "gameServer"],
  "native": ["motion", "haptics", "screen"],
  "gameServer": { "maxRooms": 4, "maxPlayers": 3, "idleMinutes": 10, "maxHours": 1 }
}
```

`maxPlayers` counts seats: one screen plus two guns. `motion` is a sensitive capability, so it needs
code-owner review even though this is an app task.

## Screens

### Screen (desktop, `/`)

1. **Title**: Play, Range, leaderboard, your best score.
2. **Pair**: `POST /rooms`. Shows "Starting…" (30-60 s) and then a QR code + room code. Joins the
   room as device `screen`. "Use mouse instead" skips pairing (mouse seat, see below).
3. **Calibrate**: "Point your phone at the dot and tap." A dot in the centre (absolute or hybrid
   mode), or "Wave to find your crosshair" (relative mode).
4. **Play**: full-window canvas (`requestAnimationFrame`, interpolated with `createStateBuffer`),
   score, round, shots left, hit quota. On a hit the target pops; on a miss a brief muzzle flash at
   the crosshair.
5. **Tuning panel** (toggle `T`, a slide-over on the right; usable mid-round, pauses Rounds but not
   Range): every knob below, plus the diagnostics.
6. **Results**: score, accuracy, leaderboard position, "Play again" (same room, no new pairing).

### Controller (phone, `/gun?room=<id>`)

- Asks for motion permission (a tap; in Safari this is the browser prompt), then joins as device
  `gun`.
- Most of the screen is the **trigger area** (tap mode); a small **Calibrate / re-centre** button;
  **shots left** and **round** mirrored from the server; connection and latency chip.
- In flick mode the trigger area becomes "Flick to fire" and a tap does nothing (to avoid double
  fire), except on Calibrate.
- **Haptics**: `rigid` impact per shot, `success` on a hit, a short pattern on round end, `warning`
  when out of shots. Web: `navigator.vibrate` where it exists (none on iOS Safari: silent).
- **Screen kit** while playing: immersive, keep awake, orientation lock (portrait by default; the
  tuning panel can choose landscape to try holding it sideways).

## Game server (`apps/sky-shot/game/server.ts`)

- `tickHz: 60` (crosshair smoothness and hit timing). Check the werift note in the
  `@stacks/game-server` README: 3 seats at 60 Hz with small snapshots is well inside it.
- **Seats**: `screen` (one; sends tuning and mode events, no motion), `gun` (up to two), `mouse`
  (a gun whose input is already a crosshair position, for the desktop fallback).

### Input (unreliable, ≤ 60/s per gun)

The phone batches its 100 Hz samples (Safari ~60 Hz) and sends the latest batch every 16 ms:

```ts
type GunInput = {
  seq: number;                     // increasing; the server drops stale ones
  t: number;                       // phone clock, seconds (motion sample time base)
  samples: Array<{ t: number; q: [number, number, number, number];  // attitude as a quaternion
                   r: [number, number, number];                     // rotationRate rad/s
                   a: [number, number, number] }>;                  // userAcceleration g
};
```

Quaternion, not roll/pitch/yaw, so absolute mapping has no gimbal flips near vertical. If
`@stacks/native` only exposes Euler `attitude`, build the quaternion from it on the phone; adding
`attitude.quaternion` to the SDK is a small platform follow-up, not needed for v1. Validate the
shape and clamp values; keep the message under 4 KB (≤ 8 samples per batch).

### Events (reliable)

- Gun → server: `{ shot: { seq, t } }` (tap mode; `t` on the phone clock), `{ calibrate: { t } }`.
- Screen → server: `{ tune: Partial<Tuning> }`, `{ mode: 'rounds' | 'range' }`, `{ start }`,
  `{ pause }`, `{ ack: { snapshotTick, t } }` (for latency, below).
- Server → all: `hit`, `miss`, `roundStart`, `roundEnd`, `gameOver`, `tuning` (the new config).

### Mapping (raw motion → crosshair), server-side

Each gun keeps a calibration (a reference orientation taken on `calibrate`) and a crosshair in
screen units (`x, y` in 0..1, aspect from the screen seat's viewport).

- **Absolute**: the rotation from the reference to the current quaternion, as yaw/pitch deltas,
  times `fovGain` (screen widths per radian), plus `offset`.
- **Relative**: integrate `rotationRate` (yaw and pitch axes) times `sensitivity`, with an
  `accelCurve` exponent, clamped to the screen.
- **Hybrid**: absolute, plus a slow pull of the reference towards the current pose when the gun is
  near-still (`recentreRate`), plus a relative fine-aim gain for small motions.
- Then for every mode: `deadzone` (rad/s), `smoothing` (one-euro filter: `minCutoff`, `beta`),
  `prediction` (ms of extrapolation to hide latency), `invertX`/`invertY`.

All knobs live in one `Tuning` object with defaults and ranges in code. A config's **id** is a
short hash of the object, so telemetry and accuracy stats group by it.

### Trigger

- **Tap**: the shot event's `t`.
- **Flick**: the server looks for an acceleration spike in the gun's samples: `|a| >
  flickThreshold` (g) along `flickAxis` (any, or the phone's y or z), then `flickCooldown` ms of no
  further shots. The **aim used is the crosshair `flickLookbackMs` before the spike** (default
  ~80 ms), because the jerk itself throws the aim off.

### Hits and lag compensation

- The server keeps ~1 s of target history (positions per tick).
- Clock offset: the gun's `t` is mapped to server time with a running RTT/2 estimate from the
  input stream and the SDK's `rttMs`.
- The **screen** reports, by `ack` events (a few per second), which snapshot tick it was drawing at
  which time. Shot time → the tick the screen showed then (server time − screen interpolation
  delay, ~100 ms with `createStateBuffer`) → test the crosshair (from that moment, or the flick
  look-back) against the targets' positions at that tick.
- Cap the rewind (`maxRewindMs`, default 250) so a lagging connection can't hit long-gone targets.
- Target hitboxes: circles, radius = sprite size × `hitboxScale` (tunable, default 1.1).

### Rounds and Range

- **Rounds**: a round has 10 targets released one or two at a time, 3 shots per release, a hit quota
  to advance (6, then 7, …). Speed and path wobble rise each round; the game ends on a missed quota.
  Score: per hit × round multiplier, accuracy bonus at round end.
- **Range**: endless; static, slow-sweep and pop-up targets at a chosen speed; no shot limit; the
  stats in the tuning panel are reset per config id.

### Snapshot (unreliable, ≤ 1 KB)

Targets (id, kind, x, y, vx, vy, state), crosshairs per gun (mapped and raw, for the overlay),
score, round, shots left, mode, paused. The full tuning config goes by `tuning` events, not every
tick.

### Results (written when the room ends)

```ts
{ mode, score, rounds, accuracy, shooterId, shots: ShotRecord[] }   // shots capped, see below
type ShotRecord = {
  t: number; configId: string; trigger: 'tap' | 'flick'; hit: boolean; missDist: number;
  rewindMs: number; latency: { gunRtt: number; screenRtt: number; shotToPixel: number };
  window: Array<[t, qx, qy, qz, qw, rx, ry, rz, ax, ay, az]>;   // −300 ms .. +100 ms, 25 Hz
};
```

Cap at **500 shots** and round numbers to 4 significant digits, so `results` stays under ~250 KB
(the room record is a DynamoDB item, 400 KB max). Check the size in a test; past the cap, keep the
latest shots and count the dropped ones. The tuning configs are stored once, by id, next to the
shots.

## App API (`apps/sky-shot/api/routes.ts`)

- `POST /api/sessions/:roomId/save`: the screen calls it after `gameOver`. Reads the ended room
  (`gameRooms(...).get`), checks the caller created it, copies the score to the leaderboard and the
  shots to `SHOT#` items with a 30-day TTL. Idempotent (keyed by room id).
- `GET /api/leaderboard`: best score per member for Rounds (top 20, first names). Public.
- `DELETE /api/leaderboard/:userId`: owner only.
- `GET /api/telemetry?configId=&from=`: your shots (the owner: anyone's), paged; also a CSV/JSON
  download for offline analysis.
- People are stored by `v.user.id`.

## Tuning panel diagnostics

- **Latency**: gun → server RTT, screen → server RTT, the screen's interpolation delay and an
  estimated shot-to-pixel time (motion sample → crosshair drawn). Shown live and per shot.
- **Live motion graphs**: attitude, rotationRate and |userAcceleration| for the last 5 s, with the
  flick threshold line (port the Lab's graph from `apps/gyro-gym`, as app code).
- **Accuracy per config**: hits/shots, mean miss distance, time to target (Range), per config id
  for this session.
- **Overlay**: raw crosshair (mapping with no smoothing or prediction) and the mapped one, together.

## Desktop mouse fallback

"Use mouse instead" on the Pair screen: the screen joins a second seat as device `mouse` (same
browser, its own connection) and sends the pointer position as input, and clicks as shots. Same hit
path, so it is also how targets and lag compensation get tested without a phone.

## Demo mode

`npm run demo -w apps/sky-shot`: one page, screen on the left, a simulated phone on the right
(`fakeMotion({ wobble: true })`, arrow keys or drag to aim, space or click to fire, a "Flick"
button that injects an acceleration spike). The game runs in the page (`game` in `demoOptions()`).
Personas: a shooter mid-round, the tuning panel open, Results, the owner's telemetry view.

## Tests

- Game (`playGame`): mapping per mode (known quaternions → crosshair), calibration, recentring,
  flick detection and look-back, lag-compensated hits (a fast target hit at 150 ms latency, missed
  beyond `maxRewindMs`), rounds and quota, two guns, a dropped gun rejoining, `results` size cap.
- API: save is idempotent and creator-only, the leaderboard, telemetry visibility (own vs owner),
  TTL set.
- Web: pairing flow, the controller in tap and flick modes with fake motion, tuning sliders send
  `tune`, conformance (`AccountMenu`, `BuildVersion`, `demoOptions`).
- `npm run verify-app -- sky-shot`.

## How to check it

1. Staging, desktop Chrome: Play → QR. Scan with an iPhone camera → DashyHQ opens `/gun`.
2. Calibrate; the crosshair follows the phone. Switch each mapping mode and trigger in the panel
   mid-Range; the overlay and stats update.
3. Tap mode and flick mode both hit a slow target reliably; the latency panel shows each leg.
4. Same flow with the controller in Mobile Safari.
5. Finish a Rounds game: the score is on the leaderboard; the shots are in telemetry (download).
6. Mouse fallback plays a round with no phone.

## Owner steps

None beyond the platform change's. A room is ~$0.01/hour while it runs.

## Out of scope (v1)

Volume-button trigger (phase 2), saved tuning presets, 2-gun competitive UI polish, sound beyond
WebAudio blips, Game Center.
