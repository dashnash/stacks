# @stacks/api

Server SDK for an app's API. Your app declares routes; auth, sessions, roles, CSRF and the activity
log are handled for you. The same routes run in Lambda, in tests (`@stacks/testing`) and in the
browser demo (`@stacks/demo`).

## Declare routes (`apps/<slug>/api/routes.ts`)

```ts
import { notFound, requireString, type AppDeps, type AppRoutes } from '@stacks/api';

export function routes(api: AppRoutes<AppDeps>) {
  api
    .public('GET', '/public/items', async (req, ctx) => ({ body: { items: [] } }))     // anyone
    .member('GET', '/items', async (req, v) => ({ body: { items: [] } }))              // any role
    .role(['OWNER', 'EDITOR'], 'POST', '/items', async (req, v) => {                    // listed roles
      const title = requireString(req.body, 'title', 200);
      return { status: 201, body: { id: v.deps.newId() }, audit: { label: title } };
    }, { audit: 'item.create' })                                                        // logged
    .approver('DELETE', '/items/:id', async (req, v) => ({ body: { ok: true } }));      // canManageAccess roles
}
```

- Paths are relative to `/api`. `req`: `params`, `query`, `body` (parsed JSON), `headers`, `cookies`.
- `v` (signed-in routes): `user` `{ id, name, pictureUrl?, email? }` (`email` only with `"needsEmail": true`), `role`, `canManageAccess`, `deps`, `manifest`.
  **Store people by `v.user.id`** (a stable `u_…` id), never by email: emails change, and some hide the real one.
  Someone who merged accounts also has `formerIds`: check ownership with `isUser(v.user, storedId)` (not `===`),
  and use `userIds(v.user)` to find all their rows.
- `ctx` (public routes): `deps`, `manifest`, `await ctx.viewer()` (the caller or `null`).
- Return `{ status?, body?, headers?, cookies?, redirect?, audit? }`. Throw `badRequest`, `unauthorized`,
  `forbidden`, `notFound`, `conflict` (or `new HttpError(status, msg, code)`); clients get `{ error, code }`.
- Validators: `requireString(body, field, max?)`, `optionalString`, `optionalUrl`, `optionalInt(body, field, min, max)`, `requireIsoDate`.
- Roles come from the manifest; naming an undeclared role throws at startup.
- Non-GET requests must carry `X-Stacks-Request: 1` (the web SDK always sends it).

## Data: `v.deps.store` (one DynamoDB single table per app)

```ts
await store.put({ PK: 'ITEMS', SK: `${createdAt}#${id}`, GSI1PK: `BY#${v.user.id}`, GSI1SK: createdAt, ...item }, { ifNotExists: true });
await store.get<T>(pk, sk);         await store.delete(pk, sk);
await store.query<T>(pk, skPrefix?); // ascending by SK
await store.queryGsi1<T>(gsi1pk, { descending: true });
```

`strip(item)` drops the keys. `ConditionFailedError` is thrown by `ifNotExists` on a duplicate.
Keys used by the SDK (don't reuse): `SESSION#…`, `USERSESSIONS#…`, `AUDIT#…`, and with the
`gameServer` module `ROOM#<id>` (`META`, `SERVER`, `TASK`, `PLAYER#<seatId>`), `ROOMCODE#<code>` and the GSI1 partition `STACKS#ROOMS`.

## People and access (the platform owns them)

```ts
import { appMembers, getPeople } from '@stacks/api';
const members = await appMembers(deps);                  // [{ id, name, pictureUrl?, role, email? }], cached 30 s
const people = await getPeople(deps, userIds);           // Map id -> { id, name, pictureUrl? } (merged ids resolve; "Former member" if gone)
await deps.platform.notify(userId, 'Your pick won', url); // their platform inbox, and their phones (members only)
```

## Built-in routes

