# #94 Staging CI policies: deny production by name, not only by tag (SEC-03, SEC-04, SEC-06)

Staging's guardrail policies (`stacks-test-boundary`, `stacks-test-cfn-exec` in
`packages/infra/src/ci-stack.ts`) allow S3, SSM and Route 53 on `*` and rely on one deny on
`aws:ResourceTag/stacks:env = production`. S3 ABAC is off, prod secrets are untagged and the shared
zone is untagged, so all three leak. After this change staging can name only staging resources, and
production resources are denied by name as well as by tag.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Route 53 | Condition only: `route53:ChangeResourceRecordSets` allowed only when every record name (`route53:ChangeResourceRecordSetsNormalizedRecordNames`, `ForAllValues:StringLike`) is the staging root or under it, for `rootDomain` and each `legacyRedirects[].rootDomain` of the staging env in `stacks.config.json` (today `test.dashnash.ninja`, `*.test.dashnash.ninja`, `mofobookklub.test.iamdashnash.com`, `*.mofobookklub.test.iamdashnash.com`: a legacy redirect with `hosts` contributes only `<label>.<old>`, #143). No zone delegation now. |
| SSM | Name-based. Boundary and exec policy read only `parameter/stacks/test/*` and `parameter/cdk-bootstrap/stktest/*` (CloudFormation resolves the `BootstrapVersion` parameter with the exec role). Explicit deny on `parameter/stacks/prod/*` and `parameter/cdk-bootstrap/stkprod/*` in both policies. |
| SSM tags in runbooks | Every prod `put-parameter` in the docs is followed by `aws ssm add-tags-to-resource --resource-type Parameter --resource-id <name> --tags Key=stacks:env,Value=production` (`put-parameter` refuses `--tags` together with `--overwrite`). Existing prod params are not retro-tagged (the name deny covers them). |
| S3 | Boundary and exec policy allow S3 only on `arn:aws:s3:::stacks-test-*`, `arn:aws:s3:::cdk-stktest-*` and their `/*` objects (CDK names buckets after the stack: `stacks-test-…`). Both deny `stacks-prod-*`, `cdk-stkprod-*` and `/*` explicitly. `s3:ListAllMyBuckets` / `s3:GetBucketLocation` stay on `*` (not resource-scoped) (default). |
| Config source | `CiStack` takes the staging domains as a prop (`stagingRecordNames`), computed in `infra/bin/stacks.ts` from `stacks.config.json`; default when omitted: none (no Route 53 change allowed) (default). |

## Manual steps for the owner (the agent can't do these)

1. After merge, redeploy `stacks-ci` with admin credentials: `cd infra && npx cdk deploy -c ci=true stacks-ci`.
2. Prove it once (runbook in `docs/OWNER_STEPS.md` §#94): a `GetObject` on a `stacks-prod-*` bucket and a `GetParameter` on `/stacks/prod/…` from a staging role are AccessDenied; then re-run the Deploy workflow and confirm staging still deploys.

The agent does not block on these.

## Changes

- `packages/infra/src/ci-stack.ts`: as in Decisions. Statements: boundary `AppRuntime` loses `s3:*`/`ssm:*`/`kms:Decrypt` from `*` and gets `StagingBuckets`, `StagingParametersRead`; `kms:Decrypt` stays on `*` but only `kms:ViaService` ssm/s3 (default). Exec policy `StackServices` loses `s3:*`, `ssm:GetParameter*`, `route53:ChangeResourceRecordSets`; adds `StagingBuckets`, `StagingParametersRead`, `StagingRecords`. Both add `NeverProductionByName` (deny S3 + SSM prod ARNs).
- `infra/bin/stacks.ts`: pass `stagingRecordNames`.
- `docs/SETUP.md` §7, §8, `docs/IOS_SETUP.md`: tag step after prod `put-parameter`.
- `docs/SETUP.md` §3: mention the name-based limits.
- `docs/PLATFORM_SPEC.md`: staging rules mention name-based denies.

## Tests (`packages/infra/tests/infra.test.ts`, CiStack)

- Neither policy has `s3:*` or `ssm:GetParameter*` on `Resource: '*'`.
- S3 allow resources are exactly the four `stacks-test-*`/`cdk-stktest-*` ARNs; deny lists the four prod ARNs.
- SSM read allowed only on `/stacks/test/*` and `/cdk-bootstrap/stktest/*`; deny on `/stacks/prod/*`.
- Exec policy's `ChangeResourceRecordSets` is only in `StagingRecords`, with the `ForAllValues:StringLike` condition listing the configured names; none when no names passed.
- `NeverProduction` tag deny still present in both.

## Acceptance (agent)

`npm test`, `npm run typecheck`, `npm run lint`, `cd infra && npx cdk synth -q -c ci=true` and both env synths.

## Acceptance (owner, after deploy)

Manual step 2 passes; the next merge's staging deploy is green.

## Out of scope

Delegating `test.dashnash.ninja` to its own hosted zone; tagging existing prod parameters.
