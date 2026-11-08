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
| `hostedZoneId` | An identifier, not a credential. It does nothing without AWS credentials for your account. |
| `googleClientId` | Public by design: Google's sign-in button sends it to every visitor's browser. Stacks uses Google's ID-token flow, which needs **no client secret**. |
| `platformAdmins` | Email addresses (personal, not secret). The repo is private; move them to a GitHub variable if you prefer. |

The real secrets never touch the repo: AWS access comes from GitHub OIDC (no stored keys), and each
app's Platform API credential is generated inside AWS Secrets Manager by its stack.

Until the platform stack exists (phase 2), leave `hostedZoneId` empty: apps are then served on
their CloudFront domain instead of `<slug>.<rootDomain>`, because the wildcard certificate is
created by the platform stack.

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

## 4. GitHub settings

- **Environments** (Settings → Environments): create `staging` and `production`. For each, set
  *Deployment branches* to **Selected branches: `main`**, and add the variable
  `AWS_STAGING_ROLE_ARN` / `AWS_PRODUCTION_ROLE_ARN` with the ARN from step 2.
- **Branch protection on `main`**: require the `CI / check` status and review from code owners.

## 5. Try it

```bash
gh workflow run deploy-test.yml -f app=hello -f ref=main
```

The run summary prints the staging URL.
