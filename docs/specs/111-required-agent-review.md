# #111 Require an agent code review for infra, workflow and platform API PRs (GOV-01)

A PR touching `packages/infra/`, `.github/` or `platform/api/` can't merge until an agent code
review of its latest commit is recorded. The authoring session runs `/code-review` before asking the
owner, then posts a marker comment; a required status check verifies it.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Who reviews | The authoring session (or any session) acting as `dashnash-agent`, running `/code-review` on the PR's head commit. No API key, no model in CI. |
| Record | A PR comment by an allowed reviewer containing `<!-- agent-code-review sha=<40-hex head sha> -->`, followed by the findings summary (or "no findings"). |
| Allowed reviewers | `dashnash-agent` (repository variable `AGENT_REVIEWERS`, comma-separated, overrides). |
| Gated paths | `packages/infra/`, `.github/`, `platform/api/`. |
| Blocking | Only that a review of the head commit exists. Findings are for the owner to weigh during code-owner review. A new push needs a new review. |
| Enforcement | Workflow `.github/workflows/agent-review.yml`, job `agent-review`, posts commit status `agent-review` on the PR head (success "not required" when no gated path changed). The ruleset requires `agent-review` (integration 15368, GitHub Actions). |
| Triggers | `pull_request_target` (opened, synchronize, reopened, ready_for_review) and `issue_comment` (created, edited). It never checks out PR code; it runs `main`'s `scripts/agent-review-gate.mjs` on GitHub-hosted `ubuntu-latest`. |
| Permissions | `statuses: write`, `pull-requests: read`, `contents: read`. |

## Manual steps for the owner (after merge)

1. Re-apply the ruleset: `gh api -X PUT repos/dashnash/stacks/rulesets/<id> --input .github/rulesets/main.json`.
2. Open a PR that touches `.github/` and check that `agent-review` stays pending until the marker is posted.

## Changes

- `scripts/agent-review-gate.mjs` (logic exported, tested from `tools/app-conformance` like `pr-paths.mjs`, or its own test).
- `.github/workflows/agent-review.yml`.
- `.github/rulesets/main.json`: required check `agent-review`.
- `CLAUDE.md` Rules + `docs/PLATFORM_SPEC.md` Security → Merge gate + `docs/SETUP.md` §4.

## Tests

Gated path detection (prefix match, renames count by new and old path); marker matching only for
the exact head SHA, only from allowed authors, ignores quoted markers in other people's comments;
status payloads for not-required / pending / success.

## Acceptance (agent)

`npm test`, typecheck, lint, actionlint.
