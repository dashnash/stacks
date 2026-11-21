# Specs

One file per refined issue: what changes, the decisions the owner settled (don't reopen them), the
owner's manual steps, and how to check the work. An agent should be able to carry one out without
asking anything. Name files `<issue>-<short-name>.md`.

Manual steps for the owner from all open specs are collected in `docs/OWNER_STEPS.md`.

## P2 hardening (November 2026 review)

Seven specs, one PR each, in this order (later ones build on earlier ones and touch the same files):

| Order | Spec | Touches | Needs the owner after merge |
| --- | --- | --- | --- |
| 1 | [#107 `.claude/settings.json` denies](107-claude-settings-deny.md) | `.claude/`, `CLAUDE.md` | no |
| 2 | [#104 No install scripts](104-install-scripts-guard.md) | workflows, `scripts/`, `CODEOWNERS` | no |
| 3 | [#102 Per-route throttles](102-per-route-throttles.md) | `packages/infra` | no |
| 4 | [#106 Spec drift](106-spec-drift.md) | `docs/PLATFORM_SPEC.md`, a docs test | no |
| 5 | [#103 Mac runner split](103-mac-runner-isolation.md) | `ios.yml`, iOS docs | yes: a second runner user on the Mac |
| 6 | [#101 Policy drift check](101-ci-policy-drift-check.md) | `ci-stack.ts`, a new workflow, `deploy.yml` | yes: redeploy `stacks-ci`, set a variable |
| 7 | [#105 Rollback and inventory](105-rollback-and-manual-state.md) | docs, `/api/health`, `tools/smoke` | yes: review the inventory |

PRs 2, 5, 6 and 7 touch `.github/` or `platform/api/`, so each needs the agent review gate (#111).

## Sky Shot (November 2026)

A desktop-screen + iPhone light-gun game, built on game rooms and the Game kit.

| Order | Spec | Touches | Needs the owner after merge |
| --- | --- | --- | --- |
| 1 | [#131 Seats keyed per device](131-device-seats.md) | `packages/api`, `game-server`, `web`, `testing`, `demo` | no |
| 2 | [#132 Sky Shot](132-sky-shot.md) | `apps/sky-shot/` (app task; `motion` needs code-owner review) | no |
| 3 | [#133 Volume buttons (draft)](133-volume-buttons.md) | `native/ios`, `native/protocol`, `packages/native` | open questions first |
| 4 | [#144 Themes](144-sky-shot-themes.md) | `apps/sky-shot/` (app task) | no |
