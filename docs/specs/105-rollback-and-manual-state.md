# #105 Write down rollback and the manual-state inventory (ARCH-02, DR-03)

`cdk deploy --all --concurrency 4` rolls each stack back on its own, so a failed run can leave the
platform and some apps on the new commit and the rest on the old one, and `docs/` has no rollback
procedure. Hand-made state (SSM secrets, GitHub variables and secrets, Google and Apple console
settings, `stacks-ci`) is spread over `SETUP.md`, `IOS_SETUP.md` and the homelab runbook. After
this change there is a rollback runbook, a compatibility rule that makes mixed versions safe, a way to
see which commit each stack runs, and one inventory table.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Runbook | New `docs/ROLLBACK.md`. Sections: 1) **Spot it**: which jobs failed, the CloudFormation "UPDATE_ROLLBACK_COMPLETE" stacks, and each stack's commit (below). 2) **Re-run**: Actions → the failed Deploy run → *Re-run failed jobs* redeploys the same artifact (kept 7 days); right for transient failures (throttling, a CloudFront timeout). 3) **Roll forward with a revert**: `git revert` the PR's merge commit in a new PR; its merge deploys the old code everywhere. This is the only rollback; never deploy an old artifact by hand (only CI deploys). 4) **Data**: CloudFormation doesn't undo data; point to `docs/RESTORE.md`. 5) **Stuck stacks**: `UPDATE_ROLLBACK_FAILED` needs the owner in the console (Continue update rollback); the agent can't. 6) **Production smoke check failed** after deploy (#100): decide re-run vs revert with the table in the runbook. |
| Which commit each stack runs | Add `build` (the `STACKS_BUILD_SHA`, `'dev'` when unset) to `GET /api/health` on the platform (`platform/api/src/app.ts`) and in every app (`packages/api/src/app.ts`). The repo is public and the footer already shows the commit, so this exposes nothing new. `tools/smoke/smoke.mjs` prints each stack's `build` in its table and, given `--sha <commit>`, **warns** (never fails) when a stack reports a different one. `deploy.yml` passes `--sha "$GITHUB_SHA"`. |
| Compatibility rule | `docs/PLATFORM_SPEC.md` gets a rule under Shared services/handshake: "The Platform API stays compatible with the previous SDK release for one release: a change to a route an app calls (`/api/apps/:slug/*`, `/authorize`, the token exchange) adds a new field or route first and removes the old one in a later PR, after every app has deployed. Apps deploy after the platform, so the platform is always the newer side." Add the same one-liner to the `/code-review` focus in `CLAUDE.md` Rules for `platform/api/` PRs (default). |
| Inventory | One table in `docs/SETUP.md`, new §0 "What lives outside the repo": **Name \| Where it lives \| Where the source value is kept \| How to rotate \| Doc**. Rows (at least): `stacks-ci` stack (roles, staging policies, budget, drift role from #101); CDK bootstraps `stkprod`/`stktest`; SSM `/stacks/<env>/secrets/platform/*` (each named key) and `/stacks/<env>/secrets/<app>/*`; GitHub environments `staging`/`production`/`ios-release` and their variables and secrets (`AWS_*_ROLE_ARN`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`); repository variables (`LINUX_RUNNER`, `MACOS_RUNNER`, `MACOS_PR_RUNNER`, `AWS_DRIFT_ROLE_ARN`); the ruleset (`.github/rulesets/main.json`, applied by hand); repo settings (Code security, pinned actions, fork approval); Google OAuth clients (web per env, two iOS) in project 880697273676; Apple: App Store Connect key, APNs key, Sign in with Apple service ID and key, app records; Route 53 zones; self-hosted runners (homelab repo `roles/github_runner`, the Mac). Build it by grepping `docs/` and `.github/` for `secrets.`, `vars.`, `put-parameter` and console steps; every row links the section that creates it. "Source value kept" says where the owner keeps the original (password manager, Apple/Google console, re-creatable) and must never contain a value. |
| No values | The table lists names and places only. No ARNs with account IDs, no client IDs beyond those already committed. |

## Changes

- `docs/ROLLBACK.md` (new); link it from `docs/DEBUGGING.md` and from the `production` smoke-check comment in `deploy.yml`.
- `docs/SETUP.md` §0 inventory; `docs/IOS_SETUP.md` and `docs/RESTORE.md` link to it.
- `platform/api/src/app.ts`, `packages/api/src/app.ts`: `build` in `/health`. `packages/api/README.md`: one line.
- `tools/smoke/smoke.mjs` (+ README): print `build`, `--sha` warning. `deploy.yml`: pass `--sha`.
- `docs/PLATFORM_SPEC.md`: the compatibility rule; the smoke-check line mentions the commit warning; list `docs/ROLLBACK.md` in the repo layout.
- `CLAUDE.md`: the compatibility one-liner (default).

## Tests

- `platform/api` and `packages/api` health tests: `build` is the env var's value, `'dev'` when unset.
- `tools/smoke` tests: the table has each stack's build; a mismatch with `--sha` warns and still passes; a missing `build` (an old stack) warns "unknown".
- A docs test (`tools/app-conformance/tests/docs.test.ts`, shared with #106): every relative link in `docs/ROLLBACK.md` and the §0 table resolves to an existing file.

## Acceptance (agent)

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, both env synths.

## Acceptance (owner, after merge)

Read `docs/ROLLBACK.md` and the inventory once and fix anything missing or wrong (only you know where the
source values are kept). The next Deploy summary shows one commit for every stack.

## Out of scope

Automatic rollback; deploying old artifacts; changing `--concurrency`.

> Original: **Priority P2 · Severity Medium/Low · Effort S–M** (ARCH-02, DR-03). `docs/ROLLBACK.md`:
> which run to re-run, when to revert, how to spot mixed versions; a spec rule that the Platform API
> stays compatible with the previous SDK for one release; one table in `docs/SETUP.md`: name | where it
> lives | where the source value is kept | how to rotate.
