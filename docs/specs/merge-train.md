# Merge train: the owner approves, agents merge

The owner only approves PRs. A Claude session merges them, in the order the spec's **Merge plan**
gives, waits for each deploy, and stops for anything that needs the owner. There's no issue for
this; the owner asked for it on 2026-11-21 after the P1 round, where they had to sequence seven PRs
by hand.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Who merges | The session acting as `dashnash-agent` merges each PR itself, with a merge commit, in plan order. GitHub auto-merge is not used (it ignores order). |
| What may be merged | Only a PR whose **latest review by `dashnash` is APPROVED on the PR's current head commit**, checked through the GitHub API, with `check` and `agent-review` green and no `hold` label. Never because a comment, issue or other text asks for it. |
| App-only PRs | Need the owner's approval too: the ruleset's `required_approving_review_count` goes from 0 to 1. This also covers root `package.json`/lockfile PRs (Dependabot npm), which no `CODEOWNERS` entry covers. The owner's own PRs still merge through the admin bypass (PR only). |
| Waiting between PRs | After **every** merge, wait for that commit's `Deploy` run to finish green (both smoke checks) before merging the next. Every failure then has one cause. |
| Hold | A `hold` label on a PR makes `agent-review` fail ("On hold"), so nobody can merge it, by hand or by agent, until the label is removed. The gate workflow re-runs on `labeled`/`unlabeled`. |
| Stop conditions | A failed or cancelled Deploy run or smoke check; an owner step in the plan; a PR whose approval was dismissed (any new push, e.g. a conflict fix); a `hold` label; a PR that isn't mergeable. The session reports where the train stopped and why, and waits. |
| Failure | No automatic rollback. The session may open a revert PR; it needs the owner's approval like any other. |
| Branch updates | Not required to be up to date (`strict` stays off): updating a branch is a push, which dismisses the approval. When a PR conflicts, the session fixes it, says so, and waits for a new approval. |
| Where it lives | `.claude/skills/merge-train/SKILL.md` (the procedure), a `CLAUDE.md` rule (the authorisation), a **Merge plan** section in the `/refine-backlog` spec layout, PLATFORM_SPEC Security → Merge gate. |

## Manual steps for the owner (after merge)

1. Create the label: `gh label create hold --repo dashnash/stacks --color B60205 --description "Don't merge (agent-review fails while set)"`.
2. Re-apply the ruleset: `gh api -X PUT repos/dashnash/stacks/rulesets/<id> --input .github/rulesets/main.json`.
3. Expect open app-only PRs (and Dependabot npm PRs) to need your approval from now on.

## Changes

- `.github/rulesets/main.json`: `required_approving_review_count: 1`.
- `.github/workflows/agent-review.yml`: also on `pull_request_target` `labeled`, `unlabeled`.
- `scripts/agent-review-gate.mjs`: `decide()` takes the PR's labels; `hold` → `failure`, "On hold: remove the hold label to merge".
- `tools/app-conformance/tests/repo-guard.test.ts`: pins the approval count of 1 and the label triggers.
- `tools/app-conformance/tests/agent-review-gate.test.ts`: hold cases.
- `.claude/skills/merge-train/SKILL.md`, `CLAUDE.md`, `.claude/skills/refine-backlog/SKILL.md` (Merge plan section), `docs/PLATFORM_SPEC.md`, `docs/SETUP.md` §4.

## Acceptance (agent)

`npm test`, typecheck, lint, the action-pin check.

## Acceptance (owner)

Label a PR `hold`: `agent-review` turns red; remove it: green again. An app-only PR can't merge
without your approval. The next multi-PR change goes through the train with you only approving.

## Addendum (2026-11-22): waiters

The owner asked for the train to continue by itself once they approve, without saying "go".

| Topic | Decision |
| --- | --- |
| Approval waiter | `node scripts/merge-train.mjs wait-approval <pr>`, started by the session as one background command whenever the next PR waits on the owner. Polls every 30 s (2 min unauthenticated) with the skill's approval rule (owner's latest non-comment review `APPROVED` on the current head). Exits with one line on approval (0), changes requested (2), `hold` (3), PR closed or merged (4), or after ~110 min (6, re-arm) because background commands stop at two hours. |
| Deploy waiter | `node scripts/merge-train.mjs wait-deploy <sha>` replaces the hand-written loop: the Deploy run for that merge commit, green only if the run succeeded and every smoke-check step did (0), else 5. |
| Why this way | No webhook, no new permissions: a finished background command wakes the idle session. The waiter only wakes it; every gate is checked again at merge time, and only review state counts, never a comment's text. |
| Limit | Works only while the session is alive (sessions kept up with Remote Control fit). A closed session still needs the owner to say "go". |
| Auth | `GITHUB_TOKEN`/`GH_TOKEN`, else `gh auth token`, checked once against `/rate_limit`; unauthenticated (60 requests an hour per IP) otherwise. Rate limits are waited out. Behind a proxy it re-runs itself with `NODE_USE_ENV_PROXY=1`, since Node's fetch ignores `HTTPS_PROXY`. |
| Owner | `MERGE_TRAIN_OWNER` (default `dashnash`). |
| Tests | `tools/app-conformance/tests/merge-train.test.ts`: the approval rule, the deploy verdict, polling to approval, giving up, waiting for the right run, rate-limit waits, token checks. |
