# Owner steps for the P1 fixes

Everything an agent can't do for the November 2026 P1 issues: AWS with admin credentials, GitHub
settings, Google Cloud Console, and checks on the live sites. Each step names its PR and when it's
needed. Specs: `docs/specs/`. Tick the box as you go.

Merge order: the PRs are independent. Merge **#114** (agent review gate) early, because PRs merged
after it go through it.

## #94 Staging can't reach production by name ([PR #112](https://github.com/dashnash/stacks/pull/112), merged)

- [ ] Redeploy the CI stack from your machine. This is the only way its IAM changes take effect, because CI never deploys it:

  ```bash
  cd infra && npx cdk deploy -c ci=true stacks-ci
  ```
- [ ] Prove it once. In IAM → Policies → `stacks-test-boundary` → *Simulate*, both of these must be **denied**:
  `s3:GetObject` on `arn:aws:s3:::stacks-prod-<any bucket>/index.html`, and `ssm:GetParameter` on
  `arn:aws:ssm:us-east-1:<account>:parameter/stacks/prod/secrets/platform/APNS_KEY`.
- [ ] Re-run **Deploy** (or wait for the next merge) and check that staging is still green.
- [ ] From now on, tag each production parameter after `put-parameter`. The commands are in `docs/SETUP.md` §7/§8 and `docs/IOS_SETUP.md`.

## #95 Runner token ([spec](specs/95-runner-token-scope.md), not implemented)

- [ ] Deferred by choice. In the homelab repo: fix the vault exposure first, then follow the spec. A
  GitHub App changes the token's lifetime and where it's stored, **not** its scope: on a user-owned
  repo, runner registration always needs repo Administration.

## #99 Supply chain ([PR #113](https://github.com/dashnash/stacks/pull/113))

- [ ] Settings → Code security: turn on Dependabot alerts, Dependabot security updates, secret scanning and push protection.
- [ ] Settings → Actions → General: tick **Require actions to be pinned to a full-length commit SHA**.

## #111 Agent review gate ([PR #114](https://github.com/dashnash/stacks/pull/114))

- [ ] After merge, re-apply the ruleset (find `<id>` with `gh api repos/dashnash/stacks/rulesets`):

  ```bash
  gh api -X PUT repos/dashnash/stacks/rulesets/<id> --input .github/rulesets/main.json
  ```
- [ ] Comment on, or push to, each PR that's still open, so the workflow posts its `agent-review` status.
- [ ] If PRs show `agent-review` as "Expected — waiting for status" even though the workflow posted
  success, delete `"integration_id"` from the `agent-review` entry in the ruleset file and re-apply it.

## #96 Staging Google client ([PR #115](https://github.com/dashnash/stacks/pull/115), draft)

- [ ] **Blocking the PR.** In Google Cloud Console, use **project 880697273676** (the one with both
  iOS clients): Credentials → Create OAuth client ID → Web application, named "Stacks staging", with
  JavaScript origin `https://auth.test.dashnash.ninja` and no redirect URIs. Give the client id to a
  session. It isn't secret.
- [ ] After merge and deploy: sign in on staging and on production.
- [ ] Rebuild the staging iOS app (the `iOS` workflow). It embeds the web client id.

## #100 Smoke check ([PR #116](https://github.com/dashnash/stacks/pull/116))

- [ ] After merge, check the next Deploy run: a green **Smoke check** in both jobs, with a table in the summary.

## #97 Backups and restores ([PR #117](https://github.com/dashnash/stacks/pull/117))

- [ ] After deploy, follow `docs/RESTORE.md` §0: check that DynamoDB is opted in to AWS Backup in us-east-1.
- [ ] After the 1st of next month, check that the vault `stacks-prod-backups` has recovery points.
- [ ] Rehearse a restore on staging, following `docs/RESTORE.md`, and fill in the rehearsal log.

## #98 Budget ([PR #118](https://github.com/dashnash/stacks/pull/118))

- [ ] Check Billing → Budgets for an older budget.
- [ ] Redeploy `stacks-ci` (the same command as #94; one deploy after both merge covers both).
- [ ] Budgets → `stacks-monthly` should show the 80% actual and 100% forecast alerts.
