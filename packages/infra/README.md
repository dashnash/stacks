# @stacks/infra

CDK building blocks. App folders contain no infra code: `infra/bin/stacks.ts` creates one
`AppStack` per `apps/*/app.manifest.json`.

- `AppStack`: S3 + CloudFront at `<slug>.<rootDomain>` (CSP from the manifest), `/api/*` to an HTTP
  API and one arm64 Node 22 Lambda (`apps/<slug>/api/index.ts`), one DynamoDB single table
  (PK/SK, GSI1, TTL `expiresAt`), a Secrets Manager credential for the Platform API.
  Stack names: `stacks-<prod|test>-app-<slug>`. Staging stacks use bootstrap qualifier `stktest`
  and put the `stacks-test-boundary` permissions boundary on every role.
- `CiStack` (`stacks-ci`): GitHub OIDC roles per environment and the staging guardrail policies.
- `checkAssembly(dir, stack)`: the staging deploy gate.
- `buildCsp`, `loadStacksConfig`, naming helpers.

Synth never needs AWS credentials (no context lookups). See `docs/SETUP.md` for the one-time setup.
