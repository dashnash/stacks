# #107 Check in `.claude/settings.json` that denies AWS, deploys and pushes to main (GOV-02)

"Never use AWS credentials", "only CI deploys" and "edit only `apps/<slug>/`" are prose in
`CLAUDE.md`. After this change Claude Code refuses those commands in every session on this repo,
local or cloud, before they run. It is a second layer: the real controls stay the ruleset (#93),
OIDC roles and CI.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| File | `.claude/settings.json` (committed; `.claude/` is already code-owned). Only `permissions.deny`; no `allow` rules, no hooks (default). |
| Deny rules | `Bash(aws:*)`, `Bash(npx cdk deploy:*)`, `Bash(cdk deploy:*)`, `Bash(npx aws-cdk deploy:*)`, `Bash(cdk destroy:*)`, `Bash(npx cdk destroy:*)`, `Bash(cdk bootstrap:*)`, `Bash(npx cdk bootstrap:*)`, `Bash(git push origin main)`, `Bash(git push origin main *)`, `Bash(git push * main)`, `Bash(git push origin HEAD:main)`, `Bash(git push origin HEAD:main *)`, `Bash(git push * HEAD:main)` (not `main*`, which would also block branches such as `main-fix` or `maintenance`; changed after the code review). No force-push deny: force pushes to feature branches are sometimes legitimate, and the ruleset already refuses them on `main`. |
| Path guard | Not in settings (default): app tasks may legitimately touch the lockfile, and a path deny would block platform tasks too. The CI path check plus the ruleset already enforce it. |
| Limits, stated plainly | Prefix rules don't catch every spelling (`bash -c "aws …"`, scripts). `CLAUDE.md` says the file is a guard rail, not the control. |
| Local overrides | The owner can still run these in their own terminal; `.claude/settings.local.json` (git-ignored) can't remove a project deny, which is intended. |

## Changes

- `.claude/settings.json` (new) with `"$schema": "https://json.schemastore.org/claude-code-settings.json"` and the deny list.
- `CLAUDE.md` Rules: "`.claude/settings.json` denies `aws`, `cdk deploy`/`destroy`/`bootstrap` and pushes to `main`; don't work around it."
- `docs/PLATFORM_SPEC.md` Guardrails (~405): one line.

## Tests (`tools/app-conformance/tests/repo-guard.test.ts`)

- `.claude/settings.json` parses, and `permissions.deny` contains every rule in the table (exact strings).
- It has no `permissions.allow` entry that starts with `Bash(aws`, `Bash(cdk` or `Bash(git push`.

## Acceptance (agent)

`npm test`, `npm run typecheck`, `npm run lint`. In a session on the branch, `aws --version` and
`git push origin HEAD:main --dry-run` are refused by Claude Code before running.

## Acceptance (owner, after merge)

A new Claude session on `main` refuses `aws sts get-caller-identity`.

## Out of scope

Hooks; path-based edit denies; machine-wide (managed) settings.

> Original: **Priority P2 · Severity Medium · Effort S** (GOV-02). Add `.claude/settings.json` with
> `permissions.deny` for `Bash(aws:*)`, `Bash(npx cdk deploy:*)`, `Bash(cdk deploy:*)`, `Bash(git push
> origin main*)` and `Bash(git push * main)`; mention it in `CLAUDE.md`.
