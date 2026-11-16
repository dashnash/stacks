# Independent review of Stacks, November 2026

Reviewed at commit `fcf8638` (`main`, 2026-11-15). Reviewer: Claude Code, at the owner's request.
This is a report only: nothing was fixed and no follow-up issues were opened.

**How it was done.** The repo was read at `main`; GitHub settings and the full Actions and pull
request history were read through the API; the live sites were probed anonymously over HTTPS and
DNS. Nothing was written, deployed or dispatched anywhere. No AWS credentials were used (the repo's
own rule), so every statement about the AWS account is inferred from the code that builds it.
Section 5 lists what that leaves unverified.

**Rating.** Severity is the damage if it happens (Critical, High, Medium, Low). Priority is when to
act (P0 now, P1 this month, P2 this quarter, P3 when convenient). Effort is S (under an hour),
M (an afternoon) or L (days). Confidence is Confirmed (read directly), Likely (follows from what
was read, not exercised) or Unverified.

**Out of scope, as agreed for the homelab review:** trade-offs that are reasonable for one owner
(one AWS account, one region, one maintainer), work the spec already lists as open, and the
internals of individual apps beyond their blast radius.

## 1. Summary

The design is careful and most of it is real: per-app sessions, hashed tokens, PKCE, no stored
AWS keys, ephemeral runners, a staging stage that has stopped six bad merges before production.
The weak points are at the edges of that design. The staging/production boundary inside the one
AWS account rests on a tag condition that S3, Route 53 and hand-made parameters do not honour, and
the review rules the security model depends on (CODEOWNERS, required checks) are not enforceable on
the current GitHub plan, so in practice anything with write access reaches production as
administrator.

29 findings.

| | P0 | P1 | P2 | P3 | Total |
| --- | --- | --- | --- | --- | --- |
| Critical | 0 | 0 | 0 | 0 | 0 |
| High | 1 | 2 | 0 | 0 | 3 |
| Medium | 0 | 9 | 8 | 0 | 17 |
| Low | 0 | 0 | 4 | 5 | 9 |
| Total | 1 | 11 | 12 | 5 | 29 |

**Do first**

1. SEC-01: write access equals production administrator. Enforce branch protection, or remove
   write from `dashnash-agent`.
2. SEC-03, SEC-04, SEC-06: deny production by name in the staging policies, not only by tag.
3. SEC-02: the runner token kept in the homelab vault can add collaborators to this repo.
4. SEC-05: give staging its own Google client, as `docs/SETUP.md` already says.
5. DR-02, DR-01: version the content buckets and rehearse one restore.
6. OBS-01: an AWS budget alert.
7. SUP-01: turn Dependabot on; the spec says it is.
8. ARCH-01: a smoke check between staging and production.

**What each kind of attacker reaches today**

| Actor | Reach |
| --- | --- |
| Internet visitor | Can make an account and use public apps, as designed. Found no way past a private app's grant check or into another user's session. Can run up cost within the API throttles (OBS-01). |
| A buggy or malicious app, deployed from `main` | Its own table, buckets and members only. Isolation holds in production as far as the IAM in the repo shows. |
| Anyone or anything with write access (today: the owner and `dashnash-agent`) | Production with `AdministratorAccess`, by pushing to `main` (SEC-01). Without touching `main`: production buckets and hand-stored production secrets, through a branch deployed to staging (SEC-03, SEC-04). |
| Someone who reads the homelab vault | Can add themselves as a collaborator here, then the row above (SEC-02). |
| Owner error | A red or unreviewed merge deploys to production with no check after it (WF-01, ARCH-01); a deleted photo cannot be restored (DR-02). |

**Workflow measures** (all 359 Actions runs and all 78 pull requests, 2026-11-08 to 2026-11-15)

| Measure | Value |
| --- | --- |
| Pull request open to merge | median 12.8 min; 90th percentile 7.9 h |
| Merge to production (Deploy run) | median 9.4 min; 90th percentile 21.2 min; 70 runs in 8 days |
| CI on a pull request | median 2.8 min |
| Failure rate | CI 21 of 193 (10.9%); Deploy 6 of 70 (8.6%), none in the production job; iOS 12 of 71 (16.9%) |
| Change safety | 0 reviews on 75 merged PRs; 3 merged with failing checks; 11 merged within 2 minutes of opening |
| Agent share | 125 of 203 commits authored by Claude; 73 of 78 PR branches are `claude/…` |
| Owner toil | By hand with admin credentials: `stacks-ci` after every IAM change, each secret per environment, each cut-over runbook |

