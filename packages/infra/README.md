# @stacks/infra

CDK building blocks. App folders contain no infra code: `infra/bin/stacks.ts` creates one
`AppStack` per `apps/*/app.manifest.json`.

- `AppStack`: S3 + CloudFront at `<slug>.<rootDomain>` (CSP from the manifest), `/api/*` to an HTTP
  API and one arm64 Node 22 Lambda (`apps/<slug>/api/index.ts`), one DynamoDB single table
  (PK/SK, GSI1, TTL `expiresAt`), a Secrets Manager credential for the Platform API.
  Stack names: `stacks-<prod|test>-app-<slug>`. Staging stacks use bootstrap qualifier `stktest`
  and put the `stacks-test-boundary` permissions boundary on every role.
- With the `realtime` module, `AppStack` adds an AppSync Event API (`stacks-<env>-<slug>`, namespace
  `app`, IAM + Lambda auth, an onPublish handler dropping events over 4 KB), its Lambda authorizer
  (`@stacks/api/realtime-authorizer`, results never cached), the `stacks-<env>-app-<slug>-realtime-key`
  secret, `appsync:EventPublish` for the API Lambda on that API only, `realtime` endpoints in
  `config.json` and the `wss://` host in `connect-src`. Apps without it get none of these.
- `LegacyRedirectStack` (`stacks-<env>-legacy-redirect`, only with `legacyRedirects`): per old root a
  CloudFront distribution on `<old>` + `*.<old>` (own certificate and records in the old zone) whose
  function (`legacyRedirectCode(old, new)`) 301s to the same label + path + query on the new root
  (bare old root → `auth.`, anything odd → the portal's front page). `infra/bin/stacks.ts` makes it
  depend on every other stack so it deploys last.
- `CiStack` (`stacks-ci`): GitHub OIDC roles per environment and the staging guardrail policies.
- `checkAssembly(dir, stack)`: the staging deploy gate.
- `buildCsp`, `loadStacksConfig` (validates zones and `legacyRedirects`), naming helpers.
- Zones: `hostedZoneId` is a Route 53 ID or `"lookup"` (needs `hostedZoneName`). `resolveZoneIds(env,
  parseZoneIds(ctx), strict)` swaps in the IDs CI passes as `-c hostedZoneIds=<name>=<id>,…`;
  without one it uses `ZONE_ID_PLACEHOLDER` (or throws when `strict`, i.e. `-c requireZones=true`).
  `zonesToLookUp(config)` lists the names; `scripts/lookup-zones.mjs` resolves them (Node only: it signs its Route 53 call itself, no AWS CLI or SDK).

Synth never needs AWS credentials (no context lookups; zone IDs come from context or a placeholder). See `docs/SETUP.md` for the one-time setup.
