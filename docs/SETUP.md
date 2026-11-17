# One-time setup

Everything after this is done by CI. These steps need AWS admin credentials on your own machine,
once. Nothing here goes into a Claude session.

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
They get their own stack, `stacks-<env>-legacy-redirect` (see `docs/PLATFORM_SPEC.md`).

## 1b. Google OAuth client (one per environment)

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create an **OAuth client
ID** of type **Web application** for each environment. Under **Authorised JavaScript origins** add
exactly one origin: `https://auth.<rootDomain>` (e.g. `https://auth.dashnash.ninja` and
`https://auth.test.dashnash.ninja`). No redirect URIs and no client secret are needed; apps never
talk to Google. Put each client ID in `googleClientId`.

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
`stacks-test-*` with the boundary attached, and nothing on resources tagged `stacks:env=production`.

**When `packages/infra/src/ci-stack.ts` changes** (e.g. the `realtime` module added AppSync Event
APIs to `stacks-test-cfn-exec` and `appsync:EventConnect`/`EventPublish` to `stacks-test-boundary`;
the `gameServer` module (#44) added the VPC, ECS, alarm and SNS statements to `stacks-test-cfn-exec`
and running tasks, passing task roles and `appsync:EventSubscribe` to `stacks-test-boundary`;
monitoring (#75) added the `stacks-test` dashboard to `stacks-test-cfn-exec`),
redeploy it from your machine with admin credentials before merging anything that needs it:
`cd infra && npx cdk deploy -c ci=true stacks-ci`. CI never deploys this stack.

## 4. GitHub settings

- **Environments** (Settings → Environments): create `staging` and `production`. For each, set
  *Deployment branches* to **Selected branches: `main`**, and add the variable
  `AWS_STAGING_ROLE_ARN` / `AWS_PRODUCTION_ROLE_ARN` with the ARN from step 2.
- **Fork pull requests** (Settings → Actions → General → Fork pull request workflows): **Require
  approval for all external contributors**. The repo is public; fork PRs get no secrets or OIDC
  token, and never run on the self-hosted runners (step 9).
- **Ruleset on `main`** (#93; free because the repo is public). The rules live in
  `.github/rulesets/main.json`: no deletion or force push, every change through a PR, the `check`
  job of `CI` green, and code-owner review on `CODEOWNERS` paths (app-only PRs merge on green CI).
  Repository admins may bypass only through a PR (to merge their own), so nobody pushes straight to
  `main`. Apply it once, and again after editing the file (`PUT …/rulesets/<id>` to update):

  ```bash
  gh api -X POST repos/dashnash/stacks/rulesets --input .github/rulesets/main.json
  ```

## 5. First deploy

Merge to `main` (or re-run the **Deploy** workflow). It deploys `stacks-test-platform`, then
`stacks-prod-platform`, then every production app. The first platform deploy waits for the
certificate's DNS validation (a few minutes). Then open `https://auth.<rootDomain>`.

Each merge to `main` deploys all of staging first (platform and every app), then production.

## 6. Try a branch on staging

To try an app from a branch before merging:

```bash
gh workflow run deploy-test.yml -f app=hello -f ref=<branch>
```

The run summary prints the staging URL. The next merge to `main` puts staging back to `main`.

## 7. App secrets (API keys an app needs)

Apps list the keys they need in `app.manifest.json` under `secrets` (names only). Store each value
yourself, once per environment, with your admin profile. CI never sees it and it never goes in git:

```bash
aws ssm put-parameter --name /stacks/prod/secrets/<slug>/<NAME> --type SecureString --value '<value>' --overwrite --profile admin --region us-east-1
```

Use `/stacks/test/...` for staging. The app picks the value up within 5 minutes, with no deploy.
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

Use `/stacks/test/...` for staging. Apps pick it up within 5 minutes, with no deploy.

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

The iOS app build jobs (`macos-26`) always stay on GitHub-hosted runners. Jobs that run on pull
requests add `github.event.pull_request.head.repo.full_name == github.repository` to that
condition, so a PR from a fork always runs on `ubuntu-latest`, never on the owner's hardware
(`tools/app-conformance/tests/repo-guard.test.ts` checks it).

To fall back (runners down, or to compare), delete the variable or set it empty: no PR needed.
Jobs already queued for the self-hosted label keep waiting, so cancel and re-run them.