## 2. Findings

### Security

#### SEC-01: Write access to the repo is administrator access to the AWS account
- **Severity** High · **Priority** P0 · **Effort** S · **Confidence** Confirmed (settings read; not exercised)
- **Threat:** a compromised or misled agent session; a leaked `dashnash-agent` token.
- **Evidence:** `GET /repos/dashnash/stacks/branches/main/protection` answers 403 "Upgrade to GitHub
  Pro"; rulesets the same. Collaborators: `dashnash` (admin), `dashnash-agent` (write).
  `deploy.yml` runs on every push to `main` and its `production` job assumes
  `stacks-ci-production`; production is bootstrapped with the default execution policy
  (`packages/infra/src/ci-stack.ts:144`, "AdministratorAccess"). The `production` environment only
  checks that the branch is `main`.
- **Impact:** one direct push to `main` from the agent account deploys arbitrary infrastructure to
  production. Every other control in the spec (CODEOWNERS, the path guard, the staging split) sits
  behind this one. The spec knows the plan limit (`docs/PLATFORM_SPEC.md:404`) and says to "keep
  merge rights to the platform owner"; a second account with write breaks that.
- **Recommendation:** GitHub Pro and a rule on `main` requiring a pull request, the `CI / check`
  status and code-owner review. Until then, drop `dashnash-agent` to read and let it work from a
  fork, or accept the risk in the spec in so many words.

#### SEC-02: The runner token in the homelab vault can add collaborators here
- **Severity** High · **Priority** P1 · **Effort** M · **Confidence** Likely (scope taken from the runbook, not from the token)
- **Threat:** a device on the home LAN; anyone who obtains the homelab vault.
- **Evidence:** the homelab runbook `docs/runbooks/github-runner.md` creates a fine-grained token
  with "Administration: Read and write" on `dashnash/stacks`, stored as vault key
  `github_runner_stacks_pat_prod` and on `kairos-prod` at `/etc/github-runner/pat`. GitHub's
  permission table puts adding a collaborator, editing an environment and editing its branch
  policy under Administration: write. The homelab review (SEC-01 there) found that vault readable
  without credentials on the LAN, behind a short password.
- **Impact:** vault reader → adds their own account with push → SEC-01. The two projects' worst
  findings chain into each other.
- **Recommendation:** fix the homelab vault exposure first. Then register the runners through a
  GitHub App installed on this repo only, which can mint registration tokens without holding
  repository administration; or keep the token off the shared vault and rotate it on a short expiry.

#### SEC-03: Staging roles can read and write production S3 buckets
- **Severity** High · **Priority** P1 · **Effort** S · **Confidence** Likely (policy read; AWS behaviour cited; not exercised)
- **Threat:** anyone who can dispatch `deploy-test.yml` (write access); a malicious branch.
- **Evidence:** both staging policies allow `s3:*` on `*` and rely on one statement to keep
  production out: `NeverProduction`, a deny on `aws:ResourceTag/stacks:env = production`
  (`packages/infra/src/ci-stack.ts:86`, `:111`, `:122`, `:191`). AWS: "By default, ABAC is disabled
  for all Amazon S3 general purpose buckets" (S3 User Guide, "Enabling ABAC in general purpose
  buckets"). Nothing in the repo enables it. `deploy-test.yml` synthesizes the template from the
  branch, including the branch's copy of `packages/infra`; `assembly-check.ts` checks the stack
  name, IAM resource types, the presence of a boundary and the absence of images, not what the
  roles inside may do.
- **Impact:** a branch can ship a staging Lambda whose role has `s3:*`. That Lambda can overwrite
  `index.html` in the production portal bucket (script running on `auth.dashnash.ninja` for every
  visitor, including the platform admin), read Book Club's content bucket (photos of real people),
  and write to the production CDK asset bucket. This path needs no push to `main`, so it survives
  fixing SEC-01.
