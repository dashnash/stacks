# #102 Per-route throttles on sign-in, request-access and client-error (SEC-07, OBS-02)

Each HTTP API has one stage-wide throttle (apps 25 rps / burst 50, platform 50 / 100:
`packages/infra/src/app-stack.ts:515`, `platform-stack.ts:253`). A flood of sign-in calls or
signed-out `client-error` reports uses up the whole API, and `client-error`'s "5 per page" limit
exists only in the browser. After this change the sensitive routes have their own, lower caps, so a
flood on them can't take the rest of the API down and the `ClientErrors` graph has a ceiling.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Mechanism | API Gateway HTTP API **route-level throttles only** (`CfnStage.routeSettings`, keyed by route key). Free. No WAF, no per-IP counter. These caps are shared by every caller, not per IP: one client can still use up a route's cap (for example sign-in) but no longer the whole API. The spec says exactly that. |
| Routes need to exist | Route settings apply only to a route of that exact key, and today everything is `ANY /api/{proxy+}`. So add explicit routes with the **same** Lambda integration for each throttled path; `{proxy+}` stays for everything else. |
| Platform caps (rate / burst) | `POST /api/auth/google` and `POST /api/auth/apple`: 5 / 10 each. `GET /authorize` (route already exists): 10 / 20. `POST /api/apps/{slug}/request`: 2 / 5. `POST /api/stacks/client-error`: 2 / 10. (default) |
| App caps (every AppStack) | `GET /api/auth/login`, `GET /api/auth/callback` and `POST /api/auth/silent-finish`: 5 / 10 each. `POST /api/stacks/client-error`: 1 / 5. (default) |
| Where the numbers live | One exported table per stack in `packages/infra/src/throttles.ts` (`PLATFORM_ROUTE_THROTTLES`, `APP_ROUTE_THROTTLES`: `{ routeKey, rate, burst }[]`) used by both stacks and the tests. Stage defaults unchanged. |
| Request-access | No change in code: `requestAccess` already returns the existing grant for a repeat request, so one account notifies approvers once. The route cap only limits many accounts. |
| Responses | A throttled call gets API Gateway's `429 {"message":"Too Many Requests"}`. `@stacks/web` already treats a failed client-error post as fire-and-forget; check that the portal sign-in page shows its generic error on a 429 (no code change expected; add one if it doesn't). |

## Changes

- `packages/infra/src/throttles.ts` (new), exported from `index.ts`.
- `packages/infra/src/platform-stack.ts`: `httpApi.addRoutes` for each platform route key above (same `integration`), then `stage.routeSettings = { '<key>': { throttlingRateLimit, throttlingBurstLimit } }`.
- `packages/infra/src/app-stack.ts`: the same for the app routes (reuse the `HttpLambdaIntegration` instead of creating it inline).
- `packages/infra/README.md`: one line on the caps.
- `docs/PLATFORM_SPEC.md` Security → Throttling (line ~471): "API Gateway throttles each API (apps 25 rps, platform 50 rps) and caps sign-in, request-access and client-error per route (numbers in `packages/infra/src/throttles.ts`). The caps are shared, not per IP."

## Tests (`packages/infra/tests/platform-stack.test.ts`, `infra.test.ts`)

- Every route key in each table exists as an `AWS::ApiGatewayV2::Route` on that stack's API, pointing at the same integration as `ANY /api/{proxy+}`.
- The stage's `RouteSettings` has exactly those keys with the table's numbers, and `DefaultRouteSettings` is unchanged.
- Every cap is below its stage default.
- `{proxy+}` still exists (nothing else lost a route).

## Acceptance (agent)

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, both env synths. Deploy a branch
(`deploy-test.yml`, for `hello`) and check that sign-in still works on staging.

## Acceptance (owner, after merge)

The next Deploy's smoke check is green (it calls `/api/auth/login` and `/authorize`); sign in on production once.

## Out of scope

Per-IP limits (WAF or a counter in code); changing the stage-wide limits.

> Original: **Priority P2 · Severity Low · Effort S** (SEC-07, OBS-02). The spec promises "tighter
> limits on login and request-access", but there is one stage-wide throttle; `POST
> /api/stacks/client-error` accepts signed-out reports and its 5-per-page limit is only in the
> browser. Fix: API Gateway method-level throttles on `/api/auth/*`, `/api/apps/*/request` and
> `/api/stacks/client-error` (platform and app stacks); infra tests; update the spec line.
