# iOS app: one-time setup

Gets DashyHQ (production) and DashyHQ Test (staging) from GitHub Actions onto your iPhone through
TestFlight. Background: `docs/NATIVE_APP_SPEC.md`. You do these steps once, in a browser; the
**iOS provision** workflow does the rest through the App Store Connect API. After that, every merge
to `main` that touches the app uploads new builds.

Nothing here is pasted into a Claude session except the values marked **not secret**. The App Store
Connect key goes straight into GitHub.

| What | Who | Where it ends up | Secret? |
| --- | --- | --- | --- |
| Apple Team ID | you | `stacks.config.json` → `native.appleTeamId` | No |
| App Store Connect API key (`.p8`, Key ID, Issuer ID) | you | GitHub environment `ios-release` secrets | **Yes** |
| Signing certificate and App Store profiles | the release job, new each run (the next run revokes the old certificate) | nowhere: never stored | — |
| Bundle IDs with Associated Domains | the **iOS provision** workflow | Apple | No |
| The two App Store Connect apps | you (Apple has no API for it) | Apple | No |
| TestFlight groups that get every build, with you as tester | the **iOS provision** workflow | Apple | No |
| Two iOS OAuth clients | you | `stacks.config.json` → `native.googleIosClientIds` | No |
| APNs key (`.p8` + Key ID), for push | you | SSM SecureStrings, from your Mac (step 9) | **Yes** |
| Two Services IDs, for Sign in with Apple on the web | you | `stacks.config.json` → `appleServicesId` (step 10) | No |

## 1. Your Team ID (not secret)