`GET /health`, `GET /auth/login?return=/path`, `GET /auth/callback`, `GET /auth/session`,
`POST /auth/logout`, `GET /stacks/account` (account menu data), `GET /stacks/members` (members),
`GET /stacks/access` (`members`, `pending`, `blocked`) + `PUT /stacks/access/:userId {role|null|"BLOCKED"}`
(approvers: the app's own access page, same rules as the portal grid), `GET /admin/audit` (approvers; `?before&actor&action&limit`),
`POST /stacks/client-error` (browser errors from `@stacks/web`; logged, never stored).
`GET /health` answers `{ ok: true, app, build }`: `build` is the commit the stack runs (`buildSha()`,
`STACKS_BUILD_SHA`, `dev` locally), so the smoke check can spot mixed versions (#105).

## Logs and error refs

Every request is logged for you as one JSON line (`type: "request"`: method, route pattern, status,
`durationMs`, the signed-in `userId`). You only add lines for things you want to find later:

```ts
import { log } from '@stacks/api';

log.info('Reminder sent', { listId, count });   // extra fields: ids and counts
log.warn('Geocoder slow', { ms });
log.error('Could not notify', err);              // an Error (also as a field) logs as { name, message, stack }
```

- Each line carries `type` (`app` for yours), `level`, `app`, `env`, `build` and, inside a request,
  `requestId`, `ref`, `route`, `userId`. No plumbing: the request's context follows your `await`s.
- **Never log** an email, a display name, a request or response body, cookies, headers or a query
  string. Ids (`u_…`, your own record ids) are fine.
- An error you don't catch is a 500 with `{ error, code: 'INTERNAL', ref }`; its stack is logged as
  a `type: "error"` line. `@stacks/web` shows the person "(ref 3f9a2c1b)", and the owner finds the
  request and trace with it (`docs/DEBUGGING.md`). Throwing an `HttpError` (4xx) logs no error line.
- Outside Lambda (tests, the demo) info lines are not printed. In tests, collect lines with
  `captureLogs()` from `@stacks/testing`.
- Use `log`, not `console.*`, in API code: only `log` lines have the fields the dashboard reads.

## Lambda entry (`apps/<slug>/api/index.ts`)

```ts
import { createLambdaHandler } from '@stacks/api/lambda';
export const handler = createLambdaHandler({ manifest, routes });
// own dependencies: createLambdaHandler({ manifest, routes, extend: (base) => ({ ...base, clock: … }) })
```

Content bucket (manifest module `contentPacks`; files in `apps/<slug>/content/` are uploaded, nothing is pruned):

```ts
import { contentStore } from '@stacks/api/lambda';
const content = contentStore();
await content.signUrl('eggs/gatsby.jpg');   // 15-minute private link
await content.list('eggs/faces/');           // keys, cached 10 min (put/delete clear it)
await content.put('eggs/faces/x.jpg', bytes, 'image/jpeg');   // e.g. a member's upload: check type + size first
await content.delete('eggs/faces/x.jpg');
```

Uploads go through your API as JSON (base64). Request bodies are capped at 256 KB, so keep each
request under ~180 KB of file: shrink images in the browser first and send big sets in batches.

Secrets (third-party API keys): declare them in the manifest, never put values in git, env vars or CI.

```jsonc
"secrets": [{ "name": "MAPS_API_KEY", "description": "Where to get it", "optional": true }]
```

```ts
const key = await deps.secret?.('MAPS_API_KEY');   // string | undefined (not set yet); cached 5 min
```

An admin stores each value once per environment (see `docs/SETUP.md`, "App secrets"). Required secrets
that aren't set show as `missingSecrets` on `GET /api/health`. In tests:
`createTestHarness({ manifest, routes, secrets: { MAPS_API_KEY: 'x' } })`.

## Realtime (manifest module `realtime`)

Live events to open pages over the app's own AppSync Event API. Declare **every** channel a browser
may use, with guards (same `v` as routes, plus what the `*` matched); undeclared channels are refused.

```ts
api.realtime
  .channel('list/*', { subscribe: (v, listId) => canSee(v, listId), publish: false })  // server-only
  .channel('room/*', { subscribe: (v) => !!v.role, publish: (v) => !!v.role });          // clients too

await v.deps.realtime.publish(`list/${id}`, { changed: itemId });   // any JSON, ≤ 4 KB
await v.deps.realtime.publish('room/lobby', [a, b, c]);             // an array = one event each
```

- Channels: 1-4 segments of `[A-Za-z0-9-]` (`counter/main`, `room/abc-1`); patterns use `*` for one segment.
- `POST /api/realtime/token { subscribe: [], publish: [] }` (built in, members only, ≤ 20 channels):
  checks each channel's guard and returns `{ token, expiresAt, endpoint, host, namespace }` (15 min).
  `useChannel` in `@stacks/web` calls it; apps never do.
- **At most once, hints only**: clients refetch on every (re)connect (`onResync`). Send ids and small
  changes, not data that exists nowhere else; writes still go through normal routes.
- Without the module, `deps.realtime.publish` rejects with "add realtime to modules".
- Cost: AppSync Events has no idle cost and charges about $1 per million events (connection minutes
  are extra but tiny at household scale). There is no per-app cap yet.
- AWS side: `@stacks/api/realtime-authorizer` is the Event API's Lambda authorizer (`AppStack` wires
  it). Tests: `t.realtime` (`FakeRealtime`) records publishes; see `@stacks/testing`.

## Game rooms (manifest modules `gameServer` + `realtime`)

Session management for server-run games: each room has its own game server (your
`game/server.ts` on `@stacks/game-server`, one Fargate task) that players reach over WebRTC. With the
module on, these member routes exist (you write none of them):

| Route | Does |
|---|---|
| `POST /rooms { name? }` | Creates a room (`{ room }`, 201) and starts its server (30-60 s to `open`), or takes over the caller's warm room (below). 429 `TOO_MANY_GAMES` at the manifest's `maxRooms`. |
| `POST /rooms/warm` | Pre-warms: starts a hidden room for the caller (201), or returns their warm room (200). Not audited; 429 at `maxRooms`; 409 `ALREADY_WARMING` while their last warm-up is still starting. |
| `GET /rooms` | Open and starting rooms with player counts. Also sweeps: rooms whose server is gone or over time are closed. |
| `GET /rooms/:id`, `GET /rooms/by-code/:code` | One room (ended ones stay readable for 7 days, with `results`). |
| `POST /rooms/:id/join { device? }` | `{ ticket, iceServers, channels, player, room }`: a 60 s join ticket for the caller's seat on `device`. 409 `ROOM_FULL` / `ROOM_ENDED` / `ROOM_STARTING`; 400 for a bad label. |
| `POST /rooms/:id/leave { device? }` | Frees that one seat of the caller's. |
| `POST /rooms/:id/end` | Ends it now (its creator, or an approver; others 403). |

- A room: `{ id, code, name, status: 'starting'|'open'|'ended', createdBy: { id, name }, createdAt,
  maxPlayers, players, endedAt?, endedReason?, results? }`. `code` is 4 characters from an alphabet
  without look-alikes (`K7QX`); share it or a link with the id.
- **Seats are per (user, device)**, so one person can be the desktop screen and the phone controller.
  `device` is the app's label (`/^[a-z0-9-]{1,16}$/`: `screen`, `gun`, `gun-2`), `default` when absent.
  Seat id = `seatId(userId, device)`: the user id for `default` (as before devices), else
  `<userId>~<device>`. `player` is `{ id: seatId, userId, device, name }`; `players` and `maxPlayers`
  count seats; joining again from the same device is the same seat (a reconnect or takeover). One
  person holds at most `MAX_SEATS_PER_USER` (4) seats: 409 `TOO_MANY_SEATS` past it.
- **Pre-warming** (#152): call `usePrewarmRoom(enabled)` from `@stacks/web` where a game is likely (a title
  screen), so Play doesn't wait for the cold start. A warm room (`warm: true`, `warmUntil`) isn't listed,
  found by code or joinable. The creator's next `POST /rooms` takes it over (named, listed, joinable, audited,
  already on its way up), unless it is within 30 s of `warmUntil`. Untaken, it ends `unused` after the
  manifest's `warmMinutes` (5). One per person; at `maxRooms` a real `POST /rooms` retires the oldest warm room. A taken room's
  `createdAt` (and so its `maxHours`) counts from the warm-up.
