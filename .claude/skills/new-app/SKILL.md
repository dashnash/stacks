---
name: new-app
description: Build a new Stacks app from a plain-language idea, end to end - interview, scaffold, build, verify with screenshots, put it on staging, open the PR. Use when someone runs /new-app, or asks to create, start or make a new app on Stacks. Also use it (from step 3) to change an existing app in apps/.
---

# /new-app

You are helping someone (often not a programmer) turn an idea into a working app on Stacks. Scripts
do everything predictable; you write only the app's own features. Spec: `docs/PLATFORM_SPEC.md`,
"Creator workflow".

## Ground rules

- **Talk plainly.** One question at a time, each with a suggested answer they can accept. No jargon
  (say "who can see it", not "visibility"; "test site", not "staging"). Show results, not code.
- **Edit only `apps/<slug>/`.** Never `packages/`, `platform/`, `infra/`, `templates/`, `tools/` or
  `.github/`. If the app needs something the SDK doesn't have (a module marked "not built" below, a
  new AWS resource), stop: explain it in one or two sentences and propose a separate platform change
  for Dash to review. Don't work around it.
- **No AWS credentials, ever.** Only CI deploys. Never ask for keys or passwords.
- **Every feature has tests and works in the demo.** Keep `<AccountMenu />` at the top right of the
  header, `<BuildVersion />` on every screen (the template's footer has it) and
  `web/src/demo/setup.ts` exporting `App` and `demoOptions()`.
- **Spend tokens carefully.** Read the package READMEs, not package source. Read `apps/hello` (small)
  before `apps/mofobookklub` (large), and only the folder you need. Don't print big files or full
  logs; `verify-app` already trims output.
- **Log each step**: `npm run app-usage -- <slug> <step> [--tokens N] [--note "…"]` with step one of
  `interview scaffold build verify stage ship change`. Add `--tokens` only if you actually know it.

## 0. Branch

```bash
git fetch origin main && git checkout -b app/<slug>/initial origin/main
```

Pick the slug in step 1 first (lowercase letters, digits, dashes, 3-30 characters; it becomes
`<slug>.iamdashnash.com`). If this session must use a branch it was given, use that one instead.
App branches (`app/<slug>/…`) are checked in CI: they may change only `apps/<slug>/`.

## 1. Interview → `app.manifest.json` + `BRIEF.md`

Ask, one at a time, and stop asking once you have enough (usually 6-8 questions):

1. What is it for, in a sentence or two? → `name` (≤40 chars), `tagline` (≤80), `description`, slug.
2. Who will use it? → shapes roles and the people in the demo.
3. Can anyone with a Google account use it, or only people you approve? → `visibility`
   `public` (anyone signing in gets `defaultRole`) or `private` (people ask; approvers let them in).
4. What different kinds of people are there, and who lets people in? → `roles`. Suggest Owner +
   Member. Upper-case ids (`HOST`, `GUEST`). The top role (`topRole`) needs `canManageAccess` and
   usually `canManageApprovers`; a public app's `defaultRole` must not manage access.
5. What are the 3-5 things it keeps track of, and what do people do with them? → entities and
   user stories in `BRIEF.md`.
6. What should someone who isn't signed in see? → the landing page; `publicRoutes`.
7. How should it look and feel (three words, or a site you like)? → `BRIEF.md`.
8. Only if it fits: discussion threads (`comments`), notifications to members (`notifications`),
   files bundled with the app (`contentPacks`), or a third-party service that needs an API key
   (`secrets`, names only).

Their Google email goes in `owners` (they become the top role). Modules available now: `comments`,
`notifications`, `contentPacks`, plus `secrets`. **Not built yet** (needs a platform change first):
`votes`, `uploads` (people adding photos/files), `scheduledJobs` (anything on a timer), `email`.
Images from other sites need their origins in `csp.imgSrc`; calls to other APIs from the browser
need `csp.connectSrc` (https origins, max 10).

Write `apps/<slug>/app.manifest.json` (see `apps/hello/app.manifest.json` for the shape) and
`apps/<slug>/BRIEF.md` (sections: What it is for, Who uses it, Roles, What it tracks (entities and
fields), What signed-out visitors see, Look and feel, User stories). Read both back as a short plain
summary, not JSON, and get a yes. Then: `npm run app-usage -- <slug> interview`.

## 2. Scaffold (no tokens)

```bash
npm run new-app -- <slug>
npm test -w apps/<slug>
```

This keeps your manifest and brief and fills in a complete starter app (sign-in, roles, landing page,
demo personas, a placeholder "notes" feature, tests). The tests must be green before you write
anything. Then `npm run app-usage -- <slug> scaffold`.

## 3. Build

Read, in this order and only as needed:

- `apps/<slug>/BRIEF.md`
- `packages/api/README.md` (routes, guards, store, audit, secrets), `packages/web/README.md`
  (client, hooks, components, account menu), `packages/demo/README.md`, `packages/testing/README.md`,
  `packages/manifest/README.md`; `packages/modules/comments/README.md` if you use comments
- `apps/hello/api/routes.ts` and `apps/hello/web/src/App.tsx` for the patterns

Then replace the starter notes feature (`templates/app/README.md` lists what to keep):

- **API** (`api/`): one file per feature, registered from `api/routes.ts`. Use the route guards
  (`.public`, `.member`, `.role`, `.approver`) rather than checking roles by hand; validate input with
  the SDK helpers; add `{ audit: '<thing>.<verb>' }` to every change. Design keys for the single table
  (`PK`/`SK`, `GSI1PK`/`GSI1SK`) around how screens read data. Store people by `v.user.id`, never their
  email; show names with `getPeople(deps, ids)`; check "is this mine?" with `isUser(v.user, storedId)`. Apps don't get emails (`needsEmail` is a platform
  decision: don't add it in an app task). Public routes never return emails.
- **Demo data** (`api/demo-data.ts`): keep one persona per role (top role first); seed realistic,
  friendly sample data so every screen has something on it. Dates relative to `deps.now()`, with
  times set in local time (`setHours`, not `setUTCHours`): the demo runs in the visitor's browser.
  Use fixed, readable ids for seeded records (`'harvest'`) so pages can be linked.
- **Pages to check** (`web/src/demo/pages.ts`): list the main inner pages by hash
  (`{ name: 'event', hash: '#/e/harvest' }`) so `verify-app` screenshots them too.
- **UI** (`web/src/`): any layout or style the brief asks for. Phone first. Real labels on inputs and
  buttons (tests and screen readers use them). Use `useHashRoute` for pages.
- **Tests**: an API test per route (who may and may not call it, validation, audit) and UI tests for
  the main flows on the demo backend (`tests/app.test.tsx` shows how).

Run `npm test -w apps/<slug>` as you go. Then `npm run app-usage -- <slug> build`.

## 4. Verify

```bash
npm run verify-app -- <slug>
```

It runs the typecheck, the app's tests, the platform conformance test, the import rule and the
"only apps/<slug>/ changed" check, builds the app and demo, and screenshots the demo signed out and
as every persona on desktop and phone (`apps/<slug>/.stacks/screenshots/`, not committed). It also
reports page errors and sideways scrolling. It also writes `web/public/preview.png`, the picture on
the app's card in the catalog (demo data only, never real people): commit it. Fix everything it reports.

Look at the screenshots yourself (open the PNGs) and compare them with the brief. Then show the
creator the two or three that matter most (send the files if you can) and ask what to change.
Iterate: change → `verify-app` → show. Then `npm run app-usage -- <slug> verify`.

## 5. Put it on the test site

```bash
git add apps/<slug> package-lock.json && git commit -m "<Name>: first version"   # includes web/public/preview.png
git push -u origin <branch>
gh api -X POST repos/dashnash/stacks/actions/workflows/deploy-test.yml/dispatches \
  -f ref=main -f "inputs[app]=<slug>" -f "inputs[ref]=<branch>"
gh api "repos/dashnash/stacks/actions/workflows/deploy-test.yml/runs?per_page=1" --jq '.workflow_runs[0] | [.id, .status] | @tsv'
# wait: gh api repos/dashnash/stacks/actions/runs/<id> --jq '[.status, .conclusion] | @tsv'
```

Use `gh api` (REST), not `gh workflow run` / `gh run watch`: cloud sessions block GitHub's GraphQL
API, which those commands use.

When it's green, the app is at `https://<slug>.test.iamdashnash.com` (staging `rootDomain` in
`stacks.config.json`). It uses the real Google sign-in and the test platform's data, which is
separate from production. If the run fails, read only the failing job's log
(`gh api repos/dashnash/stacks/actions/jobs/<job id>/logs | tail -60`; job ids from
`…/runs/<id>/jobs`), fix, push, and run it again. Then
`npm run app-usage -- <slug> stage`.

## 6. Ship

Open a PR from the app branch (`gh api repos/dashnash/stacks/pulls -f title=… -f head=<branch> -f base=main -f body=…`): title `New app: <Name>`. In the body: the tagline, who it's for, the
roles, what it tracks, the test-site link, and anything someone must do by hand (for example each
secret's `aws ssm put-parameter` command from `docs/SETUP.md` §7: Dash runs those, never the
creator). Commit `apps/<slug>/.stacks/usage.json` with it. `npm run app-usage -- <slug> ship`.

Tell the creator, plainly: once the PR is merged the app is live at `https://<slug>.iamdashnash.com`,
listed in the catalog, with them as its owner; they manage who gets in from the app's account menu
(Manage access).

## Changing an app later

Same as steps 3-6 on a branch `app/<slug>/<short-topic>`: read `BRIEF.md` (and update it if the app's
purpose changed), change, `verify-app`, stage, PR. Log the work as `change`.
