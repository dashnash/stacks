# Domain move: `iamdashnash.com` → `dashnash.ninja` (#42)

Moves Stacks to `dashnash.ninja` (staging `test.dashnash.ninja`) and the iOS app to the bundle IDs
`ninja.dashnash.stacks` / `ninja.dashnash.stacks.test`. The old domain stays up **only as 301
redirects**: every old host (`auth.`, `<slug>.`, the bare domain, and `test.*`) goes to the same host
label, path and query on the new root (`stacks-<env>-legacy-redirect`, see `docs/PLATFORM_SPEC.md`).

Two PRs: PR 1 moved staging (and all shared code), PR 2 flips production. This runbook is for PR 2;
staging went the same way. Run every AWS command on your own machine with admin credentials
(`export AWS_PROFILE=admin AWS_REGION=us-east-1`), never in CI or a Claude session.

**What people notice:** everyone signs in once more (new cookie and sign-in origin). Old links and
bookmarks keep working through the redirects. The iOS app is a new app (new bundle ID): people install
**DashyHQ** again from TestFlight; the old app's phones stop getting pushes (the Platform API forgets
devices registered under another bundle ID the next time it pushes to that person). Nothing is lost:
accounts, roles and every app's data stay where they are.

## 0. Pre-flight

- [ ] Staging is checked: `https://auth.test.dashnash.ninja` sign-in works, `https://hello.test.iamdashnash.com/x?y=1`
      answers 301 to `https://hello.test.dashnash.ninja/x?y=1`, and the **DashyHQ Test** TestFlight build
      installs under `ninja.dashnash.stacks.test`, signs in with Google, opens universal links in the app and gets push.
- [ ] **Google Cloud console**, the web OAuth client: `https://auth.dashnash.ninja` is an authorised
      JavaScript origin (keep the old ones until step 5).
- [x] **Google Cloud console**: an iOS OAuth client for `ninja.dashnash.stacks`, its ID in
      `environments.production.native.googleIosClientIds` (`stacks.config.json`) and
      `native/ios/Config/Production.xcconfig` (done in PR 2).
- [ ] **App Store Connect**: the **DashyHQ** app record for `ninja.dashnash.stacks` exists, and
      `ios-provision.yml` has run on `main` since (bundle ID with Associated Domains + Push, TestFlight group).