- **Recommendation:** add name-based denies to both policies: `arn:aws:s3:::stacks-prod-*`,
  `arn:aws:s3:::cdk-stkprod-*` and their objects. Better, replace `s3:*` on `*` in the boundary
  with `arn:aws:s3:::stacks-test-*` and the `stktest` asset bucket. Then prove it once: from a
  staging role, a `GetObject` on a production bucket must answer AccessDenied.

#### SEC-04: Hand-stored production secrets are readable from staging roles
- **Severity** Medium · **Priority** P1 · **Effort** S · **Confidence** Likely (tags on the live parameters not read)
- **Threat:** as SEC-03.
- **Evidence:** the boundary allows `ssm:GetParameter*` and `kms:Decrypt` on `*`
  (`ci-stack.ts:87`). Production secrets are created by hand with commands that set no tags
  (`docs/SETUP.md:127`, `:150`, `:154`; `docs/IOS_SETUP.md:151-152`), so the tag deny cannot match
  them.
- **Impact:** a staging Lambda built from a branch can read `/stacks/prod/secrets/**`: the APNs
  signing key (push notifications to every device), the Cloudflare TURN API token, app API keys.
- **Recommendation:** scope the boundary's SSM actions to `parameter/stacks/test/*` and add an
  explicit deny on `parameter/stacks/prod/*`. Add `--tags Key=stacks:env,Value=production` to the
  runbook commands as a second layer.

#### SEC-05: Staging and production share one Google OAuth client
- **Severity** Medium · **Priority** P1 · **Effort** S · **Confidence** Confirmed (config read; replay not exercised)
- **Threat:** whoever controls any page on `auth.test.dashnash.ninja` (SEC-03 gives that).
- **Evidence:** `stacks.config.json:12` and `:23` hold the same `googleClientId`. The verifier
  accepts any Google token whose audience is that client (`platform/api/src/google.ts:18`).
  `docs/SETUP.md` section 1b says one client per environment.
- **Impact:** a Google credential captured on staging is valid on production for its lifetime
  (about an hour): post it to `https://auth.dashnash.ninja/api/auth/google` and receive a 90-day
  production session as that person. Staging's main user is the platform admin.
- **Recommendation:** create the second client, as the runbook describes, and put it in the
  staging block.

#### SEC-06: A staging deploy can change records anywhere in the shared DNS zone
- **Severity** Medium · **Priority** P2 · **Effort** S · **Confidence** Likely
- **Threat:** as SEC-03.
- **Evidence:** `route53:ChangeResourceRecordSets` on `*` (`ci-stack.ts:125`). Staging lives inside
  the production zone (`hostedZoneName: dashnash.ninja` for both environments), and the zone is
  not created by any stack, so it carries no `stacks:env` tag for the deny to match. The same
  policy allows `acm:RequestCertificate`.
- **Impact:** a branch template can add records under `dashnash.ninja` (a new host that is
  same-site with every production app, mail records, certificate validation records for
  production names). Existing records are safe only because CloudFormation refuses to create a
  name that exists.
- **Recommendation:** add a condition to that statement:
  `route53:ChangeResourceRecordSetsNormalizedRecordNames` must match `*.test.dashnash.ninja` (and
  the legacy staging root). Longer term, delegate `test.dashnash.ninja` to its own zone.

#### SEC-07: The "tighter limits on login and request-access" in the spec do not exist
- **Severity** Low · **Priority** P2 · **Effort** S · **Confidence** Confirmed
- **Evidence:** `docs/PLATFORM_SPEC.md:469`. The platform API has one stage-wide throttle, 50
  requests per second with a burst of 100 (`packages/infra/src/platform-stack.ts:210`); no route
  has its own, and there is no per-caller limit or WAF. `POST /api/apps/:slug/request` notifies
  every approver of a private app.
- **Impact:** one visitor can use the whole platform's budget of requests, which signs everyone
  else out of the sign-in path for as long as they keep it up; cost is bounded by the throttle.
- **Recommendation:** per-route throttles on `/api/auth/*` and `/api/apps/*/request`, or correct
  the spec.

