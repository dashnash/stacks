# #103 Keep PR builds off the Mac that signs releases (SEC-08)

`ios.yml` sends same-repo PR simulator builds (`app` job) and the TestFlight `release` job, which
holds `ASC_KEY_P8`, to the same `vars.MACOS_RUNNER` (`stacks-mac`). If the Mac keeps its user and
disk between jobs, branch code can leave something behind that reads the key on the next release.
After this change PR builds run as a **separate runner under a separate macOS user** (or on
GitHub-hosted `macos-26`), and the release runner stops running PR code once `MACOS_PR_RUNNER` is set.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Split | Two runner registrations on the Mac, each under its own macOS user: the existing one (release, `main` only) and a new one for PRs with its own label. The PR user is a standard (non-admin) account, and has no access to the release user's home folder or keychains. |
| Variables | `vars.MACOS_RUNNER` stays the release runner (`release` job). New repository variable `MACOS_PR_RUNNER` (JSON array, for example `["self-hosted","macOS","ARM64","stacks-ios-pr"]`) for the `app` job. |
| Fallback (revised by the owner) | When `MACOS_PR_RUNNER` is unset, same-repo PR builds fall back to `MACOS_RUNNER`, as before #103, until the PR runner exists; with neither set, `macos-26`. Fork PRs always go to `macos-26` (unchanged guard). |
| `app` job `runs-on` | `${{ (github.event.pull_request.head.repo.full_name == github.repository && (vars.MACOS_PR_RUNNER \|\| vars.MACOS_RUNNER)) && fromJSON(vars.MACOS_PR_RUNNER \|\| vars.MACOS_RUNNER) \|\| 'macos-26' }}` |
| `release` job `runs-on` | Unchanged (`vars.MACOS_RUNNER`). It runs only on `main`; its fork clause is moot but stays, because `repo-guard.test.ts` requires the guard on every runner expression in a workflow that runs on PRs (found while implementing). |
| Labels must differ | The two label sets must not overlap in their distinctive label: the PR runner must not carry `stacks-ios`, or GitHub could route a release job to it. Documented, and checked in the test where the labels are literal. |
| Docs | Document the setup in `docs/IOS_SETUP.md` (new section "Self-hosted Mac runners"): two users, which label each has, that the release user owns the keychains, that the PR user is non-admin, and how to fall back (unset the variable). Fix the drift in `docs/SETUP.md` §9, which says iOS jobs "always stay on GitHub-hosted runners". |

## Manual steps for the owner (the agent can't do these)

1. On the Mac: create a standard macOS user (for example `gh-runner-pr`), register a second runner for `dashnash/stacks` as that user with the label `stacks-ios-pr` (and not `stacks-ios`), running as a launchd service for that user. Install Xcode access for that user (Xcode in `/Applications` is shared; first launch: `xcodebuild -runFirstLaunch` as that user).
2. Check that the PR user can't read the release user's home: `sudo -u gh-runner-pr ls ~<release-user>` must fail.
3. Settings → Secrets and variables → Actions → Variables: add `MACOS_PR_RUNNER` = `["self-hosted","macOS","ARM64","stacks-ios-pr"]`.
4. Open a PR that touches `native/ios/` and check that the "App (simulator build)" job ran on the PR runner.

Until steps 1–3 are done, same-repo PR builds keep running on the existing Mac runner (`MACOS_RUNNER`), as before (owner's decision after implementation: no paid macOS minutes meanwhile, at the cost of the old risk until the PR user exists).

## Changes

- `.github/workflows/ios.yml`: the two `runs-on` lines; update the header comment.
- `docs/IOS_SETUP.md`: new section as above. `docs/NATIVE_APP_SPEC.md` (Runner bullet ~424): name both variables and the fallback.
- `docs/SETUP.md` §9: replace the wrong sentence with a pointer to `docs/IOS_SETUP.md`.

## Tests (`tools/app-conformance/tests/repo-guard.test.ts`)

- No job that can run on `pull_request` reads `vars.MACOS_RUNNER`.
- The `release` job and every job with `environment: ios-release` do not read `vars.MACOS_PR_RUNNER`.
- Every job that reads `MACOS_PR_RUNNER` carries the fork guard.

## Acceptance (agent)

`npm test`, `npm run typecheck`, `npm run lint`, actionlint, `node scripts/check-action-pins.mjs`.

## Acceptance (owner, after merge)

Manual step 4; the next release on `main` still runs on the release runner and uploads.

## Out of scope

Ephemeral macOS VMs (tart/Anka); moving releases to GitHub-hosted runners.

> Original: **Priority P2 · Severity Medium · Effort M** (SEC-08). `ios.yml:92` sends same-repo PR
> builds to `vars.MACOS_RUNNER`; `ios.yml:163` runs the release job, which holds `ASC_KEY_P8`, on the
> same runner. Fix: owner documents how `stacks-mac` is set up; if it isn't ephemeral, run PR builds
> elsewhere and keep the Mac for `main` and releases only.
