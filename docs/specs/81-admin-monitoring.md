# #81 Monitoring on the portal's admin pages

#75 built the troubleshooting setup: JSON request logs with a ref, browser error capture, the
CloudWatch dashboards `stacks-prod` / `stacks-test` and six saved Logs Insights queries. To use any
of it the owner has to sign in to the AWS console. After this change the portal has a
**Monitoring** page at `auth.<domain>/#/admin/monitoring`, for platform admins only. It shows the
same graphs and tables and runs the saved queries on the page, using the portal's own Google
sign-in.

This is a **platform task** (`platform/api`, `platform/web`, `packages/infra`): it needs `@dashnash`
review and the agent review gate (#111). No app changes.

Mock UI (interactive, made-up data): https://claude.ai/artifact/9TiZNNxa7pn7xZxQYiCmio

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| How | A **native portal page**. The platform API reads CloudWatch (`GetMetricData` with the dashboard's `SEARCH` expressions, and Logs Insights `StartQuery`/`GetQueryResults`), and the portal draws the charts and tables itself. No iframe, no CloudWatch dashboard sharing, no Cognito, no CSP change, no new vendor. |
| Who | **Platform admins only** (`isPlatformAdmin`). Everyone else gets 403 from the API, and the page shows "Platform admins only". App approvers see nothing new. |
| Which environment | **Each portal shows its own**: `auth.dashnash.ninja` shows `prod`, `auth.test.dashnash.ninja` shows `test`. Each platform Lambda can start queries only on `/stacks/<its tag>/*` log groups. |
| Content | (1) a per-app **health table** (registered apps and the platform only), (2) **graphs** (the dashboard's seven), (3) the **Latest errors**, **Slowest requests** and **Browser errors** tables (Browser errors is its own table), (4) **Find by ref**, (5) **One user's trail** (click a user, or paste an id), (6) **One app's requests** (when an app is selected). |
| Time range | Presets **1h / 24h / 7d / 30d**, default 24h. No custom from/to. Log tables cover at most the log retention (1 week on staging, 1 month on production); the page says so when the range is longer. |
| Names | The API resolves user ids in its answers to the person's name and email from the platform table, at read time. **Logs stay as they are** (ids only); names are never written to CloudWatch. |
| Refresh | Loads once when opened, plus a **Refresh** button. A **"Refresh every 60s"** checkbox (off by default, not remembered) refreshes the health table, the graphs and the three tables while the tab is visible. Find by ref and the user trail never refresh automatically. |
| Entry point | A **Monitoring** tab in the portal header next to Access, shown only to platform admins. No account-menu item, no link from `ErrorNote`. |
| CloudWatch console | **Kept** (dashboards and saved queries unchanged). The page links to the CloudWatch dashboard, and `docs/DEBUGGING.md` starts with the page. |
| Charts | Hand-drawn inline SVG in `platform/web` (line charts, hover readout). **No new npm dependency.** |
| Query safety | The client never sends query text. It names one of the six saved queries plus validated parameters; the API builds the query from `SAVED_QUERIES` (moved where both infra and API can read it, see Changes). |
| Log groups | The API lists `/stacks/<tag>/*/api` log groups with `DescribeLogGroups` (cached 5 min) instead of a fixed list. A new app's logs show up on the page with no platform deploy, and an app that was never deployed can't break a query (a group deleted since the cache: the list is refreshed and the query retried once). At most 50 (Logs Insights' limit), the platform's always included; more logs a warning. |
| Health dot | The Server errors column is `ServerErrors` (5xx request lines, which include every unhandled error; hover shows how many were unhandled). Red if the app had any server error in the range; amber if it had browser errors or p95 > 1,500 ms; else green. It is a hint for the eye, not an alert. |
| Alerts | Still none. Nothing new pushes, emails or alarms. |

## API (`platform/api`, all `signedIn` + platform admin, else 403)

All three routes live under the existing `/api` router next to `/admin/audit`.

### `GET /api/admin/monitoring/metrics?range=1h|24h|7d|30d`

One `GetMetricData` call with these expressions (the same as `Monitoring` in `packages/infra`):

| id | Expression |
| --- | --- |
| `requests` | `SEARCH('{Stacks/<tag>,app} MetricName="Requests"', 'Sum', P)` |
| `serverErrors` | `… MetricName="ServerErrors" …` Sum |
| `unhandled` | `… MetricName="UnhandledErrors" …` Sum |
| `clientErrors` | `… MetricName="ClientErrors" …` Sum |
| `p95` | `… MetricName="DurationMs" …` p95 |
| `lambdaErrors`, `lambdaThrottles`, `lambdaP95` | `SEARCH('{AWS/Lambda,FunctionName} MetricName="Errors" stacks <tag>', …)` etc. |
| `ddbThrottles` | `SEARCH('{AWS/DynamoDB,TableName,Operation} MetricName="ThrottledRequests" stacks <tag>', 'Sum', P)` |

Period P: 1h → 60 s, 24h → 300 s, 7d → 3,600 s, 30d → 10,800 s. A second, cheap set of the five
`Stacks/<tag>` expressions with P = the whole range gives the health table's totals (p95 over the
whole range can't be summed from buckets).

```jsonc
{
  "env": "prod", "range": "24h", "from": "…ISO", "to": "…ISO", "periodSeconds": 300,
  "consoleUrl": "https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards/dashboard/stacks-prod",
  "apps": [ { "app": "platform", "requests": 1820, "serverErrors": 0, "unhandled": 0, "clientErrors": 1, "p95Ms": 212 } ],
  "graphs": [
    { "id": "requests", "title": "Requests per app", "unit": "count",
      "series": [ { "label": "hello", "app": "hello", "points": [[1763700000000, 12]] } ] }
  ]
}
```

`series.label` is the `app` dimension for our metrics and the function/table name for AWS's; `app` is
set when the label belongs to an app (`stacks-<tag>-app-<slug>-…` → `<slug>`, `stacks-<tag>-platform-…`
→ `platform`), so the page can filter AWS graphs by app. Missing buckets are absent, not zero.

### `POST /api/admin/monitoring/query` (CSRF header as usual)

Body: `{ query, range, ref?, userId?, app? }`, where `query` is `latestErrors`, `slowestRequests`,
`browserErrors`, `findByRef`, `userTrail` or `appRequests`.

- `ref` must match `/^[A-Za-z0-9_+/=-]{8}$/` (API Gateway request ids are base64-like) (required for `findByRef`); `userId` `/^u_[A-Za-z0-9_-]{1,64}$/`
  (required for `userTrail`); `app` must be `platform` or a registered slug (required for
  `appRequests`, optional filter on the others). Anything else is 400.
- The API substitutes the value into the saved query (`PASTE-REF`, `u_PASTE-USER-ID`, `APP-SLUG`);
  the optional `app` filter adds `| filter message.app = "<slug>"`.
- `StartQuery` over the listed log groups with the range (clamped to the retention), then polls
  `GetQueryResults` once (holding the request open would inflate the platform's own `DurationMs` and
  Slowest requests). Answer: `{ queryId, status: "Running" | "Complete" | "Failed" | …, rows?, people? }`.

### `GET /api/admin/monitoring/query/:queryId`, `DELETE /api/admin/monitoring/query/:queryId`

Only for queries this portal started: `POST` records the id in the platform table for an hour
(`MONQUERY#<id>`, TTL), and any other id is a 404, so a staging admin can't read a production query's
rows by its id (`GetQueryResults` has no resource-level permission). `GET` polls once: same answer
shape. `DELETE` stops the query (`StopQuery`); the page calls it when nobody waits for a query any more
(range, app or page changed), since Logs Insights runs a limited number of queries at once. The client polls every second until `Complete` (max 60 s, then "The
query took too long; try a shorter range").

Rows are objects keyed by the field name without `message.` (`ts`, `app`, `type`, `route`, `status`,
`durationMs`, `ref`, `userId`, `error`, `stack`, `path`, `source`, `clientBuild`, …). `limited: true`
means the saved query's limit was reached. The trail is fetched newest first (so the limit keeps the
latest 500 lines) and answered oldest first. `people` maps
each `userId` in the rows to `{ name, email }` (unknown or merged-away ids are left out: a merged id is never shown with the survivor's name; the
page shows the id only).

### Implementation notes

- New `platform/api/src/monitoring.ts`: the routes' logic behind a small `Monitor` interface in
  `deps` (`getMetricData`, `startQuery`, `getQueryResults`, `listApiLogGroups`), so tests use a
  fake. The AWS implementation (`@aws-sdk/client-cloudwatch`, `@aws-sdk/client-cloudwatch-logs`)
  goes in `aws.ts` next to the registry.
- `SAVED_QUERIES`, `metricNamespace`, `logGroupName`, `dashboardName` move from
  `packages/infra/src/monitoring.ts` to `packages/manifest/src/monitoring.ts`, exported as
  `@stacks/manifest/monitoring`: the one dependency-free package both `packages/infra` and
  `platform/api` already depend on. `packages/infra` re-exports them, so nothing else changes.
- New deps on `platform/api`: `@aws-sdk/client-cloudwatch` and `@aws-sdk/client-cloudwatch-logs`
  (same major as the existing SDK clients; neither has install scripts). They go in the Lambda
  bundle like the others.
- `SAVED_QUERIES.userTrail` also returns `message.userId`, so the trail's heading can name the person
  (the console query gains a column, nothing else).
- Every route logs nothing new beyond the normal request line (no query text, no rows).
- Errors from CloudWatch become a 424 `{ error: "CloudWatch didn't answer: <AWS error name>" }` (not a
  5xx: the request line would count as a platform server error and turn the platform red on this page),
  logged with `log.warn`.

## IAM (`packages/infra`)

`platform-stack.ts`, on the platform handler:

- `cloudwatch:GetMetricData` on `*` (it has no resource-level permission).
- `logs:StartQuery` on `arn:aws:logs:<region>:<account>:log-group:/stacks/<tag>/*` (resource-scoped
  to the environment).
- `logs:GetQueryResults`, `logs:StopQuery`, `logs:DescribeLogGroups` on `*` (no resource-level
  permission).

`ci-stack.ts`: add `cloudwatch:GetMetricData` to the staging boundary's `AppRuntime` statement
(`logs:*` is already there). Without it the staging page's graphs fail with "not authorized"; the
log tables still work.

Known limit, written into the spec: `GetMetricData` can't be scoped by namespace, so the staging
Lambda *could* read production's metric numbers (counts and durations; no ids, no log text). The
code only asks for its own. Logs, which hold user ids, are scoped.

## Web (`platform/web`)

- `App.tsx`: header tab **Monitoring** (`#/admin/monitoring`) when `me.user.isPlatformAdmin`; route
  to `views/Monitoring.tsx`.
- `views/Monitoring.tsx`, top to bottom (see the mock):
  1. Title "Monitoring · production" (or "· staging"), a one-line explanation, and "Open in
     CloudWatch ↗".
  2. Toolbar: range chips 1h / 24h / 7d / 30d, app select (All apps, platform, each app), Refresh,
     "Refresh every 60s" checkbox, "Updated 12:04".
  3. **Look up** card: a ref field ("Paste a ref, e.g. 3f9a2c1b") and a user field ("u_… id"),
     each with its button. Results open in a panel directly below: Find by ref lists that request's
     lines in time order with the type as a pill and the stack in a `<pre>`; the user trail lists
     their requests and errors, oldest first, with the person's name in the heading.
  4. **Health** table: one row per app (platform first), requests, server errors, browser errors,
     p95 ms, health dot. Clicking a row sets the app filter.
  5. **Graphs**: Requests, Server errors (5xx + unhandled), Browser errors, p95 duration per app
     (each line an app, consistent colors per app across graphs); then Lambda errors & throttles,
     Lambda p95, DynamoDB throttles. With an app selected, only that app's lines show.
  6. **Latest errors**, **Slowest requests**, **Browser errors** tables (and **Requests for
     `<app>`** when an app is selected). A ref is a link that runs Find by ref; a user is shown as
     "Name" with the id muted below and links to the trail; a row with a stack expands on click.
- Empty states: "No requests in this range", "No errors in the last 24 hours".
- `api.ts`: `monitoringMetrics(range)`, `monitoringQuery(body)`, `monitoringQueryResult(id)`, and a
  `runQuery()` helper that polls.
- `demo/backend.ts`: serves made-up metrics and rows for the demo personas (the admin persona sees
  the tab), so `npm run demo -w platform/web` shows the page. Queries in the demo complete after one
  poll.
- Styles in `styles.css` with the existing tokens; the series palette works in light and dark.

## Tests

- `platform/api/tests/monitoring.test.ts`: 403 for a non-admin (signed in) and 401 signed out on all
  three routes; the metrics call builds the expected expressions and periods per range and maps
  results into `apps`/`graphs`; every bad `ref`/`userId`/`app`/`query` is a 400 and nothing reaches
  the fake; good parameters produce exactly the saved query text with the value substituted; the
  range is clamped to retention; `people` resolves names and skips unknown ids; a CloudWatch failure
  is a 424.
- `packages/infra/tests/platform-stack.test.ts`: the handler's policy has the four statements, and
  `StartQuery` is scoped to `/stacks/<tag>/*` (both envs). `ci-stack` test: the boundary allows
  `cloudwatch:GetMetricData`.
- `packages/infra/tests/monitoring.test.ts` still passes unchanged (queries come from the moved
  module).
- `platform/web/tests/monitoring.test.tsx`: the tab shows only for platform admins; the page renders
  the health table, graphs and tables from a fake API; clicking a ref runs Find by ref; clicking a
  user runs the trail and shows the name; the 60 s checkbox schedules a refresh (fake timers) and
  stops when unchecked.

## Docs

- `docs/PLATFORM_SPEC.md`: decisions log row for #81 (this reverses #75's "No portal page");
  Monitoring section gains a "Portal page" bullet (which names `@stacks/manifest/monitoring`); Access
  model rule 6 mentions monitoring.
- `docs/DEBUGGING.md`: "Where to look" starts with the portal page; the console stays as the
  fallback.
- `docs/OWNER_STEPS.md` and `docs/specs/README.md`: the owner step below.

## Owner steps

1. **Before the PR's staging deploy matters** (not blocking the merge): redeploy the CI stack with
   admin credentials so the staging boundary allows `cloudwatch:GetMetricData`:
   `cd infra && npx cdk deploy -c ci=true stacks-ci`. Production needs nothing.
2. **After deploy**: open `auth.dashnash.ninja` → Monitoring, check the graphs match the
   `stacks-prod` dashboard for 24h, paste a recent ref into Find by ref, and sign in as a non-admin
   once (no tab; `#/admin/monitoring` says "Platform admins only").

## Acceptance (agent)

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, both env synths, and the portal
demo shows the page with demo data (screenshots in the PR).

## Cost

`GetMetricData` is $0.01 per 1,000 metrics: one page load asks for about 100, so ~$0.001; an hour of
60 s refresh ≈ $0.06. Logs Insights is $0.005 per GB scanned; at today's volume each table scans
well under 100 MB. Within the $50 budget with room to spare.

## Out of scope

Alerts of any kind; app approvers seeing their apps' monitoring; custom time ranges; a link from
`ErrorNote` to the page; free-form Logs Insights queries; source-map symbolication; the per-app cost
dashboard (Phase 5).
