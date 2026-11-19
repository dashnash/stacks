# #101 Detect drift between the live stacks-ci policies and the repo (ARCH-03)

`stacks-ci` is deployed by hand (`docs/SETUP.md` §2), and nothing compares the live staging
guardrail policies with `packages/infra/src/ci-stack.ts`. A merged guardrail fix that was never
applied protects nothing (#94 is the case that matters). After this change a read-only role lets
a daily workflow synthesize `stacks-ci`, fetch the live default version of both staging policies and
fail on any difference. Deploy runs the same check first, as a warning only.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| What is compared | The default version of the two managed policies `stacks-test-boundary` and `stacks-test-cfn-exec`, compared with the `AWS::IAM::ManagedPolicy` resources of the synthesized `stacks-ci` template. Nothing else for now (the deploy roles' trust and inline policies and the budget are out of scope) (default). |
| Role | `stacks-ci-drift-check` in `CiStack`. Trust: the same OIDC provider, `aud = sts.amazonaws.com`, `sub = <subjectPrefix>:ref:refs/heads/main` (`StringEquals`). A job with no `environment:` sends a ref-based `sub`, so the role works only from `main` and never in a PR. Inline policy: `iam:GetPolicy`, `iam:GetPolicyVersion` on the two policy ARNs only. Max session 1 h. Output `DriftCheckRoleArn`. |
| Role ARN in GitHub | Repository variable `AWS_DRIFT_ROLE_ARN` (not secret). While it's unset the job ends with a `::notice` ("drift check not set up, see docs/SETUP.md §2") and passes, so merging before the owner's deploy breaks nothing. |
| Schedule | New workflow `.github/workflows/ci-drift.yml`: `schedule` daily (`17 6 * * *`), `workflow_dispatch`, and `push` to `main` on `packages/infra/src/ci-stack.ts`, `infra/bin/stacks.ts` and `stacks.config.json`. A failure fails the run, so GitHub emails the owner. No issue is opened (default). |
| In Deploy | `deploy.yml` gets a job `ci-drift` (no `needs`, runs in parallel with `zones`, `continue-on-error: true`) that runs the same script with `--warn`: differences become `::warning` annotations and a step-summary table, exit 0. `staging` doesn't wait on it. |
| Script | `scripts/check-ci-drift.mjs`, plain Node 22, no deps (same style as `scripts/lookup-zones.mjs`). Reuse `signV4` by importing it from `lookup-zones.mjs`. IAM is global: host `iam.amazonaws.com`, region `us-east-1`, Query API (`Action=GetPolicy&PolicyArn=…&Version=2010-05-08`, then `GetPolicyVersion` with the `DefaultVersionId`). The document comes back URL-encoded inside XML: decode with `decodeURIComponent`. |
| Expected document | `node scripts/check-ci-drift.mjs <stacks-ci.template.json> --account <id> [--warn]`. It resolves the intrinsics CDK emits (`Fn::Join`, `Ref` to `AWS::Partition` = `aws`, `AWS::AccountId` = `--account`, `AWS::Region` = `us-east-1`, `AWS::URLSuffix` = `amazonaws.com`) and fails on any other intrinsic, so a change in how CDK writes the template is loud, not a silent pass. The account comes from `configure-aws-credentials`' `aws-account-id` output. |
| Comparison | Normalize both sides: `Statement` always an array; `Action`, `NotAction`, `Resource`, `NotResource` and every condition value become sorted arrays; statements sorted by `Sid`, then by their JSON. Report per policy: statements only in the repo, only live, and changed (by `Sid`, with both JSON bodies). Equal → one line "in sync" per policy. |
| As built | `deploy.yml` calls `ci-drift.yml` as a reusable workflow (`workflow_call`, input `warn`), so the check lives in one place; `continue-on-error` is set inside it when `warn` is true. The script's tests live in `packages/infra/tests/ci-drift.test.ts`, next to the other `CiStack` tests (they synthesize the real stack). (Found while implementing.) |
| Synth in the workflow | `cd infra && npx cdk synth -q -c ci=true -o ../cdk.out-ci` with no AWS credentials, before the credentials step. Install with `npm ci --ignore-scripts` (#104). |

## Manual steps for the owner (the agent can't do these)

1. After merge, redeploy the CI stack with admin credentials: `cd infra && npx cdk deploy -c ci=true stacks-ci`. Note the `DriftCheckRoleArn` output.
2. Settings → Secrets and variables → Actions → Variables (repository, not an environment): add `AWS_DRIFT_ROLE_ARN` with that ARN.
3. Run **CI policy drift** by hand (Actions → Run workflow on `main`): it should say "in sync" for both policies.

The agent does not block on these.

## Changes

- `packages/infra/src/ci-stack.ts`: the role, its trust and inline policy, the output. Export `DRIFT_CHECK_ROLE_NAME`.
- `scripts/check-ci-drift.mjs`: exports `resolveIntrinsics`, `normalizePolicy`, `diffPolicies`, `expectedPolicies(template, account)`, `fetchLivePolicy(arn, credentials, fetchImpl)`; `main()` only when run directly.
- `.github/workflows/ci-drift.yml` (new) and the `ci-drift` job in `deploy.yml`. Every action pinned by SHA (`scripts/check-action-pins.mjs`). The new workflow has no `pull_request` trigger.
- `docs/SETUP.md` §2: the role, the variable, and "a daily check tells you when the live policies differ from main". Add `AWS_DRIFT_ROLE_ARN` to the §4 variables list.
- `docs/PLATFORM_SPEC.md` (Environments / CI): one line on the drift check.

## Tests

- `packages/infra/tests/infra.test.ts` (CiStack): the role exists with the ref-based `sub` for `main` (and with an immutable-ID `githubSubjectPrefix`); its only actions are `iam:GetPolicy` and `iam:GetPolicyVersion`, on exactly the two policy ARNs; there is no `environment:` in its `sub`.
- `tools/app-conformance/tests/ci-drift.test.ts`: intrinsics resolve (Join, pseudo-params); an unknown intrinsic throws; normalization makes a string `Action` equal to a one-item array and ignores order; a changed `Resource` in one `Sid` is reported as changed; an extra live statement is reported; a fixture XML from `GetPolicyVersion` decodes to the document; `--warn` exits 0 on a difference and the default exits 1 (fetch stubbed).
- `repo-guard.test.ts`: `ci-drift.yml` has no `pull_request`/`pull_request_target` trigger, and its job has no `environment:`.

## Acceptance (agent)

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, actionlint, `node scripts/check-action-pins.mjs`,
`cd infra && npx cdk synth -q -c ci=true` and both env synths. Running the script against a freshly
synthesized template with a stubbed live response built from that same template reports "in sync".

## Acceptance (owner, after deploy)

Manual step 3 says "in sync"; the next Deploy run shows the `ci-drift` job green with no warnings.

## Out of scope

Comparing the deploy roles, the OIDC provider or the budget; deploying `stacks-ci` from CI; opening an issue on drift.

> Original: **Priority P2 · Severity Medium · Effort S** (ARCH-03). A read-only role (`iam:GetPolicy`,
> `iam:GetPolicyVersion` on the two staging managed policies) trusted by OIDC from `main`; a CI or
> scheduled job that synthesizes `stacks-ci`, fetches the live default versions and fails on any
> difference; owner deploys the role once by hand.
