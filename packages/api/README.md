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
Keys used by the SDK (don't reuse): `SESSION#…`, `USERSESSIONS#…`, `AUDIT#…`.

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
(approvers: the app's own access page, same rules as the portal grid), `GET /admin/audit` (approvers; `?before&actor&action&limit`).

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
