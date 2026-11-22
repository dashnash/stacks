# Debugging a live app

How to go from "something broke" to the request and the stack trace. Start on the portal's
**Monitoring** page (platform admins only); everything is also in the AWS console under
**CloudWatch** (us-east-1). Nothing alerts you: you look when someone tells you.
What is logged, and what never is, is in `docs/PLATFORM_SPEC.md` ("Monitoring"). A deploy that
failed or left stacks on different commits: [ROLLBACK.md](ROLLBACK.md).

## Where to look

- **Monitoring page** (the everyday view): `https://auth.dashnash.ninja/#/admin/monitoring`
  (staging: `auth.test.dashnash.ninja`), tab **Monitoring** in the portal header. Health per app, the
  dashboard's graphs, Latest errors, Browser errors and Slowest requests. Paste a ref into **Find by
  ref**, or click any ref or person in a table to see that request or that person's trail; people
  show by name. Pick an app (or click its row) to see only it. Each portal shows its own environment.
  "Open in CloudWatch" goes to the console dashboard below. The console steps that follow work the
  same way and are the fallback (and the place for queries of your own).
- **Dashboard**: CloudWatch → Dashboards → `stacks-prod` or `stacks-test`. Per app: requests,
  server errors, browser errors, p95 duration. Below: Lambda and DynamoDB health, then two tables,
  **Latest errors** and **Slowest requests**.
- **Saved queries**: CloudWatch → Logs → Logs Insights → Saved queries (right side) → folder
  `stacks-prod` or `stacks-test`. Pick one, set the time range (top right), edit the placeholder
  in CAPITALS if it has one, Run.

| Query | Use it for | Edit before running |
| --- | --- | --- |
| Find by ref | Someone sent you a ref | `PASTE-REF` |
| Latest errors | What has been failing, newest first | nothing |
| Browser errors | Crashes in people's browsers | nothing |
| Slowest requests | What is slow | nothing |
| One user's trail | Everything one person did, latest 500 lines, newest first | `u_PASTE-USER-ID` |
| One app's requests | One app's traffic | `APP-SLUG` |

## "A user sent me ref 3f9a2c1b"

When the server fails, the app shows "Internal server error (ref 3f9a2c1b)".

1. Open the dashboard for that environment, then Logs Insights → Saved queries → **Find by ref**.
2. Replace `PASTE-REF` with the ref. Refs are case-sensitive: paste, don't retype. Set the time
   range to cover when it happened (logs are kept 1 week on staging, 1 month on production).
3. Run. You get the lines of that one request, in order:
   - `type: error`: the failure. `message.error.stack` is the stack trace (expand the row),
     `message.route` the route, `message.userId` who, `message.build` which commit.
   - `type: request`: the same request's summary (`status: 500`, `durationMs`).
   - `type: app`: anything the app logged on the way with `log.info/warn/error`.
4. The trace names files and lines of the source (Lambdas run with source maps). Check out the
   commit in `message.build` to read exactly what ran.

No error line, only a `request` line with a 4xx status? Then the app refused the request on
purpose (validation, no access); the message the person saw is the explanation.

## Following one person

1. Find their user id (`u_…`): the portal's access grid shows it, and so does any log line of
   theirs (`message.userId`). Logs never hold emails or names, so you cannot search by those.
2. Run **One user's trail** with the id in place of `u_PASTE-USER-ID`.
3. You get every request they made (route pattern, status, duration) and every error, across all
   apps and the portal, newest first (the latest 500 lines; the Monitoring page shows them oldest first). A `ref` on a line leads to the rest of that request
   (**Find by ref**).

## Browser errors

`@stacks/web` reports JavaScript errors from people's browsers: uncaught errors, unhandled promise
rejections and React render crashes ("Something went wrong" with a Reload button).

1. Run **Browser errors** (or look at the dashboard's "Browser errors per app" graph first).
2. Each row has the app, the user id (if signed in), `message.path` (the page), `message.source`
   (`error`, `unhandledrejection` or `render`), the message and `message.stack`.
3. The stack is minified, as the browser saw it: names are short and lines point into the built
   file (`assets/index-….js:1:23456`). `message.clientBuild` is the commit the browser was running.
   To read it: check out that commit, `npm run build -w apps/<slug>`, and look up the position in
   `apps/<slug>/web/dist/assets/` (the build writes a source map next to the file when the app's
   Vite config has `build.sourcemap`). Often the message and the page are enough.
4. `clientBuild` older than the current build means the person had a stale tab; a reload fixes it.

A browser sends at most 5 reports per page load and each message once, so one row can stand for
many occurrences on that page.

## Good to know

- Logs appear within seconds; the dashboard's graphs lag a minute or two.
- A new app's graphs appear by themselves. Its log lines join the two tables and the saved queries
  at the next production deploy (the platform stack lists each app's log group by name). Until
  then, open its log group directly: `/stacks/<prod|test>/<slug>/api`.
- A table on the dashboard that shows an error instead of rows usually means one listed log group
  does not exist yet (an app that has never been deployed to that environment).
- Log groups: `/stacks/<prod|test>/<slug>/api`, `/stacks/<prod|test>/platform/api`, and
  `/stacks/<prod|test>/<slug>/realtime-authorizer` for apps with realtime.
- In API code, write `log.info('what happened', { id })` from `@stacks/api` for anything you will
  want to find later; it lands in the same queries with the request's ref and user id.