[developer.apple.com/account](https://developer.apple.com/account) → **Membership details** → **Team ID**
(10 characters, e.g. `A1B2C3D4E5`).

## 2. An App Store Connect API key for GitHub Actions (secret)

[App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
→ **Team Keys** → **Generate API Key**:

- Name: `GitHub Actions (stacks)`
- Access: **Admin**. It registers bundle IDs and manages TestFlight (step 4), and, on every release,
  makes a signing certificate and App Store provisioning profiles (and revokes the previous run's).

Note the **Issuer ID** (top of the page) and the **Key ID**, and **Download** the `.p8` file. Apple
lets you download it only once; keep it somewhere safe, or revoke it and make a new one if lost.

## 3. Put the key in GitHub (secret)

[github.com/dashnash/stacks → Settings → Environments](https://github.com/dashnash/stacks/settings/environments)
→ **New environment** → name `ios-release` → **Configure**:

- **Deployment branches and tags** → **Selected branches and tags** → add `main`. Only workflows on
  `main` can then read these secrets (the same rule as the AWS environments).
- **Environment secrets** → add three:

| Name | Value |
| --- | --- |
| `ASC_KEY_ID` | the Key ID |
| `ASC_ISSUER_ID` | the Issuer ID |
| `ASC_KEY_P8` | the whole contents of the `.p8` file, from `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----` |

## 4. Register the bundle IDs (the workflow does it)

[Actions → iOS provision](https://github.com/dashnash/stacks/actions/workflows/ios-provision.yml) →
**Run workflow** (branch `main`; leave the email empty for now). It registers `com.dashyhq.stacks`
and `com.dashyhq.stacks.test` with Associated Domains, then says the two app records are missing:
that's step 5. Running it again never duplicates anything.

## 5. Create the two apps in App Store Connect (by hand: Apple has no API for this)

[App Store Connect → Apps](https://appstoreconnect.apple.com/apps) → **+** → **New App**, twice:

| Name | Primary language | Bundle ID (pick from the list) | SKU |
| --- | --- | --- | --- |
| DashyHQ | English (U.S.) | `com.dashyhq.stacks` | `dashyhq` |
| DashyHQ Test | English (U.S.) | `com.dashyhq.stacks.test` | `dashyhq-test` |

Platform iOS; User Access **Full Access**. (The App Store name must be unique worldwide; if "DashyHQ"
is taken, pick another name here. The name on the home screen comes from the build, not from this.)

Then run **iOS provision** again, this time with **your Apple ID email**: it gives each app an
internal TestFlight group, "Internal (automatic)", that receives every build, with you in it.

Nothing to set up for signing: each release run makes its own Apple Distribution certificate
(Apple emails you when one is created or revoked, so expect a couple of emails per release) and
no device needs registering for TestFlight. To run builds from Xcode on your own iPhone, sign in
to Xcode with your Apple ID and let it register the phone when you first pick it as a destination.

## 6. Two iOS OAuth clients for native Google sign-in (not secret)

[Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials),
in the **same project as the platform's web client** (`880697273676-…`) → **Create credentials** →
**OAuth client ID** → Application type **iOS**, twice:

| Name | Bundle ID |
| --- | --- |
| DashyHQ (iOS) | `com.dashyhq.stacks` |
| DashyHQ Test (iOS) | `com.dashyhq.stacks.test` |

Leave App Store ID and Team ID empty. Copy each **Client ID** (`…apps.googleusercontent.com`).
Same project matters: the app asks Google for a token addressed to the web client, which only works
for clients in its project.

## 7. Put the values in the repo (a small PR)

> **Done** for the first setup (Team ID `47ZUZ59AHR` and both iOS clients went in with the PR that
> added this guide). Repeat this step only if a value changes.

In `stacks.config.json`:

```json
"production": { …, "native": { "appleTeamId": "A1B2C3D4E5", "iosBundleId": "com.dashyhq.stacks", "googleIosClientIds": ["<DashyHQ (iOS) client ID>"], "minShellVersion": "1.0.0" } },
"staging":    { …, "native": { "appleTeamId": "A1B2C3D4E5", "iosBundleId": "com.dashyhq.stacks.test", "googleIosClientIds": ["<DashyHQ Test (iOS) client ID>"], "minShellVersion": "1.0.0" } }
```

The first `googleIosClientIds` entry of an environment is that app's client; the platform also
accepts Google tokens issued to every client listed there. Then regenerate the app's build settings:

```bash
node scripts/ios-xcconfig.mjs
```

Commit both (`stacks.config.json` and `native/ios/Config/*.xcconfig`) in one PR; a Claude session
can do this if you give it the Team ID and the two client IDs. When it merges:

- the platform starts serving `/.well-known/apple-app-site-association` and accepting the app's
  Google tokens (staging, then production, as with every deploy);
- the `iOS` workflow's **Sign and upload to TestFlight** job archives both apps, signs them and
  uploads them. It skips (and passes) with a notice saying what's missing until steps 2–3 and 7 are
  done, and until both app records from step 5 exist.

## 8. Install

Install **TestFlight** from the App Store on your iPhone or iPad, sign in with the Apple ID you added
in step 5, and install **DashyHQ Test** first (staging). Builds appear 5–15 minutes after the upload,
once Apple has processed them; the first build of each app may ask you to confirm export compliance
(the app declares it uses no non-exempt encryption).

Check, in DashyHQ Test: sign in with Google in one tap, open two apps with no second prompt, pull to
refresh, airplane mode shows "Can't reach Stacks" with a retry, and a link to
`https://hello.test.iamdashnash.com` tapped in Messages opens in the app. Then DashyHQ. That is the
N2 gate.

## 9. Push notifications: the APNs key (once; secret)

The platform sends notifications to Apple directly, signed with an APNs key. Until the key is in
place everything works, but nothing reaches phones (the inbox still fills).

1. [Certificates, Identifiers & Profiles → Keys](https://developer.apple.com/account/resources/authkeys/list)
   → **+** → name `Stacks push` → tick **Apple Push Notifications service (APNs)** → **Configure** →
   Environment **Sandbox & Production**, Key Restriction **Team Scoped (All Topics)** → **Save** →
   **Continue** → **Register** → **Download** the `.p8` (only once) and note the **Key ID**.
2. On your Mac, with your AWS admin profile (as in `docs/SETUP.md` §7), store it for both
   environments (one key serves both apps):

```bash
for env in test prod; do
  aws ssm put-parameter --name /stacks/$env/secrets/platform/APNS_KEY --type SecureString --value "$(cat ~/Downloads/AuthKey_<Key ID>.p8)" --overwrite --profile admin --region us-east-1
  aws ssm put-parameter --name /stacks/$env/secrets/platform/APNS_KEY_ID --type SecureString --value '<Key ID>' --overwrite --profile admin --region us-east-1
done
```

The platform picks it up within five minutes; no deploy. Then delete the `.p8` from Downloads (or
keep it in your password manager). Push Notifications on the bundle IDs is turned on by the release
job itself.

Check: in DashyHQ Test, the home page offers **Turn on notifications**; allow it, then ask for access
to a private app from another account. The approver's phone shows the request; tapping it opens
the access page.

## 10. Sign in with Apple on the web (once; not secret)

In the iOS apps, Sign in with Apple works as soon as a build with it is in TestFlight (the release
job turns the capability on for both bundle IDs). Browsers need an Apple **Services ID** per
environment:

1. [Certificates, Identifiers & Profiles → Identifiers](https://developer.apple.com/account/resources/identifiers/list)
   → **+** → **Services IDs** → **Continue**, twice:

| Description | Identifier |
| --- | --- |
| DashyHQ Test (web) | `com.dashyhq.stacks.test.web` |
| DashyHQ (web) | `com.dashyhq.stacks.web` |

2. Open each one → tick **Sign in with Apple** → **Configure**:

| Services ID | Primary App ID | Domains and Subdomains | Return URLs |
| --- | --- | --- | --- |
| `com.dashyhq.stacks.test.web` | `com.dashyhq.stacks.test` | `auth.test.iamdashnash.com` | `https://auth.test.iamdashnash.com/` |
| `com.dashyhq.stacks.web` | `com.dashyhq.stacks` | `auth.iamdashnash.com` | `https://auth.iamdashnash.com/` |

   **Next** → **Done** → **Continue** → **Save**.
3. In `stacks.config.json`, set `"appleServicesId"` in each environment (a small PR; a Claude
   session can do it). The portal then shows **Continue with Apple** in browsers too.

No key or secret is involved: the portal receives Apple's identity token directly (popup) and the
platform checks it against Apple's public keys. People who choose **Hide My Email** get an
`@privaterelay.appleid.com` address; the platform never emails anyone, so nothing more is needed.

## Later

- Builds expire after 90 days in TestFlight; the workflow rebuilds every two months (the 1st of
  odd months), and on every merge that changes the app. To release without an app change (a
  workflow fix, say), run **Actions → iOS → Run workflow** on `main`.
- macOS minutes count 10x against GitHub's allowance, so macOS runs only when something that goes
  into the app changed (`native/ios/`, not Core's tests or docs). Everything else stays on Linux.
- Nothing to rotate except the API key: revoke it on step 2's page and repeat step 3 if it leaks.
  Same for the APNs key: revoke it on step 9's page, make a new one and store it again.
  Signing certificates live one release each. If a release ever fails saying the team has no room
  for another distribution certificate, revoke one you don't use in
  [Certificates, Identifiers & Profiles → Certificates](https://developer.apple.com/account/resources/certificates/list)
  and re-run it.
- Inviting other people: TestFlight → **External Testing** (needs Apple's Beta App Review once per
  version), or add them to your team in App Store Connect as internal testers.
- **Optional: a Mac as the iOS runner.** Setting the repository variable `MACOS_RUNNER` to
  `["self-hosted","macOS","ARM64","stacks-ios"]` moves the two macOS jobs to a self-hosted runner
  on that Mac; unsetting it moves them back to GitHub's `macos-26`. Setup and the on/off switch:
  [Build on a local Mac](#build-on-a-local-mac-optional). Until the variable is set, nothing changes.

## Build on a local Mac (optional)

Runs the two macOS jobs of `.github/workflows/ios.yml` on a Mac you own, to stop spending macOS
minutes (GitHub bills them at 10×). The switch is `scripts/mac-runner.sh`, installed as the command
`stacks-runner`. Each job routes through the repository variable `MACOS_RUNNER`: unset means GitHub's
`macos-26`; set means this Mac.

**Once, by hand**

1. Create a standard (not admin) macOS user `ci`. Log in as `ci` once, open Xcode and accept the
   licence and the components.
2. As `ci`, in **Settings → Actions → Runners → New self-hosted runner → macOS / ARM64**, download the
   runner into `~ci/actions-runner`, then run GitHub's `./config.sh --url https://github.com/dashnash/stacks --token <from the page> --labels stacks-ios`
   and `./svc.sh install && ./svc.sh start`.
3. Create a fine-grained token for `dashnash/stacks` only, with **Variables: read and write** and
   **Administration: read**.
4. As an admin on the Mac, run `scripts/mac-runner.sh install`. It asks for the token and then
   links `/usr/local/bin/stacks-runner`, stores the token, builds the sleep watcher and installs
   it for `ci`. Running it again updates everything in place.

**Commands**

| Command | Who | What it does |
| --- | --- | --- |
| `stacks-runner status` | anyone | Shows whether the service runs, what GitHub sees, and where `MACOS_RUNNER` points. Exit 2 if it points here but the runner is offline. |
| `stacks-runner on` | a repo admin, with their own `gh` login | Starts the service (asks for an admin password), waits up to 2 minutes for GitHub to see the runner online, then sets `MACOS_RUNNER`. |
| `stacks-runner off [--now] [--stop]` | anyone on the Mac | Unsets `MACOS_RUNNER` first, so new jobs go to GitHub at once. Then waits up to 45 minutes for a running job (`--now` skips the wait). `--stop` also stops the service, and asks first if a job is still running. |
| `stacks-runner uninstall` | an admin | Reverses `install`, and runs `off`. |

`off` uses the caller's `gh` login if GitHub accepts it, and otherwise the stored token. That is
why anyone on the Mac can switch it off: non-admin users don't need to stop `ci`'s service.

**What the sleep watcher does**

When the Mac goes to sleep or powers off, a small watcher running as `ci` runs `stacks-runner off --now`,
so GitHub stops sending iOS jobs to a Mac that can't run them. It logs to `~ci/Library/Logs/stacks-runner.log`.
It only runs if `ci` is logged in (or the LaunchAgent is loaded for `ci`).

**The token**

The fine-grained token lives in `/Library/Application Support/stacks-runner/token`, owned by root,
group `staff`, mode `0640`. Any local user can read it. That is accepted because it can only change
which runner the iOS jobs use. It never goes in the repo or an issue. Rotate it by running `install`
again.

**On a shared Mac**

- Release jobs sign with the distribution certificate in a temporary keychain. The job restores
  the user's keychain search list and deletes only what it made.
- Provisioning profiles are removed by UUID, so other profiles on the Mac are left alone.
- Xcode is found per job and set with `DEVELOPER_DIR`; the Mac's `xcode-select` is never changed.
- Swift packages are cached in `~ci/Library/Caches/stacks-ios-spm`.
