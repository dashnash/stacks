# Whee

Formerly Sky Shot. The slug stays `sky-shot` (slugs are immutable: the subdomain and the stack name).

Full spec: `docs/specs/132-sky-shot.md` (owner decisions settled there).

## What it is for

An original point-and-tap arcade game, a deliberately over-engineered take on motion-controller party
games: targets fly across a big screen in a desktop browser, in the look you pick, and you aim with
an iPhone and tap (or flick). It is
also a test bench: the aim mapping (absolute, relative, hybrid) and the trigger (tap, flick) are
tunable live, and every shot is logged with its motion so the best approach can be found by playing.

## Who uses it

Signed-in members of DashyHQ, with a desktop browser and an iPhone (the DashyHQ app at 100 Hz, or
Mobile Safari at ~60 Hz). No phone: the mouse plays too.

## Roles

- **Owner** (`OWNER`): manages access; sees everyone's telemetry; can remove leaderboard rows.
- **Shooter** (`SHOOTER`, default): plays; sees their own telemetry.

## What it tracks

- **Game room** (platform `gameServer`): one screen seat, up to two gun seats (or a mouse seat).
- **Leaderboard entry**: user, name, best Rounds score, accuracy, rounds reached, when.
- **Session**: room id, mode, score, accuracy, rounds, shooter, saved once per room.
- **Shot** (30-day TTL): time, config id, trigger, hit, miss distance, rewind, latency, motion window.
- **Tuning config**: stored once per config id next to the shots.
- **Your default tuning**: one per person (by user id), saved by a 5-point calibration, a training
  fit or "Save as my default"; the screen sends it to every new room.
- **Training run** (90-day TTL): the fit report (before/after, both tunings), the trials, and the raw
  motion at 25 Hz, so runs can be refitted when the fitter improves.
- **Your look**: one per person (by user id), the theme and palette you picked; signed out, kept in
  the browser. The screen tells the room, the phone follows it, and each shot records it.

## What signed-out visitors see

The title screen, the leaderboard (first names) and "Sign in to play". The demo is the signed-out
way to see it move.

## Look and feel

Switchable looks (spec `docs/specs/144-sky-shot-themes.md`); the game is the same in every one.
**Dusk** (the default): flat vector arcade, bold shapes and colours on a dusk-sky gradient, chunky
type, no pixel art. **Ink Koi**: sumi-e brush painting on rice paper (or a moonlit pond).
**Neon Courier**: synthwave wireframe over a scrolling grid (midnight or amber). **Stargazer**:
a cut-paper night sky (dusk or indigo).

## User stories

- As a shooter I press Play, scan the QR with my iPhone, calibrate, and shoot targets in Rounds.
- As a shooter I don't wait for a game server at Play: the title screen (on a desktop) starts one
  while I read it (`usePrewarmRoom`, #152), and Play, Range or Train takes it over.
- As a shooter I open the Range and tune the aim live (mode, gains, smoothing, trigger) until it
  feels right, watching accuracy per config.
- As a shooter I calibrate on five dots (centre and corners: point, tap). The fit sets my gain,
  vertical gain and offsets, and is saved as my default for every new room.
- As a shooter I run Training (about 2 minutes: follow a dot, and point at new dots with the
  crosshair hidden). The room fits sensitivity, accel curve, vertical gain, smoothing, prediction and
  deadzone to how I move, shows before/after, lets me compare blind (A/B), and saves the winner as my
  default for every new room.
- As a shooter without a phone I use the mouse.
- As a shooter I pick a look on the title screen (or press L while playing); it sticks to my account.
- As a shooter I see the leaderboard and my own shot telemetry, and download it.
- As the owner I see everyone's telemetry and remove bad leaderboard rows.

## Training and the fit (`game/training.ts`, `game/fit.ts`)

- **Script** (31 trials, ~2 min): 24 jumps with the crosshair hidden (4 distances × 6 directions),
  4 smooth tracks at rising speeds, 3 holds. The crosshair is put on the start dot of each trial
  (training aims in relative mode).
- **Gain** comes from the hidden jumps: without a crosshair to correct against, where you stop is
  your own sense of "this far". For each accel curve on a grid the best sensitivity is a least-squares
  fit; the curve with the smallest endpoint error wins. Vertical gain is fitted separately.
- **Feel** (smoothing cutoff and β, prediction, deadzone) is fitted by replaying all the motion
  through the game's own `Aim`: as little lag (against your intent, as it reaches the screen) as
  possible while the shake while holding still stays under ~1.5 px.
- Fitting runs in the room in 8 ms slices per tick, then the screen shows before/after and offers
  a blind A/B: two 20 s Range rounds, fit and yours in random order, then "which felt better?".
- Turning is read about the room's vertical and the horizontal axis across the barrel, so the grip
  (flat, pistol, tilted) doesn't matter.