- [ ] **APNs**: the existing key is a team key (Certificates, Identifiers & Profiles → Keys: "Apple
      Push Notifications service (APNs)" with no bundle restriction), so it covers the new bundle ID.
- [ ] The `dashnash.ninja` hosted zone answers publicly:

```bash
dig +short NS dashnash.ninja
```

- [ ] Nothing but the apps on `main` uses the old certificate. The deploy only moves stacks built
      from `main`; anything else on the old certificate (a branch preview, a stack for an app that
      left `apps/`) keeps it in use and its hostname on the old domain. On staging two branch previews
      (Wishlist, Potluck) did exactly that and had to be deleted. Every distribution listed should be
      a production app on `main` (comment `stacks prod <slug>`):

```bash
aws acm list-certificates --query "CertificateSummaryList[?DomainName=='*.iamdashnash.com'].CertificateArn" --output text
```

```bash
aws acm describe-certificate --certificate-arn <that ARN> --query Certificate.InUseBy
```

## 1. Merge PR 2

`deploy.yml` runs: the zones job looks up `dashnash.ninja`, then staging (no changes), then production
in this order, which is what keeps the CloudFront aliases from clashing (an alias can be on only one
distribution):

1. `stacks-prod-platform`: the new certificate (`*.dashnash.ninja`), `auth.dashnash.ninja` and the bare
   domain move to the new zone; the old `auth.iamdashnash.com` / `iamdashnash.com` records and aliases go.
   The old `*.iamdashnash.com` certificate is **left in place** (the platform certificate is retained):
   the app distributions still use it until step 2, and deleting it then would make CloudFormation
   retry once a minute while nothing could release it. That happened on staging; step 5 deletes it.
2. Every `stacks-prod-app-<slug>`: `<slug>.dashnash.ninja`; the old records and aliases go.
3. `stacks-prod-legacy-redirect` (depends on all of the above): `iamdashnash.com` + `*.iamdashnash.com`.

Between 1 and 3 the old names don't answer for a few minutes (nothing holds them). The new
certificates validate by DNS, usually in a few minutes; the first deploy takes about 15-20 minutes.

The ios workflow builds **DashyHQ** under the new bundle ID and uploads it to TestFlight.

## 2. Checks

```bash
curl -sI https://auth.dashnash.ninja/ | head -1
```

```bash
curl -sI 'https://hello.iamdashnash.com/x?y=1' | grep -iE '^(HTTP|location)'
```

Expect `301` and `location: https://hello.dashnash.ninja/x?y=1`. Also:

```bash
curl -sI https://iamdashnash.com/abc | grep -i '^location'
```

```bash
curl -sI https://mofobookklub.iamdashnash.com/ | grep -i '^location'
```

Expect `https://auth.dashnash.ninja/abc` and `https://mofobookklub.dashnash.ninja/`. Staging's redirect
still wins for its own hosts:

```bash
curl -sI https://hello.test.iamdashnash.com/ | grep -i '^location'
```

Expect `https://hello.test.dashnash.ninja/`. Then by hand:

- [ ] Sign in at `https://auth.dashnash.ninja`; the grid shows every member with their role.
- [ ] Book Club at `https://mofobookklub.dashnash.ninja`: meetings, the Lineup, comments, photos.
- [ ] The apple-app-site-association is served on the new hosts only:

```bash
curl -s https://auth.dashnash.ninja/.well-known/apple-app-site-association
```

- [ ] The **DashyHQ** TestFlight build installs, signs in with Google, opens a tapped
      `https://hello.dashnash.ninja` link in the app, and gets a push (request access to an app from
      another account).

## 3. Tell people

Members sign in once more, and iPhone testers install **DashyHQ** again from the TestFlight invite.

## 4. If something goes wrong

`cdk deploy --all` never deletes a stack that has left the assembly, so the redirect stack must go
first, by hand, or it keeps the old names and the old stacks can't take them back:

```bash
aws cloudformation delete-stack --stack-name stacks-prod-legacy-redirect
```

```bash
aws cloudformation wait stack-delete-complete --stack-name stacks-prod-legacy-redirect
```

Then revert PR 2's config commit (`stacks.config.json` and `native/ios/Config/Production.xcconfig`)
in a PR and merge it: `deploy.yml` moves production back to `iamdashnash.com`. People sign in again;
nothing else changes. The old app record and iOS client still exist until step 5, so the old app
works again too.

## 5. Cleanup (after a week or two of the new domain)

- [ ] App Store Connect: remove the old **DashyHQ** / **DashyHQ Test** records (`com.dashyhq.stacks`,
      `com.dashyhq.stacks.test`) from TestFlight testing.
- [ ] Google Cloud console: drop `https://auth.iamdashnash.com` and `https://auth.test.iamdashnash.com`
      from the web client's origins, and delete the two old iOS clients.
- [ ] ACM (us-east-1): delete the old wildcard certificate `*.iamdashnash.com` (the platform stack
      retains replaced certificates; staging's `*.test.iamdashnash.com` was deleted during its move).
      It shows **In use: No**.

```bash
aws acm list-certificates --query "CertificateSummaryList[?contains(DomainName, 'iamdashnash')].[DomainName,CertificateArn,InUse]" --output table
```

Only the two redirect certificates (`mofobookklub.iamdashnash.com`, `mofobookklub.test.iamdashnash.com` since #140) should stay, in use.

Since #140 the redirects hold only `mofobookklub.iamdashnash.com` and `mofobookklub.test.iamdashnash.com`
(`hosts` in `stacks.config.json`): the bare `iamdashnash.com` and its other subdomains are free for the
homelab. To retire the rest later, delete `legacyRedirects` from `stacks.config.json` and both
`stacks-<env>-legacy-redirect` stacks by hand.
