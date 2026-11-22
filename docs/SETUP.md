# One-time setup

Everything after this is done by CI. These steps need AWS admin credentials on your own machine,
once. Nothing here goes into a Claude session.

## 0. What lives outside the repo

Everything below was made by hand, once, and isn't rebuilt from git (#105). Names and places only:
no values here, ever. "Source value" is where the original is kept, so you can rotate or re-create
it. Rotate by redoing the step in the last column.

| Name | Where it lives | Source value | How to rotate / re-create | Doc |
| --- | --- | --- | --- | --- |
| `stacks-ci` stack: OIDC provider, roles `stacks-ci-production` / `stacks-ci-staging` / `stacks-ci-drift-check`, policies `stacks-test-boundary` / `stacks-test-cfn-exec`, budget `stacks-monthly` | AWS (CloudFormation, IAM, Budgets) | the repo (`packages/infra/src/ci-stack.ts`); nothing secret | redeploy `stacks-ci` with admin credentials; the daily drift check says when it's needed | §2, §3 |
| CDK bootstraps `CDKToolkit-stkprod`, `CDKToolkit-stktest` | AWS (CloudFormation, S3, IAM) | re-creatable | rerun the `cdk bootstrap` commands | §2, §3 |
| Platform secrets `/stacks/<env>/secrets/platform/{APNS_KEY, APNS_KEY_ID, CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN}` | SSM Parameter Store (SecureString) per environment; production ones tagged `stacks:env=production` | Apple Developer (APNs key, downloaded once: keep the `.p8` in your password manager); Cloudflare dashboard (TURN) | make a new key at the source, `put-parameter --overwrite`, tag the prod copy | APNs: [IOS_SETUP.md](IOS_SETUP.md) §9; TURN: §8 here |
| App secrets `/stacks/<env>/secrets/<slug>/<NAME>` (from each manifest's `secrets`) | SSM Parameter Store (SecureString) | the third-party service each one is for | `put-parameter --overwrite`, tag the prod copy; `/api/health` lists missing ones | §7 |
| Each app's Platform API credential | Secrets Manager, made by the app's stack | generated in AWS; never seen | not rotated by hand. Never delete it in the console: CloudFormation still thinks it exists and won't make a new one. To replace it, change how the stack generates it in a PR, so the deploy replaces it | §1 |
| GitHub environments `staging`, `production` (variables `AWS_STAGING_ROLE_ARN`, `AWS_PRODUCTION_ROLE_ARN`; deployment branch `main`) | GitHub → Settings → Environments | `stacks-ci` outputs | copy the ARNs again after re-creating `stacks-ci` | §4 |
| GitHub environment `ios-release` (secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`; branch `main`) | GitHub → Settings → Environments | App Store Connect → Users and Access → Integrations (the `.p8` downloads once: keep it in your password manager) | revoke the key, make a new one, replace the three secrets | [IOS_SETUP.md](IOS_SETUP.md) §2, §3 |
| Repository variables `LINUX_RUNNER`, `MACOS_RUNNER`, `MACOS_PR_RUNNER`, `AWS_DRIFT_ROLE_ARN`, `AGENT_REVIEWERS` | GitHub → Settings → Secrets and variables → Actions → Variables | this doc / `stacks-ci` outputs; not secret | set again | §4, §9, [IOS_SETUP.md](IOS_SETUP.md) "Self-hosted Mac runners" |
| Ruleset on `main` | GitHub → Settings → Rules | `.github/rulesets/main.json` | `gh api -X PUT …/rulesets/<id> --input .github/rulesets/main.json` | §4 |
| Repo settings: visibility public, fork-PR approval, Code security (Dependabot, secret scanning, push protection), "require actions pinned to a SHA" | GitHub → Settings | this doc | set again | §4 |
| The agent's GitHub account `dashnash-agent` (write, not admin) and its claude.ai connection | GitHub, claude.ai | your password manager | reconnect at claude.ai's GitHub connection | §4 |
| Google OAuth clients: one web client per environment, two iOS clients | Google Cloud Console, project 880697273676 → Credentials | the console (client IDs are in `stacks.config.json`; there is no client secret) | make a new client, update `stacks.config.json` in a PR | §1b, [IOS_SETUP.md](IOS_SETUP.md) §6 |
| Apple: Team ID, bundle IDs, the two App Store Connect apps, TestFlight groups, Sign in with Apple Services IDs | Apple Developer, App Store Connect | the consoles; IDs are in `stacks.config.json` | redo the step (the **iOS provision** workflow re-creates bundle IDs and groups) | [IOS_SETUP.md](IOS_SETUP.md) §1, §4, §5, §10 |
| Route 53 hosted zones (`hostedZoneId` or `"lookup"`) and the domain registrations | AWS Route 53 | the registrar | zones are looked up by name in CI | §1 |
| Self-hosted runners: two ephemeral Linux runners; the Mac's release and PR runners | homelab repo (`homelab:roles/github_runner`, runbook `homelab:docs/runbooks/github-runner.md`); the Mac | homelab repo; the Mac's users | re-register (delete the variable to fall back to GitHub-hosted meanwhile) | §9, [IOS_SETUP.md](IOS_SETUP.md) "Self-hosted Mac runners" |
| Backups: vault `stacks-prod-backups`, the AWS Backup DynamoDB opt-in | AWS Backup | made by the platform stack; the opt-in is an account setting | re-check the opt-in | [RESTORE.md](RESTORE.md) §0 |

What to do when a deploy goes wrong: [ROLLBACK.md](ROLLBACK.md).

## 1. Fill in `stacks.config.json`

For each environment: `rootDomain` (apps live at `<slug>.<rootDomain>`), the Route 53
`hostedZoneId` and `hostedZoneName` holding it, the Google OAuth `googleClientId`, and `platformAdmins`.

**None of these are secrets**, which is why they live in the repo:

| Value | Why it is safe to commit |
| --- | --- |
| `rootDomain` | Public: it is in every URL. |
| `hostedZoneId` | An identifier, not a credential. It does nothing without AWS credentials for your account. Or `"lookup"`: CI finds the ID by `hostedZoneName` at deploy time. |
| `googleClientId` | Public by design: Google's sign-in button sends it to every visitor's browser. Stacks uses Google's ID-token flow, which needs **no client secret**. |
| `platformAdmins` | Email addresses (personal, not secret). The repo is private; move them to a GitHub variable if you prefer. |

The real secrets never touch the repo: AWS access comes from GitHub OIDC (no stored keys), and each
app's Platform API credential is generated inside AWS Secrets Manager by its stack.

`hostedZoneId` must be set for sign-in to work across apps: the platform stack creates the
wildcard certificate (`*.<rootDomain>`) and the `auth.` and app hostnames in that zone. With it
empty, stacks still synth and deploy on CloudFront's own domains, which is only useful for smoke tests.

With `"hostedZoneId": "lookup"` the deploy workflows resolve the zone by `hostedZoneName` before
synth (`scripts/lookup-zones.mjs`, through the read-only `cdk-stktest-lookup-role`; Node only, so the
runner needs no AWS CLI; it fails unless exactly one public zone has that name) and pass it as
`-c hostedZoneIds=<name>=<id>`. Synth without
it (sessions, `ci.yml`) uses the placeholder `ZLOOKUPPLACEHOLDER`, which is never deployed:
deploy builds pass `-c requireZones=true`.

`legacyRedirects` (optional, per environment) lists old roots kept only as 301 redirects to
`rootDomain`, e.g. `[{ "rootDomain": "test.old.example", "hostedZoneId": "Z…", "hostedZoneName": "old.example" }]`.
Add `"hosts": ["<label>", …]` (up to 10) to hold only `<label>.<old>` and leave the rest of the old root free.
They get their own stack, `stacks-<env>-legacy-redirect` (see `docs/PLATFORM_SPEC.md`).

## 1b. Google OAuth client (one per environment)

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create an **OAuth client
ID** of type **Web application** for each environment. Under **Authorised JavaScript origins** add
exactly one origin: `https://auth.<rootDomain>` (e.g. `https://auth.dashnash.ninja` and
`https://auth.test.dashnash.ninja`). No redirect URIs and no client secret are needed; apps never
talk to Google. Put each client ID in `googleClientId`. The two must differ (a test in
`packages/infra/tests/config.test.ts` fails otherwise, #96): the platform accepts any credential
addressed to its client, so a shared one would make a staging credential good on production. Create
the web clients in the same Google Cloud project as that environment's iOS client, and after changing
one run `node scripts/ios-xcconfig.mjs` (the iOS app embeds it as `GIDServerClientID`).

## 2. Bootstrap production and deploy the CI stack

Clone the repo and run `npm ci` at its root first (Node 22). Run the `cdk bootstrap` commands from
the **repo root**: inside `infra/`, CDK would first synthesize every app, which needs their web builds.

```bash
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1 --qualifier stkprod --toolkit-stack-name CDKToolkit-stkprod
```

```bash
cd infra && npx cdk deploy -c ci=true stacks-ci
```

(Add `--profile <name>` to these commands if your admin credentials are an AWS CLI profile, e.g. from IAM Identity Center.)

Before deploying it, check which subject GitHub sends for the repo:

```bash
gh api repos/dashnash/stacks/actions/oidc/customization/sub
```

If it says `"use_immutable_subject": true`, copy its `sub_claim_prefix` into `githubSubjectPrefix`
in `stacks.config.json` (GitHub then identifies the repo by IDs, e.g.
`repo:dashnash@3804293/stacks@1449992124`, which survives renames). Otherwise leave it out.

`stacks-ci` also creates the read-only role `stacks-ci-drift-check` (#101; output
`DriftCheckRoleArn`): only GitHub Actions on `main` (by ref, no environment) can assume it, and it
may only read `stacks-test-boundary` and `stacks-test-cfn-exec`. Put its ARN in the repository
variable `AWS_DRIFT_ROLE_ARN` (step 4). The **CI policy drift** workflow then compares those two live
policies with `main` every day (and Deploy does, as a warning): **when it fails, the guardrails in
AWS are not what `main` says; redeploy `stacks-ci` with the command above.** Because only you deploy
this stack, re-run that command after every merge that changes `packages/infra/src/ci-stack.ts`.

`stacks-ci` also creates the account's monthly cost budget `stacks-monthly` (#98): `budget.monthlyUsd`
in `stacks.config.json` (50 USD), with emails to the first production `platformAdmins` address at 80%
of actual and 100% of forecast spend (no confirmation needed; forecast alerts start once AWS has
about five weeks of usage history). Check Billing → Budgets for an older
budget first; keeping both only means two emails.

`stacks-ci` creates the GitHub OIDC provider (pass `existingOidcProviderArn` in `bin/stacks.ts` if
the account already has one), the roles `stacks-ci-production` and `stacks-ci-staging`, and the
staging guardrail policies `stacks-test-cfn-exec` and `stacks-test-boundary`. Note the two role
ARNs it prints.

## 3. Bootstrap staging with the limited execution policy

From the repo root again:

```bash
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1 --qualifier stktest --toolkit-stack-name CDKToolkit-stktest \
  --cloudformation-execution-policies arn:aws:iam::ACCOUNT_ID:policy/stacks-test-cfn-exec
```

Staging deploys can now only do what `stacks-test-cfn-exec` allows: no IAM users, roles only named
`stacks-test-*` with the boundary attached, nothing on resources tagged `stacks:env=production`,
S3 only on `stacks-test-*`/`cdk-stktest-*` buckets, SSM reads only under `/stacks/test/`, and DNS
records only at or under the staging root domains (#94). Production buckets and parameters are also
denied by name.

**When `packages/infra/src/ci-stack.ts` changes** (e.g. the `realtime` module added AppSync Event
APIs to `stacks-test-cfn-exec` and `appsync:EventConnect`/`EventPublish` to `stacks-test-boundary`;
the `gameServer` module (#44) added the VPC, ECS, alarm and SNS statements to `stacks-test-cfn-exec`
and running tasks, passing task roles and `appsync:EventSubscribe` to `stacks-test-boundary`;
monitoring (#75) added the `stacks-test` dashboard to `stacks-test-cfn-exec`; #94 limited S3, SSM
and DNS to staging names in both),
redeploy it from your machine with admin credentials before merging anything that needs it:
`cd infra && npx cdk deploy -c ci=true stacks-ci`. CI never deploys this stack.

## 4. GitHub settings

- **Environments** (Settings → Environments): create `staging` and `production`. For each, set
  *Deployment branches* to **Selected branches: `main`**, and add the variable
  `AWS_STAGING_ROLE_ARN` / `AWS_PRODUCTION_ROLE_ARN` with the ARN from step 2.
- **Repository variable** (Settings → Secrets and variables → Actions → Variables, not an
  environment): `AWS_DRIFT_ROLE_ARN` with the `DriftCheckRoleArn` from step 2 (#101). Until it's set
  the drift check only says so.
- **Make the repo public** (Settings → General → Change visibility). Rulesets and the fork-approval
  setting below need it on GitHub Free. While the repo is private, leave *Run workflows from fork
  pull requests* unchecked.
- **Fork pull requests** (Settings → Actions → General; the section is titled *Approval for running
  fork pull request workflows from contributors* once the repo is public): **Require approval for
  all external contributors**. Fork PRs get no secrets or OIDC token, and never run on the
  self-hosted runners (step 9).
- **Ruleset on `main`** (#93; free because the repo is public). The rules live in
  `.github/rulesets/main.json`: no deletion or force push, every change through a PR, the `check`
  job of `CI` green, one approval on every PR (app-only ones included), and code-owner review on
`CODEOWNERS` paths. Once you've approved, an agent session merges it (the merge train; see
`.claude/skills/merge-train/SKILL.md`). A `hold` label stops any PR from merging.
  Repository admins may bypass only through a PR (to merge their own), so nobody pushes straight to
  `main`. PRs touching `packages/infra/`, `.github/` or `platform/api/` also need the `agent-review`
  status (#111, posted by `.github/workflows/agent-review.yml` once a session records a code review
  of the head commit). Apply it once, and again after editing the file (`PUT …/rulesets/<id>` to update):

  ```bash
  gh api -X POST repos/dashnash/stacks/rulesets --input .github/rulesets/main.json
  ```
- **Code security** (Settings → Code security, #99): turn on Dependabot alerts, Dependabot
  security updates, secret scanning and push protection. Then Settings → Actions → General: tick
  **Require actions to be pinned to a full-length commit SHA** (CI's `check-action-pins` step
  enforces the same in the repo). Dependabot PRs touch `package-lock.json` or `.github/`, so each
  needs your code-owner review.
- **Environments**: check that `staging`, `production` and `ios-release` each allow only `main`:

  ```bash
  for env in staging production ios-release; do
    gh api repos/dashnash/stacks/environments/$env/deployment-branch-policies --jq '.branch_policies[]|"\(.type) \(.name)"'
  done   # each prints only: branch main
  ```
- **Claude sessions act as `dashnash-agent`**, never as the owner. A cloud session uses whichever
  GitHub account is connected to the claude.ai account at https://claude.ai/connect-github; connect
  `dashnash-agent` (write access, not admin). The ruleset's admin bypass then never applies to a
  session, and its PRs are authored by the agent, so the owner can approve them as code owner.
  Check from a session: `curl -sS https://api.github.com/repos/dashnash/stacks/rulesets/<id>` reports
  `"current_user_can_bypass": "never"`.

## 5. First deploy

Merge to `main` (or re-run the **Deploy** workflow). It deploys `stacks-test-platform`, then
`stacks-prod-platform`, then every production app. The first platform deploy waits for the
certificate's DNS validation (a few minutes). Then open `https://auth.<rootDomain>`.

Each merge to `main` deploys what it changed (#47): nothing for docs only, just that app for a
one-app change, else all of staging first (platform and every app), then production. The first
Deploy run (no earlier green one) always deploys everything.

## 6. Try a branch on staging

To try an app from a branch before merging:

```bash
gh workflow run deploy-test.yml -f app=hello -f ref=<branch>
```

The run summary prints the staging URL. The next merge to `main` that deploys that app (a change
to it, or a full deploy) puts it back to `main`; docs-only and other-app merges leave it.

## 7. App secrets (API keys an app needs)

Apps list the keys they need in `app.manifest.json` under `secrets` (names only). Store each value
yourself, once per environment, with your admin profile. CI never sees it and it never goes in git:

```bash
aws ssm put-parameter --name /stacks/prod/secrets/<slug>/<NAME> --type SecureString --value '<value>' --overwrite --profile admin --region us-east-1
```

Tag every production parameter right after storing it (`put-parameter` can't combine `--tags` with
`--overwrite`). Staging is kept away from `/stacks/prod/` by name either way; the tag is the second
lock (#94):

```bash
aws ssm add-tags-to-resource --resource-type Parameter --resource-id /stacks/prod/secrets/<slug>/<NAME> --tags Key=stacks:env,Value=production --profile admin --region us-east-1
```

Use `/stacks/test/...` for staging (no tag needed). The app picks the value up within 5 minutes, with no deploy.
`https://<slug>.<rootDomain>/api/health` lists required secrets that are still missing (by name).
To remove one: `aws ssm delete-parameter --name <same name> --profile admin --region us-east-1`.

Keys are used from the app's server, so restrict them by **API** only: website (HTTP referrer)
restrictions make every call fail, and Lambda has no fixed IP. If a provider rejects a key, the app's
logs say why (e.g. `API_KEY_HTTP_REFERRER_BLOCKED`).

## 8. Game servers (the `gameServer` module)

Nothing to set up for the module itself: the platform stack creates the shared network (a VPC with
public subnets, an ECS cluster) and each app with the module gets its own task definition. Two
optional things are yours:

**TURN key (for players whose network blocks UDP).** Without it joins still work with STUN only, and
`https://<slug>.<rootDomain>/api/health` lists `missingPlatformKeys`. In the Cloudflare dashboard
create a **Realtime → TURN** key, then store its two halves once per environment (one key serves
every app; cost about $0.05/GB after 1 TB/month free):

```bash
aws ssm put-parameter --name /stacks/prod/secrets/platform/CLOUDFLARE_TURN_KEY_ID --type SecureString --value '<key id>' --overwrite --profile admin --region us-east-1
```

```bash
aws ssm put-parameter --name /stacks/prod/secrets/platform/CLOUDFLARE_TURN_API_TOKEN --type SecureString --value '<api token>' --overwrite --profile admin --region us-east-1
```

Then tag both (#94):

```bash
for name in CLOUDFLARE_TURN_KEY_ID CLOUDFLARE_TURN_API_TOKEN; do
  aws ssm add-tags-to-resource --resource-type Parameter --resource-id /stacks/prod/secrets/platform/$name --tags Key=stacks:env,Value=production --profile admin --region us-east-1
done
```

Use `/stacks/test/...` for staging (no tag needed). Apps pick it up within 5 minutes, with no deploy.

**Alarm email.** Each app has an alarm for a game server running over 3 hours (rooms end themselves
after 2). They all go to one SNS topic per environment, `stacks-prod-game-alarms` and
`stacks-test-game-alarms`: subscribe your email to each (SNS console → Topics → Create subscription →
Email) and confirm the message it sends.

## 9. Self-hosted Linux runners (optional)

Every Linux job runs on `runs-on: ${{ vars.LINUX_RUNNER && fromJSON(vars.LINUX_RUNNER) || 'ubuntu-latest' }}`.
With the repository variable `LINUX_RUNNER` unset, jobs use GitHub-hosted `ubuntu-latest`. Set it
(Settings → Secrets and variables → Actions → Variables) to `["self-hosted","linux","homelab-stacks"]`
to run them on the owner's own hardware: two ephemeral runners managed as code in the homelab repo
(`roles/github_runner`, runbook `docs/runbooks/github-runner.md` there). Each job gets a fresh
runner and its own Docker daemon, and job traffic can reach the internet but not the home network.
The production deploy runs there too; its AWS access is still the GitHub OIDC role, unchanged.

The iOS app's macOS jobs use `macos-26` unless `MACOS_RUNNER` / `MACOS_PR_RUNNER` point them at a
self-hosted Mac, split so PR code doesn't run where releases are signed once `MACOS_PR_RUNNER` is set (`docs/IOS_SETUP.md`,
"Self-hosted Mac runners"). Jobs that run on pull
requests add `github.event.pull_request.head.repo.full_name == github.repository` to that
condition, so a PR from a fork always runs on `ubuntu-latest`, never on the owner's hardware
(`tools/app-conformance/tests/repo-guard.test.ts` checks it).

To fall back (runners down, or to compare), delete the variable or set it empty: no PR needed.
Jobs already queued for the self-hosted label keep waiting, so cancel and re-run them.
