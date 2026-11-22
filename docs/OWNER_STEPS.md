# Owner steps for the P1 fixes

**Status (2026-11-18): done except #95** (deferred, tracked in another session) and two dated
checks under #97 (a reminder is set for 2026-12-02). Also confirm the #99 code-security settings.

Everything an agent can't do for the November 2026 P1 issues: AWS with admin credentials, GitHub
settings, Google Cloud Console, and checks on the live sites. Each step names its PR and when it's
needed. Specs: `docs/specs/`. Tick the box as you go.

All P1 PRs are merged and deployed.

## #94 Staging can't reach production by name ([PR #112](https://github.com/dashnash/stacks/pull/112), merged)

- [x] Redeploy the CI stack from your machine. This is the only way its IAM changes take effect, because CI never deploys it:

  ```bash
  cd infra && npx cdk deploy -c ci=true stacks-ci
  ```
- [x] Prove it once. In IAM → Policies → `stacks-test-boundary` → *Simulate*, both of these must be **denied**:
  `s3:GetObject` on `arn:aws:s3:::stacks-prod-<any bucket>/index.html`, and `ssm:GetParameter` on
  `arn:aws:ssm:us-east-1:<account>:parameter/stacks/prod/secrets/platform/APNS_KEY`.
- [x] Re-run **Deploy** (or wait for the next merge) and check that staging is still green.
- Ongoing: from now on, tag each production parameter after `put-parameter`. The commands are in `docs/SETUP.md` §7/§8 and `docs/IOS_SETUP.md`.

## #95 Runner token ([spec](specs/95-runner-token-scope.md), not implemented)

- [ ] Deferred by choice. In the homelab repo: fix the vault exposure first, then follow the spec. A
  GitHub App changes the token's lifetime and where it's stored, **not** its scope: on a user-owned
  repo, runner registration always needs repo Administration.

## #99 Supply chain ([PR #113](https://github.com/dashnash/stacks/pull/113), merged)

- [ ] Settings → Code security: turn on Dependabot alerts, Dependabot security updates, secret scanning and push protection. *Dependabot PRs are arriving, which proves version updates. Confirm alerts, security updates, secret scanning and push protection are each on in the settings page.*
- [x] Settings → Actions → General: tick **Require actions to be pinned to a full-length commit SHA**.

## #111 Agent review gate ([PR #114](https://github.com/dashnash/stacks/pull/114), merged)

- [x] After merge, re-apply the ruleset (find `<id>` with `gh api repos/dashnash/stacks/rulesets`):

  ```bash
  gh api -X PUT repos/dashnash/stacks/rulesets/<id> --input .github/rulesets/main.json
  ```
- [x] Comment on, or push to, each PR that's still open, so the workflow posts its `agent-review` status.
- [x] Not needed: the gate posted success and PRs merged. (If PRs ever show `agent-review` as "Expected — waiting for status" even though the workflow posted
  success, delete `"integration_id"` from the `agent-review` entry in the ruleset file and re-apply it.)

## #96 Staging Google client ([PR #115](https://github.com/dashnash/stacks/pull/115), merged)

- [x] **Blocking the PR.** In Google Cloud Console, use **project 880697273676** (the one with both
  iOS clients): Credentials → Create OAuth client ID → Web application, named "Stacks staging", with
  JavaScript origin `https://auth.test.dashnash.ninja` and no redirect URIs. Give the client id to a
  session. It isn't secret.
- [x] After merge and deploy: sign in on staging and on production.
- [x] Rebuild the staging iOS app (the `iOS` workflow). It embeds the web client id.

## #100 Smoke check ([PR #116](https://github.com/dashnash/stacks/pull/116), merged)

- [x] After merge, check the next Deploy run: a green **Smoke check** in both jobs, with a table in the summary.

## #97 Backups and restores ([PR #117](https://github.com/dashnash/stacks/pull/117), merged)

- [x] After deploy, follow `docs/RESTORE.md` §0: check that DynamoDB is opted in to AWS Backup in us-east-1.
- [ ] After the 1st of next month, check that the vault `stacks-prod-backups` has recovery points.
- [ ] Rehearse a restore on staging, following `docs/RESTORE.md`, and fill in the rehearsal log.

## #98 Budget ([PR #118](https://github.com/dashnash/stacks/pull/118), merged)

- [x] Check Billing → Budgets for an older budget.
- [x] Redeploy `stacks-ci` (the same command as #94; one deploy after both merge covers both).
- [x] Budgets → `stacks-monthly` should show the 80% actual and 100% forecast alerts.

# Owner steps for the P2 fixes

Specs: `docs/specs/` (order in `docs/specs/README.md`). Only three of the seven need you after merge.

## #103 Mac runner split ([spec](specs/103-mac-runner-isolation.md))

- [ ] On the Mac, create a standard (non-admin) user such as `gh-runner-pr`, and register a second runner for `dashnash/stacks` as that user with the label `stacks-ios-pr` (not `stacks-ios`). Run `xcodebuild -runFirstLaunch` as that user.
- [ ] Check that the PR user can't read the release user's home folder.
- [ ] Add the repository variable `MACOS_PR_RUNNER` = `["self-hosted","macOS","ARM64","stacks-ios-pr"]`. Until then PR builds keep using the existing Mac runner (`MACOS_RUNNER`), sharing the release user as before.
- [ ] Open a PR that touches `native/ios/` and check which runner the simulator build used.

## #101 Policy drift check ([spec](specs/101-ci-policy-drift-check.md))

- [ ] Redeploy the CI stack (adds the read-only role): `cd infra && npx cdk deploy -c ci=true stacks-ci`. Note `DriftCheckRoleArn`.
- [ ] Add the repository variable `AWS_DRIFT_ROLE_ARN` with that ARN.
- [ ] Run **CI policy drift** by hand on `main`: both policies "in sync".

## #105 Rollback and inventory ([spec](specs/105-rollback-and-manual-state.md))

- [ ] Read `docs/ROLLBACK.md` and the inventory in `docs/SETUP.md` §0, and fill in where you keep each source value.

## #81 Monitoring page ([spec](specs/81-admin-monitoring.md))

- [ ] Redeploy the CI stack so the staging boundary allows `cloudwatch:GetMetricData`: `cd infra && npx cdk deploy -c ci=true stacks-ci`. Until then the staging page's graphs say CloudWatch didn't answer (the tables work). Production needs nothing.
- [ ] After deploy: open `auth.dashnash.ninja` → **Monitoring**; the 24h graphs match the `stacks-prod` dashboard; paste a recent ref into Find by ref.
- [ ] Sign in once as someone who is not a platform admin: no Monitoring tab, and `#/admin/monitoring` says "Platform admins only".
