# #98 Add an AWS Budget alert (OBS-01)

Nothing alerts on cost. Add one monthly cost budget to the `stacks-ci` stack (deployed by hand,
account-wide) that emails the owner.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Amount | USD 50 per month, cost budget, unblended. |
| Alerts | Email at 80% of **actual** and 100% of **forecasted** spend. |
| Recipient | The first production `platformAdmins` address in `stacks.config.json` (no new personal data in git), passed to `CiStack` as `budgetAlertEmail`. |
| Config | `stacks.config.json` gets `"budget": { "monthlyUsd": 50 }` (top level, default) so the amount can change without code; `CiStack` adds the budget only when both amount and email are given. |
| Where | `stacks-ci` (account-wide, deployed by hand). Compatible with pull-only monitoring (#75): a cost guardrail, not ops alerting. |

## Manual steps for the owner

1. Check AWS Billing → Budgets for an existing budget; delete it or keep it (two emails is harmless).
2. After merge, redeploy `stacks-ci`: `cd infra && npx cdk deploy -c ci=true stacks-ci`.
3. Budgets → `stacks-monthly` shows both alerts. (AWS Budgets emails need no confirmation.)

## Changes

- `packages/infra/src/ci-stack.ts`: `AWS::Budgets::Budget` (`budgets.CfnBudget`), name `stacks-monthly`.
- `packages/infra/src/config.ts`: `budget` in the config type and loader.
- `infra/bin/stacks.ts`: pass amount and email.
- `docs/SETUP.md` §2 and `docs/PLATFORM_SPEC.md` Monitoring: mention the budget.

## Tests

The CI stack has one budget with limit 50 USD, MONTHLY, COST, two notifications (ACTUAL 80 %, FORECASTED 100 %) to the given email; no budget without the props.

## Acceptance (agent)

`npm test`, typecheck, lint, `npx cdk synth -q -c ci=true`.
