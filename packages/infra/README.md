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
- With the `gameServer` module, `AppStack` adds an arm64 Fargate task definition
  (`stacks-<env>-app-<slug>-game`, cpu/memory from the manifest) whose image is a `docker save`
  tarball (`gameImageTarball`, default `apps/<slug>/game/dist/image.tar`; `ContainerImage.fromTarball`),
  its log group, task and execution roles (table, game key, the app's own Event API with IAM), a
  security group allowing only UDP 40000-40019 in, the `stacks-<env>-app-<slug>-game-key` secret,
  grants for the API Lambda (run/stop/describe its own tagged tasks on the shared cluster, pass the
  two roles to ECS tasks, read the two TURN parameters) and a 3-hour alarm: a metric filter on the
  server's heartbeat `uptimeSeconds` (the server logs it every minute), alarming to the environment's
  topic. A missing tarball is a placeholder plus a warning (synth without Docker) unless
  `requireGameImage` (`-c requireGameImage=true`, set by every CI synth). Apps without it get none.
- `PlatformStack` has the shared game network: a VPC with two public subnets and an internet gateway
  (no NAT), the ECS cluster `stacks-<env>-games` and the SNS topic `stacks-<env>-game-alarms`; their
  IDs are in SSM (`ssmNames(env).game`) and app stacks read them at deploy time.
- `LegacyRedirectStack` (`stacks-<env>-legacy-redirect`, only with `legacyRedirects`): per old root a
  CloudFront distribution on `<old>` + `*.<old>` (own certificate and records in the old zone) whose
  function (`legacyRedirectCode(old, new)`) 301s to the same label + path + query on the new root
  (bare old root → `auth.`, anything odd → the portal's front page). `infra/bin/stacks.ts` makes it
  depend on every other stack so it deploys last.
- `CiStack` (`stacks-ci`): GitHub OIDC roles per environment and the staging guardrail policies.
- `checkAssembly(dir, stack)`: the staging deploy gate (one stack, bounded roles, no asset that runs
  a command: the only image allowed is a tarball in the assembly with CDK's own load command).
- `buildCsp`, `loadStacksConfig` (validates zones and `legacyRedirects`), naming helpers.
- Zones: `hostedZoneId` is a Route 53 ID or `"lookup"` (needs `hostedZoneName`). `resolveZoneIds(env,
  parseZoneIds(ctx), strict)` swaps in the IDs CI passes as `-c hostedZoneIds=<name>=<id>,…`;
  without one it uses `ZONE_ID_PLACEHOLDER` (or throws when `strict`, i.e. `-c requireZones=true`).
  `zonesToLookUp(config)` lists the names; `scripts/lookup-zones.mjs` resolves them (Node only: it signs its Route 53 call itself, no AWS CLI or SDK).

Synth never needs AWS credentials (no context lookups; zone IDs come from context or a placeholder). See `docs/SETUP.md` for the one-time setup.
