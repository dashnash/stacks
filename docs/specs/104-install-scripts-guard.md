# #104 Build without install scripts, and guard new ones (SUP-03)

The `build` job of `deploy.yml` runs plain `npm ci`, so every dependency's install scripts run, and
the production job deploys that job's assembly unchanged. A compromised dependency never sees AWS
credentials, but it decides what production runs. The spec promises "no install scripts from new
dependencies without review", and nothing checks it. After this change no workflow runs install
scripts, and CI fails when the set of packages that have them changes.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Where | `npm ci --ignore-scripts` in **every** workflow install: `deploy.yml` `build`, `ci.yml` `check`, `deploy-test.yml` `build` (the credentialed jobs already use it). So every PR proves the build works without scripts. |
| Packages that need scripts | Today the lockfile has three entries with `hasInstallScript`: `node_modules/esbuild`, `packages/infra/node_modules/esbuild` and `node_modules/fsevents` (macOS only, optional). esbuild finds its binary through its `@esbuild/<platform>` optional dependency, so its postinstall isn't needed. Verify in the session (`rm -rf node_modules && npm ci --ignore-scripts && npm test && npm run build && synth`). Only if something fails, add `npm rebuild <pkg>` after the install, for that package only, in the same three places. |
| Allowlist | `scripts/install-scripts-allowlist.json`: `{ "packages": { "esbuild": "binary comes from @esbuild/<platform>; script not run", "fsevents": "macOS only; not used in CI" } }`, keyed by package **name** (all lockfile paths of that name). Each value says why it's allowed and whether CI rebuilds it. |
| Guard | `scripts/check-install-scripts.mjs` (plain Node, unit-tested), run in `ci.yml` `check` right after the install: the set of package names with `hasInstallScript: true` in `package-lock.json` must equal the allowlist's keys. A new name fails ("X added an install script: review it, then add it to the allowlist"); a key no longer in the lockfile fails too ("remove it"), so the list stays true. |
| Dependabot | A Dependabot PR that brings a new install script fails `check`; the owner reviews it and adds the entry. `/scripts/` isn't in `CODEOWNERS` today, so add `/scripts/ @dashnash`: the allowlist, and the guard scripts already there, then need owner review. |
| Assembly check in Deploy | Not added (default): `deploy.yml` deploys `main`'s reviewed code, and `check-assembly`'s rules (exactly one app stack) don't fit a full assembly. The gap SUP-03 names is closed by the two items above. |
| Root and workspace scripts | No workspace has `preinstall`/`install`/`postinstall`/`prepare` today. The guard also fails if any workspace `package.json` gains one (they'd silently stop running under `--ignore-scripts`). |

## Changes

- `.github/workflows/deploy.yml`, `ci.yml`, `deploy-test.yml`: the install lines; the `check` job gains a step "Install scripts allowlisted (#104)".
- `scripts/install-scripts-allowlist.json`, `scripts/check-install-scripts.mjs` (new).
- `.github/CODEOWNERS`: `/scripts/ @dashnash`.
- `docs/PLATFORM_SPEC.md` Security → Supply chain: "Workflows install with `--ignore-scripts`; `scripts/check-install-scripts.mjs` fails CI when a package with an install script is added or removed, against `scripts/install-scripts-allowlist.json`."

## Tests (`tools/app-conformance/tests/install-scripts.test.ts`)

- The real lockfile passes against the real allowlist.
- A fixture lockfile with an extra `hasInstallScript` package fails, naming it; a stale allowlist key fails; nested paths (`packages/x/node_modules/esbuild`) map to the name `esbuild`; a scoped name (`node_modules/@scope/pkg`) maps to `@scope/pkg`.
- A workspace `package.json` with `postinstall` fails.
- `repo-guard.test.ts`: every `npm ci` in `.github/workflows/*.yml` has `--ignore-scripts`.

## Acceptance (agent)

From a clean `node_modules`: `npm ci --ignore-scripts`, then `npm test`, `npm run typecheck`, `npm run lint`,
`npm run build`, both env synths and `-c ci=true`; `node scripts/check-install-scripts.mjs`; actionlint;
`node scripts/check-action-pins.mjs`.

## Acceptance (owner, after merge)

The next Deploy run is green, and the portal and an app still load (the smoke check covers both).

## Out of scope

A full-assembly check in `deploy.yml`; vendoring or verifying package tarballs.

> Original: **Priority P2 · Severity Medium · Effort M** (SUP-03). `npm ci --ignore-scripts` in
> `build`, plus an explicit `npm rebuild <pkg>` for the packages that need scripts; a CI check that
> fails when the set of lockfile entries with `hasInstallScript: true` changes (allowlist file);
> consider running the assembly check in `deploy.yml` too.
