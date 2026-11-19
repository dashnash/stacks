# #106 Correct the spec drift agents rely on (EXT-02)

`CLAUDE.md` calls `docs/PLATFORM_SPEC.md` the source of truth, but parts of it describe things
that don't exist or work differently. After this change every item below matches the code, and a
test keeps the repo-layout block honest.

## Decisions (settled, don't reopen)

| Item (line as of 2026-11-19) | Decision |
| --- | --- |
| Repo layout, `platform/portal-bar/` (~360) | Delete the line: no portal bar exists. |
| Repo layout, `docs/ARCHITECTURE.md` (~377) | Replace with the docs that exist: `SETUP.md`, `OWNER_STEPS.md`, `DEBUGGING.md`, `RESTORE.md`, `NATIVE_APP_SPEC.md`, `IOS_SETUP.md`, `specs/` (and `ROLLBACK.md` once #105 lands). |
| Repo layout, the rest | Bring the block up to date: `packages/` lists `game-server` and `native`; `modules/` shows `comments` and marks the others `(planned)`; `.claude/skills/` lists `refine-backlog`; workflows list `ci-drift.yml` (#101, when it lands), `agent-review.yml`, `ios*.yml`; `tools/` lists `smoke` and `table-copy`; `CODEOWNERS` comment says it owns every path outside `apps/` and the top-level docs. |
| CI description, "tests for changed workspaces … `cdk synth` of changed stacks" (~421) | Describe `ci.yml` as it is: one `check` job runs actionlint, the import rule, action pins, the PR path check, typecheck, **all** tests, build, and a synth of every stack for both envs. |
| Session cookie `__Host-stacks` (~466) | The portal cookie is `__Host-stacks-portal` (`platform/api/src/core.ts` `PORTAL_COOKIE`); apps use `__Host-stacks-session` and, during sign-in, `__Host-stacks-login` (`packages/api`). |
| "Tighter limits on login and request-access" (~471) | If #102 has merged, its spec line is already there; just check it. Otherwise mark it "(planned, #102)". |
| "Dependabot on" | Already true since #99 (line ~476 describes it); no change. |
| "CODEOWNERS review on shared code" as a control | Already reworded by #93 (Merge gate bullet ~474 and Supply chain ~476 say the ruleset enforces it); no change. |
| Guard against new drift | New test `tools/app-conformance/tests/docs.test.ts`: every path in the "Repo layout" code block exists, except lines that say `(planned)`. Paths are built from the indentation of the tree. Shared with #105 (link check). (default) |

## Changes

- `docs/PLATFORM_SPEC.md`: the items above. Nothing else.
- `tools/app-conformance/tests/docs.test.ts` (new).

## Tests

The new test passes on the fixed spec, and fails on a copy that still lists `platform/portal-bar/` (unit test of the tree parser with an inline fixture).

## Acceptance (agent)

`npm test`, `npm run typecheck`, `npm run lint`. `grep -n 'portal-bar\|ARCHITECTURE.md\|changed workspaces' docs/PLATFORM_SPEC.md` finds nothing, and the Sessions bullet names `__Host-stacks-portal`.

## Out of scope

Rewriting other sections; drift outside `PLATFORM_SPEC.md` (the `SETUP.md` §9 Mac sentence is fixed by #103).

> Original: **Priority P2 · Severity Low · Effort S** (EXT-02). `:375` lists `docs/ARCHITECTURE.md`,
> `:358` lists `platform/portal-bar/`; neither exists. `:471` says "Dependabot on" (see #99), `:469`
> says "tighter limits" (see the throttles issue): mark both "planned" until they ship. It says CI tests
> "changed workspaces", but `ci.yml` runs everything. It says the cookie is `__Host-stacks`, but the
> code uses `__Host-stacks-portal`. It lists "CODEOWNERS review on shared code" as a control: reword
> per the outcome of #93.
