# Sky Shot

Full spec: `docs/specs/132-sky-shot.md` (owner decisions settled there).

## What it is for

An original retro light-gun arcade game: targets (flat vector birds, clay discs, balloons) fly
across a big screen in a desktop browser, and you aim and fire with an iPhone held like a gun. It is
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
- **Your default tuning**: one per person (by user id), saved by a 5-point calibration or "Save as my
  default"; the screen sends it to every new room.
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
- As a shooter I open the Range and tune the aim live (mode, gains, smoothing, trigger) until it
  feels right, watching accuracy per config.
- As a shooter I calibrate on five dots (centre and corners: point, tap). The fit sets my gain,
  vertical gain and offsets, and is saved as my default for every new room.
- As a shooter without a phone I use the mouse.
- As a shooter I pick a look on the title screen (or press L while playing); it sticks to my account.
- As a shooter I see the leaderboard and my own shot telemetry, and download it.
- As the owner I see everyone's telemetry and remove bad leaderboard rows.