- `useGameRoom(roomId, { device? })` in `@stacks/web` does the joining and connecting; apps call `POST /rooms`,
  `GET /rooms` and `by-code` themselves.
- Channels `room/*`, `room/*/to-server`, `room/*/to/*` are declared for you (members listen to a
  room and to their own answers, one channel per user shared by their devices, and publish offers; only servers publish room status). **Apps can't
  declare channels under `room/`** with the module on: use another prefix.
- `v.deps.games.start(roomId)` / `.stop(roomId)` for apps that create rooms their own way;
  `gameRooms(v.deps, v.manifest)` is what the routes use (`create`, `warm`, `list`, `get`, `byCode`, `join`,
  `leave`, `end`). Without the module every `deps.games` call rejects with "add gameServer".
- TURN (for networks that block UDP) comes from one platform key per environment; without it joins
  return STUN only and `GET /health` lists `missingPlatformKeys`. See `docs/SETUP.md`.
- Tests: `t.games` (`FakeGames`) records `started` / `stopped` and plays the server
  (`await t.games.open(id)`, `.end(id, reason, results)`, `.crash(id)`) and lists seats
  (`await t.games.seats(id)`: `{ id, userId, device, name }[]`); see `@stacks/testing`.

Other: `recordAudit(deps, user, { action, label, details })` (events carry `actorId`), `listAudit`, `endUserSessions(deps, userId)`.

**Maintenance**: while `maintenance` is on in `stacks.config.json`, every route but `/health` answers
503 `MAINTENANCE` and `<StacksProvider>` shows "Back in a few minutes" instead of the app.

**User-id cut-over** (`tools/migrate-user-ids`): an app that stored emails exports
`migrate: ItemMigration` from `api/migrations/user-ids.ts`, built with `composeMigrations(migrateSdkItems,
…yours)` and `renameEmailField(item, 'byEmail', 'byId', idFor)`. New apps need none.

Small helpers apps use:

- `await sha256Hex(text)`: hex SHA-256; `randomToken(prefix)`: unguessable ids.
- `fixtureUserId(email)`: the id demo personas and test users get (`ann@demo.dev` → `u_ann_demo_dev`), for seed data.
- Types for splitting routes across files: `AppRoutes<D>`, `AppDeps`, `Viewer<D>` (the `v` in signed-in
  handlers), `PublicContext<D>` (`ctx`), `RequestContext` (`req`), `RouteResult`, `Item` (a stored row),
  `StacksUser` (`{ id, name, pictureUrl?, email? }`), `Person` (`{ id, name, pictureUrl? }`).
