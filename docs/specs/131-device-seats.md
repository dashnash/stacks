# Game rooms: seats keyed per device

**Kind:** platform task (`packages/api`, `packages/game-server`, `packages/web`, `packages/testing`,
`packages/demo`, `docs/PLATFORM_SPEC.md`). Needs `@dashnash` review (`CODEOWNERS`); run
`/code-review` on it and check API compatibility, as for any `packages/api/` change. If it ends up
touching `packages/infra/` or `platform/api/`, the agent review gate (#111) applies too.
Issue #131. Unblocks [`132-sky-shot.md`](132-sky-shot.md).

## Why

A room seat is keyed by user id (`PLAYER#<userId>`), the join ticket binds a user, and "a second
connection by the same person takes the slot over." A game where one person uses two devices (Sky
Shot's desktop screen + iPhone gun, or a phone controller for any big-screen game) can't work: each
connection kicks the other off.

## Decision the owner settled (don't reopen)

**Seats are keyed by (user, device)**, not a special "display" role. A user can hold several seats in
one room. The game decides what each seat does.

## What changes

- `POST /rooms/:id/join { device? }`: `device` is a short label chosen by the app
  (`/^[a-z0-9-]{1,16}$/`, e.g. `screen`, `gun`, `gun-2`, `mouse`). Absent means `default`.
- Seat id = `<userId>` for `default` (unchanged, so current games and SDKs behave the same), else
  `<userId>~<device>`. Room items: `PLAYER#<seatId>`. `players` and `maxPlayers` count seats.
- The ticket carries `{ roomId, userId, device, name, exp }`. The takeover rule applies **per seat**:
  a second connection for the same (user, device) still takes that seat over.
- `@stacks/game-server`: `p` becomes `{ id: seatId, userId, device, name }`. `id` stays the key games
  use, so existing games keep working; `room.players`, `send(id, …)` and `snapshot(s, forPlayer)` take
  seat ids.
- Signaling: answers still go to `room/<id>/to/<userId>` (the channel authorizer is per user); the
  `sid` already separates a user's two connections. Each client ignores answers for `sid`s that are
  not its own (check this is already true; add a test either way).
- `@stacks/web`: `useGameRoom(roomId, { device })`; `room.you` includes `device`.
- `@stacks/testing`: `g.join('ann@test.dev', { device: 'gun' })`; `t.games` fakes carry the device.
- `@stacks/demo`: two seats for one persona in one page.
- Optional per-game cap: `defineGame({ maxSeatsPerUser })` (default: unlimited up to `maxPlayers`).

## Compatibility (spec: "Compatibility across a deploy")

Additive: `device` is optional and old clients never send it; old game bundles see `p.id` equal to
the user id as before. A new game bundle that reads `p.userId`/`p.device` must get both from a new
runtime, which it does, because the runtime is bundled with the game. The "one release" rule is met
with nothing to remove later.

## Tests

- API: two joins by one user with different devices get two seats; same device takes over;
  `ROOM_FULL` counts seats; leave frees only that seat; invalid labels give 400.
- Game server: `onJoin` twice for one user, distinct `p.id`; takeover per seat; reconnect within
  20 s restores the right seat.
- Web: two `useGameRoom` hooks on one page (demo) with different devices both go `live`.
- A real loopback (`werift.test.ts`) with two seats for one user.

## Docs

`packages/api/README.md` (rooms table, room item keys), `packages/game-server/README.md` (`p`,
reconnects), `packages/web/README.md` (`useGameRoom` options), `docs/PLATFORM_SPEC.md`.

## How to check it

Staging: `apps/hello`'s game still plays unchanged; a two-device join for one user (a small hello
demo or the Sky Shot app) keeps both connections live.

## Owner steps

None.
