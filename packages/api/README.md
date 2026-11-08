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
- `v` (signed-in routes): `user` `{ email, name, pictureUrl? }`, `role`, `canManageAccess`, `deps`, `manifest`.
- `ctx` (public routes): `deps`, `manifest`, `await ctx.viewer()` (the caller or `null`).
- Return `{ status?, body?, headers?, cookies?, redirect?, audit? }`. Throw `badRequest`, `unauthorized`,
  `forbidden`, `notFound`, `conflict` (or `new HttpError(status, msg, code)`); clients get `{ error, code }`.
- Validators: `requireString(body, field, max?)`, `optionalString`, `optionalUrl`, `optionalInt(body, field, min, max)`, `requireIsoDate`.
- Roles come from the manifest; naming an undeclared role throws at startup.
- Non-GET requests must carry `X-Stacks-Request: 1` (the web SDK always sends it).

## Data: `v.deps.store` (one DynamoDB single table per app)

```ts
await store.put({ PK: 'ITEMS', SK: `${createdAt}#${id}`, GSI1PK: `BY#${email}`, GSI1SK: createdAt, ...item }, { ifNotExists: true });
await store.get<T>(pk, sk);         await store.delete(pk, sk);
await store.query<T>(pk, skPrefix?); // ascending by SK
await store.queryGsi1<T>(gsi1pk, { descending: true });
```

`strip(item)` drops the keys. `ConditionFailedError` is thrown by `ifNotExists` on a duplicate.
Keys used by the SDK (don't reuse): `SESSION#…`, `USERSESSIONS#…`, `AUDIT#…`.

## People and access (the platform owns them)

```ts
import { appMembers, getPeople } from '@stacks/api';
const members = await appMembers(deps);                  // [{ email, name, pictureUrl?, role }], cached 30 s
const people = await getPeople(deps, emails);            // Map email -> { email, name, pictureUrl? } ("Former member" if gone)
await deps.platform.notify(email, 'Your pick won', url);  // into their platform inbox (members only)
```

## Built-in routes

`GET /health`, `GET /auth/login?return=/path`, `GET /auth/callback`, `GET /auth/session`,
`POST /auth/logout`, `GET /stacks/bar` (portal bar), `GET /stacks/members` (members),
`GET /stacks/access` + `PUT /stacks/access/:email {role|null}` (approvers: the app's own access
page, same rules as the portal grid), `GET /admin/audit` (approvers; `?before&actor&action&limit`).

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
await content.list('eggs/faces/');           // keys, cached 10 min
```

Other: `recordAudit(deps, user, { action, label, details })`, `listAudit`, `endUserSessions(deps, email)`.
