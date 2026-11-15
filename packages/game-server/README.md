# @stacks/game-server

The runtime for real-time action games (manifest module `gameServer`, which needs `realtime`). Each
room gets its own **server-authoritative** game server: an on-demand arm64 Fargate task running your
`apps/<slug>/game/server.ts`. Players connect to it over WebRTC data channels; clients only send
input and render. Turn-based games don't need this: the API, the table and `realtime` cover them.

The same `defineGame` runs in Fargate, in tests (`playGame` in `@stacks/testing`) and in the
browser demo (`@stacks/demo`), so an app task stays inside `apps/<slug>/`.

## Write a game (`apps/<slug>/game/server.ts`)

```ts
import { defineGame, type GameRoom } from '@stacks/game-server';

interface State { room: GameRoom<Event>; dots: Record<string, { name: string; x: number; y: number }> }
type Event = { shake: string };

export default defineGame<State, Event>({
  tickHz: 20,                                   // simulation + snapshot rate, 1-60 (default 20)
  maxPlayers: 8,                                // can only lower the manifest's limit
  init: (room) => ({ room, dots: {} }),         // the room's state: lives in this server's memory
  onJoin: (s, p) => { s.dots[p.id] = { name: p.name, x: 0.5, y: 0.5 }; },
  onLeave: (s, p) => { delete s.dots[p.id]; },  // left, or dropped and not back within 20 s
  onInput: (s, p, input) => { /* the fast, lossy path: CHECK ITS SHAPE, then apply */ },
  onEvent: (s, p, event) => { if (event === 'bump') s.room.broadcast({ shake: p.name }); },
  tick: (s, dt) => { /* advance by dt seconds (always 1 / tickHz) */ },
  snapshot: (s, forPlayer) => ({ dots: Object.entries(s.dots).map(([id, d]) => ({ id, ...d })) }),
  results: (s) => ({ players: Object.keys(s.dots).length }),   // optional: recorded when the room ends
});
```

- `p` is `{ id, name }`: the user's platform id (bound by a signed join ticket, so nobody can play
  as someone else) and display name.
- `room`: `id`, `players`, `elapsedMs`, `broadcast(event)`, `send(playerId, event)` (both reliable),
  `end(results?)` (ends the game now; results go on the room record).
- `input` and `event` come from a browser: validate them. A callback that throws is logged and
  skipped; the room keeps running (50 failed ticks in a row end it with `error`).
- `snapshot` is sent to each connected player every tick, **unreliably**: a lost one is replaced by
  the next. Keep it under ~1 KB (bigger ones are split across packets and lost more often; the
  runtime warns once, and never sends one over 16 KB). Hide what a player must not see here.
- Anything that must arrive (joins, "round over", bumps) goes through `room.broadcast` / `room.send`.

## What the runtime does

| | |
|---|---|
| Tick loop | Fixed timestep (`dt` is always `1 / tickHz`). After a stall it runs at most 5 catch-up ticks and skips the rest. |
| Rate limits | Per player: 60 inputs/s and 20 events/s by default (`inputsPerSecond`, `eventsPerSecond`); the excess is dropped. Messages over 4 KB are ignored. |
| Reconnects | A dropped player keeps their slot for 20 s: rejoining restores it with no `onLeave`/`onJoin`. A second connection by the same person takes the slot over. |
| Limits | The room ends after `idleMinutes` with no input from anyone (default 10) or `maxHours` in total (default 2); everyone gets "game over" first. |
| Shutdown | On end it writes `ended` and the results to the room record, tells the lobby, closes connections and exits. The API stopping the task (room ended by its creator) does the same. |
| Tickets | Every WebRTC offer carries a 60 s HMAC join ticket from `POST /api/rooms/:id/join`; forged ones get no answer, expired ones a "get a new one". |

## Limits and cost (manifest `gameServer`)

`{ maxRooms: 4, maxPlayers: 8, idleMinutes: 10, maxHours: 2, cpu: 256, memory: 512 }` are the
defaults; see `@stacks/manifest` for the ranges. Over `maxRooms`, creating a room answers 429.

