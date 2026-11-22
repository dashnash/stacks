# When a deploy goes wrong

Every merge to `main` runs **Deploy** (`.github/workflows/deploy.yml`): staging (platform, then
every app with `cdk deploy --all --concurrency 4`), a smoke check, then production the same way and
the same smoke check. A merge that changed only one app deploys only that app's stack, and a
docs-only merge deploys nothing (the `changes` job says which in the run summary). Either way the
next run diffs against the last **green** run, so whatever a failed run didn't deploy, the next one
does. CloudFormation rolls back **each stack on its own**, so a failed run can leave
the platform and some apps on the new commit and the rest on the old one. That is safe by design
(the Platform API stays compatible with the previous SDK for one release: `docs/PLATFORM_SPEC.md`,
"Compatibility across a deploy"), but it shouldn't stay that way. This page is what to do.

There is no automatic rollback, and nobody deploys by hand: only CI deploys (`CLAUDE.md`). Going
back means deploying older code **through a new merge**.

## 1. Spot it

- **Which job failed**: Actions → Deploy → the run. A red `staging` means production never started.
  A red `production` *after* "Apps" succeeded means the smoke check failed on a live production.
- **Which stacks rolled back**: CloudFormation → Stacks (us-east-1). A stack in
  `UPDATE_ROLLBACK_COMPLETE` is on its previous version; `UPDATE_COMPLETE` stacks are on the new one.
  Names: `stacks-<prod|test>-platform`, `stacks-<prod|test>-app-<slug>`, `stacks-<prod|test>-legacy-redirect`.
- **Which commit each stack runs**: the smoke check's table in the run summary shows `build <sha>`
  for the portal and every app, and warns "mixed versions" for any stack not on the run's commit
  (#105). By hand: `curl -s https://<app>.<domain>/api/health` (and `https://auth.<domain>/api/health`)
  answers `"build": "<sha>"`. The footer of every page shows the web build's commit, and every log
  line carries `build` (`docs/DEBUGGING.md`).
- **What went wrong**: the failed step's log shows CloudFormation's first error (look for
  `CREATE_FAILED` / `UPDATE_FAILED` and its reason); runtime errors are in `docs/DEBUGGING.md`.

## 2. Decide: re-run or revert

| What you see | Do |
| --- | --- |
| A transient AWS error (throttling, "rate exceeded", a CloudFront or certificate timeout, an `InternalFailure`) | **Re-run** (§3) |
| The smoke check failed only on its retries running out right after a deploy (warm-up), and the site works when you try it | **Re-run** the failed job (§3); the smoke check runs again |
| A real error in the change (bad template, a resource that can't be replaced, a Lambda that crashes, sign-in broken) | **Revert** (§4) |
| Production is broken for users and you don't know why yet | **Revert** first (§4), investigate after |
| A stack is in `UPDATE_ROLLBACK_FAILED` | §6 first, then re-run or revert |
| Data was changed or lost | §5 (a revert doesn't bring data back) |

## 3. Re-run

**Only re-run the latest Deploy run on `main`.** A re-run deploys that run's own commit, so
re-running an older run after a newer merge has deployed puts the older code back, and its smoke
check won't warn (it compares with the re-run's own commit). If a newer run exists, let it (or a fix
PR) carry the change instead, or revert (§4).

Actions → Deploy → the failed run → **Re-run failed jobs**. It redeploys the **same artifacts**
(the cloud assemblies the run's `build` job made; kept 7 days), so nothing is rebuilt and nothing new
ships. Failed jobs re-run with the jobs after them, so a re-run `staging` continues to `production`.
CloudFormation skips the stacks that already succeeded. Deploy runs one at a time (`concurrency:
deploy-main`), so a re-run waits while another run is in progress.

After 7 days the artifacts are gone; revert, or merge a no-op change, instead.

## 4. Revert (roll forward to the old code)

1. Revert the PR's merge commit in a new branch (a session can do this): `git revert -m 1 <merge sha>`,
   push, and open a PR titled "Revert …". For several bad merges, revert each, newest first.
2. It is an ordinary PR: CI must pass, and platform paths need your code-owner review (and the agent
   review gate, #111, for `packages/infra/`, `.github/` or `platform/api/`).
3. Merging it deploys the old code to staging and production through the normal Deploy run. The
   smoke check's table should show one commit for every stack.

Never deploy an old artifact or run `cdk deploy` by hand; only CI deploys, and `.claude/settings.json`
stops sessions from trying (#107).

If the bad change added a resource that the revert removes (a table, a bucket), CloudFormation
deletes it on the revert's deploy unless it is retained. In production, tables and content buckets
are retained (`RemovalPolicy.RETAIN`: they leave the stack but stay in AWS); on staging they are
deleted. Check the change's diff before reverting one that added or renamed a table or bucket.

## 5. Data

CloudFormation doesn't undo data. If the bad change wrote or deleted items, restore them from a
backup or point-in-time recovery: `docs/RESTORE.md`.

## 6. A stack stuck in `UPDATE_ROLLBACK_FAILED`

CloudFormation couldn't roll back (usually a resource changed outside it, or a deleted dependency).
Only you can fix this, in the console with admin credentials: CloudFormation → the stack → **Stack
actions → Continue update rollback**, skipping the resource it names if it must. Then re-run (§3)
or revert (§4). A session can read the error with you but can't act on it.

## 7. Afterwards

- Write down what happened in the PR that fixes it (or in an issue), with the failed run's link.
- If the cause was a change to the Platform API that an older app couldn't handle, it broke the
  compatibility rule: fix the rule's test or the review, not only the code.