#### SEC-08: The Mac runner builds pull requests and later holds the App Store Connect key
- **Severity** Medium · **Priority** P2 · **Effort** M · **Confidence** Unverified (the runner's setup is not in either repo)
- **Evidence:** `ios.yml:92` sends same-repo pull request builds to `vars.MACOS_RUNNER`
  (`stacks-mac`, online); `ios.yml:163` runs the release job, with `ASC_KEY_P8`, on the same
  runner. The Linux runners are documented as one-job containers; nothing documents the Mac.
- **Impact:** if the Mac runner keeps its user and disk between jobs, code from any branch can
  leave something behind that reads the signing key on the next release.
- **Recommendation:** document how `stacks-mac` is isolated. If it is not, keep pull request
  builds on `macos-26` and use the Mac only for `main`.

#### SEC-09: `GET /logout` signs a person out of everything without a request header
- **Severity** Low · **Priority** P3 · **Effort** S · **Confidence** Confirmed
- **Evidence:** `platform/api/src/app.ts:232`; the cookie is `SameSite=Lax`, which a top-level
  link satisfies.
- **Impact:** any link can end a person's sessions on every app and device and remove their push
  devices. A nuisance, not a breach.
- **Recommendation:** require the `return` parameter to be present and valid before acting, or
  show a one-click confirmation when the request did not come from one of the platform's origins.

#### SEC-10: No CAA or mail-policy records on `dashnash.ninja`
- **Severity** Low · **Priority** P3 · **Effort** S · **Confidence** Confirmed (`dig`, 2026-11-15)
- **Evidence:** `dig CAA dashnash.ninja`, `dig TXT dashnash.ninja` and `dig TXT _dmarc.dashnash.ninja` return nothing.
- **Impact:** any certificate authority may issue for the domain, and anyone may send mail that
  claims to be from it; sign-in links by email are a natural phishing lure for this platform.
- **Recommendation:** `CAA 0 issue "amazon.com"`, an SPF record of `v=spf1 -all` and a DMARC
  `p=reject` record, until the `email` module needs otherwise.

### Architectural robustness

#### ARCH-01: Production deploys as soon as CloudFormation finishes on staging
- **Severity** Medium · **Priority** P1 · **Effort** S · **Confidence** Confirmed
- **Evidence:** `deploy.yml` has no step between the `staging` and `production` jobs that calls
  the deployed system. "Staging passed" means the stacks updated.
- **Impact:** a change that deploys cleanly and breaks sign-in reaches production 10 minutes
  after merge with nothing in the way. Monitoring is pull-only by decision (#75), so the first
  signal is a person saying so.
- **Recommendation:** after the staging job, check `/api/health` on the portal and each app, the
  public catalog, and that `/authorize` for one app redirects to sign-in. Run the same after
  production and fail the run loudly.

#### ARCH-02: Rolling back is a revert and a full redeploy, and a failed run can leave mixed versions
- **Severity** Medium · **Priority** P2 · **Effort** M · **Confidence** Likely (no failed production run exists to observe)
- **Evidence:** `cdk deploy --all --concurrency 4`; each stack rolls back alone. No rollback
  procedure in `docs/`. Deploy runs take 9 to 21 minutes.
- **Impact:** if app 3 of 5 fails, the platform and two apps are on the new SDK and the rest on
  the old. Recovery is a revert pull request and another full run.
- **Recommendation:** write the procedure down (which run to re-run, when to revert), and state in
  the spec that the Platform API must stay compatible with the previous SDK for one release.

#### ARCH-03: The CI IAM stack is deployed by hand and can drift from the repo unseen
- **Severity** Medium · **Priority** P2 · **Effort** S · **Confidence** Likely (the live policies were not read)
- **Evidence:** `docs/SETUP.md:88-94`: redeploy `stacks-ci` "from your machine with admin
  credentials before merging anything that needs it". Nothing compares the live policies with
  `ci-stack.ts`.
- **Impact:** a guardrail fix merged but never applied protects nothing (this applies to the
  fixes for SEC-03, SEC-04 and SEC-06); a forgotten redeploy fails staging after merge.
- **Recommendation:** a job that reads the two managed policies with a read-only role and fails
  when they differ from the synthesized ones.

#### ARCH-04: The platform Lambda may read more app secrets than it uses
- **Severity** Low · **Priority** P3 · **Effort** S · **Confidence** Confirmed
- **Evidence:** `platform-stack.ts:192` grants `secret:stacks-<env>-app-*`, which also matches each
  app's `-realtime-key` and `-game-key`; the platform only reads `-credential`.
- **Recommendation:** narrow the resource to `stacks-<env>-app-*-credential-*`.

### Extensibility

#### EXT-01: Every merge tests, builds and deploys everything, twice
- **Severity** Medium · **Priority** P2 · **Effort** M · **Confidence** Confirmed
- **Evidence:** `deploy.yml` has no path filter and deploys every stack in both environments;
  median 9.4 minutes and 90th percentile 21.2 minutes with five apps. One runner pair serves all
  jobs.
- **Impact:** deploy time and queueing grow with each app, and a docs-only merge costs the same as
  a platform change. At the spec's horizon of a few dozen apps this becomes the bottleneck of the
  creator workflow.
- **Recommendation:** skip the run when only `docs/` or `*.md` changed; build only the app when
  only `apps/<slug>/` changed (the path classifier already knows which case it is).

#### EXT-02: The spec has drifted from the repo in places agents will trust
- **Severity** Low · **Priority** P2 · **Effort** S · **Confidence** Confirmed
- **Evidence:** `docs/PLATFORM_SPEC.md` lists `docs/ARCHITECTURE.md` (`:375`) and
  `platform/portal-bar/` (`:358`), which do not exist; says "Dependabot on" (`:471`, see SUP-01)
  and "tighter limits" (`:469`, see SEC-07); says CI tests "changed workspaces" while `ci.yml` runs
  everything; calls the session cookie `__Host-stacks` where the code uses `__Host-stacks-portal`.
- **Impact:** `CLAUDE.md` names the spec as the source of truth for every agent.
- **Recommendation:** one pass to correct these; mark controls as "planned" until they exist.

### Workflow effectiveness

#### WF-01: Merging is not gated on CI, and a merge is a production deploy
- **Severity** Medium · **Priority** P1 · **Effort** S · **Confidence** Confirmed
- **Evidence:** of 75 merged pull requests, 3 were merged with a failing check and 11 within two
  minutes of opening, before a 2.8-minute CI could finish. Four of the six failed Deploy runs
  failed in `build`, which reruns the tests after the merge.
- **Impact:** the staging stage is the only automatic stop, and it stops at CloudFormation
  (ARCH-01).
- **Recommendation:** the rule in SEC-01 fixes this. Without it, merge with
  `gh pr merge --auto` only, never the button.

#### WF-02: One in ten CI runs and one in six iOS runs fail
- **Severity** Low · **Priority** P2 · **Effort** M · **Confidence** Confirmed (counts); causes not read
- **Evidence:** CI 21 of 193, iOS 12 of 71, Deploy 6 of 70 over eight days.
- **Recommendation:** read the 39 failures once and sort them into real catches and flakes; the
  split decides whether this is a strength or a tax. Issue #47 ("Investigate Actions for
  Optimizations") is the natural home.

#### WF-03: The full test suite runs twice for every merge
- **Severity** Low · **Priority** P3 · **Effort** S · **Confidence** Confirmed
- **Evidence:** `ci.yml` on push to `main` and the `build` job of `deploy.yml` both run `npm test`
  on the same commit.
- **Recommendation:** drop the push trigger from `ci.yml`, or let `deploy.yml` depend on it.

### Recoverability

#### DR-01: No restore has been rehearsed and no runbook describes one
- **Severity** Medium · **Priority** P1 · **Effort** M · **Confidence** Confirmed (repo); live backup settings not read
- **Evidence:** production tables have point-in-time recovery and are retained
  (`platform-stack.ts`, `app-stack.ts`); that is the only backup. `docs/` has cut-over and setup
  runbooks, none for restoring a table. A restore creates a new table under a new name, which the
  stacks and the registry do not expect.
- **Impact:** after a bad migration or a bug that corrupts grants, recovery is improvised, and
  after 35 days it is impossible.
- **Recommendation:** restore the staging platform table once, write down the steps to point the
  stack at the result, and take a monthly on-demand backup or export of the production tables.

#### DR-02: Content buckets hold the only copy of members' photos, unversioned
- **Severity** Medium · **Priority** P1 · **Effort** S · **Confidence** Confirmed
- **Evidence:** `app-stack.ts:223`: `ContentBucket` has no `versioned: true`; the app's Lambda has
  read, write and delete. The spec: "Photos of people never go in git. Book Club's shared faces
  live only in its content bucket."
- **Impact:** one bad delete or overwrite, by a bug or an admin, is permanent.
- **Recommendation:** `versioned: true` with a lifecycle rule that expires old versions after 90
  days.

#### DR-03: The state set up by hand has no inventory
- **Severity** Low · **Priority** P2 · **Effort** S · **Confidence** Confirmed
- **Evidence:** SSM secrets per environment (app keys, TURN key, APNs key), three GitHub
  environment secrets, two environment variables, two repository variables, the Google and Apple
  console settings and `stacks-ci` are spread over `SETUP.md`, `IOS_SETUP.md` and the homelab
  runbook.
- **Recommendation:** one table in `docs/SETUP.md`: name, where it lives, where the source value
  is kept, how to rotate it.

### Observability and operations

#### OBS-01: Nothing in the repo alerts on cost
- **Severity** Medium · **Priority** P1 · **Effort** S · **Confidence** Unverified (a budget may exist in the console)
- **Evidence:** no `AWS::Budgets` resource or billing alarm in `packages/infra`; sign-up is open
  to any Google account; three apps are public; every app has a public API and CloudFront
  distribution. The only cost alarm is for a game server running over three hours, and it reaches
  a person only if the SNS topic was subscribed by hand.
- **Recommendation:** one AWS Budget with an email alert at a monthly amount you would not expect
  to see, created in `stacks-ci`.

#### OBS-02: Anyone can write log lines through the browser-error endpoint
- **Severity** Low · **Priority** P3 · **Effort** S · **Confidence** Confirmed
- **Evidence:** `POST /api/stacks/client-error` accepts reports signed out
  (`platform/api/src/app.ts:174` and the same route in every app); the "5 per page load" limit is
  in the browser. The header check stops other sites, not a script.
- **Impact:** log noise and ingestion cost up to the API throttle; the `ClientErrors` graph can
  be made meaningless.
- **Recommendation:** a small per-route throttle on this route.

### Agent governance

#### GOV-01: The review model exists on paper only
- **Severity** Medium · **Priority** P1 · **Effort** S · **Confidence** Confirmed
- **Evidence:** 0 reviews on 75 merged pull requests; 125 of 203 commits authored by Claude;
  `CODEOWNERS` has no effect without branch protection. The spec's security section lists
  "`CODEOWNERS` review on shared code" as a control.
- **Impact:** platform, IAM and workflow changes written by an agent reach production on the
  owner's merge click alone. For one owner that can be a fair trade; the spec should then say so,
  because app creators are told the platform is reviewed.
- **Recommendation:** with SEC-01's rule in place this becomes real. Add an agent review
  (`/code-review`) as a required step for `packages/infra`, `.github/` and `platform/api`.

#### GOV-02: Agent rules are prose, with no enforcement in the session
- **Severity** Medium · **Priority** P2 · **Effort** S · **Confidence** Confirmed
- **Evidence:** no `.claude/settings.json` in the repo. "Never use AWS credentials", "edit only
  `apps/<slug>/`" and "only CI deploys" live in `CLAUDE.md`. The path guard runs only on pull
  requests and is not required.
- **Recommendation:** check in a settings file that denies `aws`, `cdk deploy` and
  `git push origin main` for every session in this repo.

### Supply chain and verification

#### SUP-01: Dependabot and secret scanning are off; the spec says Dependabot is on
- **Severity** Medium · **Priority** P1 · **Effort** S · **Confidence** Confirmed
- **Evidence:** the API answers "Dependabot alerts are disabled" and "Secret scanning is
  disabled"; there is no `.github/dependabot.yml`. `npm audit` on the lockfile: 2 critical
  (`vitest`, `tinypool`, development only) and 4 moderate (`aws-cdk-lib` and `fflate` direct).
- **Recommendation:** enable Dependabot alerts and security updates (free on private repos) and
  add a weekly `dependabot.yml` for npm and GitHub Actions.

#### SUP-02: Actions are referenced by tag in jobs that hold the production role
- **Severity** Medium · **Priority** P2 · **Effort** S · **Confidence** Confirmed
- **Evidence:** `actions/checkout@v4`, `aws-actions/configure-aws-credentials@v4`,
  `actions/download-artifact@v4`, `docker://rhysd/actionlint:1.7.12`; repository setting
  `allowed_actions: all`, `sha_pinning_required: false`.
- **Recommendation:** pin to commit SHAs (Dependabot keeps them current) and switch on "require
  SHA pinning".

#### SUP-03: Install scripts run in the job whose output is deployed as administrator
- **Severity** Medium · **Priority** P2 · **Effort** M · **Confidence** Likely
- **Evidence:** the `build` job of `deploy.yml` runs `npm ci` with scripts enabled and uploads
  both cloud assemblies; the `production` job deploys that artifact unchanged. The assembly check
  runs only in `deploy-test.yml`. The spec promises "no install scripts from new dependencies
  without review"; nothing checks it.
- **Impact:** a compromised dependency never sees credentials, yet decides what production runs.
- **Recommendation:** `npm ci --ignore-scripts` in `build`, with an explicit `npm rebuild` for the
  three packages that need scripts; a CI check that fails when the set of packages with
  `hasInstallScript` in the lockfile changes.

## 3. Strengths

- No stored AWS keys anywhere: GitHub OIDC, a role per environment, each trusted by one GitHub
  environment, with the immutable subject claim. The repo has zero Actions secrets outside
  `ios-release`.
- `deploy-test.yml` keeps branch code and credentials in separate jobs, and the credentialed job
  runs `main`'s code with `--ignore-scripts`. Few projects get this right.
- The Linux runners are one job each: fresh container, fresh Docker daemon, egress blocked to the
  home network, the token kept on the host.
- Sessions: 256-bit opaque tokens, only hashes stored, `__Host-` cookies, PKCE with single-use
  60-second codes bound to app and redirect URI, exact-match redirect and logout-return checks
  (probed live: a foreign `return` is refused).
- Security headers are present and identical on every live host checked.
- Staging stopped six bad merges in eight days; none reached the production job.
- Production tables are retained with point-in-time recovery; the game server image is pinned by
  digest.
- 101 test files and about 780 test cases for an eight-day-old codebase, including an in-memory
  end-to-end test of the whole handshake and a conformance suite every app must pass.
- Lead time from idea to production is under half an hour, and `/new-app` makes a new app a
  script, not a project.

## 4. Acknowledged, not re-raised

- One AWS account for staging and production (spec, "One AWS account is kept on purpose"). The
  findings above are about the controls that are meant to make that safe.
- Pull-only monitoring with no alerts (decision #75).
- Branch protection needing a paid plan (`PLATFORM_SPEC.md:404`). SEC-01 is about the mitigation
  the spec names not being in place.
- Open build-plan items: per-PR preview stacks, the per-app cost dashboard, the `uploads` and
  `scheduledJobs` modules, the eval run, step 5 of `docs/DOMAIN_MOVE.md`.
- Open issues #47, #61, #81, #83.

## 5. Not verified

- Anything in the AWS account: whether S3 ABAC was enabled by hand, tags on SSM parameters,
  whether a budget exists, the live content of the two staging policies, CloudTrail.
- SEC-03, SEC-04 and SEC-06 were not exercised; doing so needs a write.
- The runner token's real scope and expiry, and the isolation of `stacks-mac`.
- Which account or token agent sessions use to push, and where the `dashnash-agent` token lives.
- The iOS app (`native/`), the realtime and game-server runtime code, `merge.ts` and `push.ts`,
  and each app's own routes were skimmed or not read.
- The causes of the 39 failed runs.
- Whether Route 53 honours resource tags for record changes; SEC-06 does not depend on it, since
  the zone is not tagged by any stack.