- **Zero idle cost**: no warm pool, load balancer or NAT gateway. A room costs about $0.01 per hour
  (0.25 vCPU / 0.5 GB arm64 Fargate) while it runs, plus cents of logs.
- TURN (only for players whose network blocks UDP; most connect directly): Cloudflare Realtime TURN,
  about $0.05/GB after 1 TB/month free.
- A CloudWatch alarm per app fires if a server's heartbeat reports over 3 hours of uptime.
- Ports: each connected player uses one UDP port from 40000-40019 (20 ports). A 16-player room where
  more than four players reconnect at the same instant can briefly run out; those players retry.

To check that a game bundles and starts: `cd infra && npx cdk synth -c env=staging -c app=<slug>`
writes it to `cdk.out/asset.<hash>.mjs`; `node` on that file stops at "Missing required environment
variable STACKS_ROOM_ID" (it needs a real task's environment past that point).

## Test a game

```ts
import { playGame } from '@stacks/testing';
import game from '../game/server';

const g = playGame(game);                 // fake clock, fake players
const ann = g.join('ann@test.dev');       // id = testUserId(email)
ann.input({ x: 0.9, y: 0.1 });            // unreliable path
ann.event('bump');                        // reliable path
g.advance(1000);                          // a second of ticks
expect(ann.state).toMatchObject({ … });   // latest snapshot; ann.events, ann.roster, ann.over too
```

Also `ann.drop()` / `ann.rejoin()` / `ann.leave()`, `g.stall(ms)` (a frozen server), `g.ended`.
See `packages/testing/README.md`. In the demo (`npm run demo -w apps/<slug>`) the game runs in the
page: pass `game` in `demoOptions()`.

## How it is put together

- `defineGame`, `GameHost` (players, tick loop, limits) and `RoomServer` (signaling, tickets, peers,
  room status) are transport-agnostic and browser-safe (`@stacks/game-server`).
- `@stacks/game-server/node` is the Fargate entry: `runGameServer(game)` wires `RoomServer` to
  AppSync Events (it subscribes to `room/<id>/to-server` over the Events WebSocket and publishes
  answers and room status over HTTP, both with SigV4 and the task role), WebRTC peers and DynamoDB.
- Signaling: a client publishes `{ t: 'offer', sid, ticket, sdp }` then one `{ t: 'ice', sid, c }`
  per candidate on `room/<id>/to-server`; the server answers `{ t: 'answer', sid, sdp }` (all of its
  candidates are in the SDP) on `room/<id>/to/<player>`. Data channels: `state` (`ordered: false,
  maxRetransmits: 0`) and `events` (reliable). Message shapes: `src/protocol.ts`.
- **WebRTC library: `werift`** (pure TypeScript), not `node-datachannel`. Why: it bundles with
  esbuild into the one server file, so a room runs on stock Node 22 with nothing to compile or
  install (no image of its own: see below); the same code runs in the test suite (a real loopback connection in
  `tests/werift.test.ts`). It supports unreliable channels and a fixed UDP port range
  (`icePortRange`). Trade-off: its DTLS/SCTP run in JavaScript, which is fine for a room of 16 at
  20-60 Hz with small messages; a game pushing far more data would want libdatachannel.
- The task binds its VPC address and learns its public one by STUN (`stun.cloudflare.com`,
  `stun.l.google.com`), so its candidates carry the public IP and a port from the range.
- **No image of its own.** Every room runs the official Node 22 image (ECR Public, pinned by digest
  in `packages/infra/src/game-bundle.ts`), which Fargate pulls inside AWS. The app's game is one
  bundled file (this runtime plus `game/server.ts`, built at synth by `bundleGameServer`) uploaded as
  a CDK file asset, like a Lambda's code: deterministic, so it is uploaded again only when the game
  changes. When the API starts a room it passes a 15-minute signed link to it
  (`STACKS_GAME_BUNDLE_URL`); the container's start command fetches it (four tries) and runs it.
  So deploys carry ~5 MB per game, not an image, and nothing in CI needs Docker.
- Logs: one JSON line per entry in the app's game log group; a `heartbeat` line every minute with
  `uptimeSeconds` and `players`.
