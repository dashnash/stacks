# iOS app: one-time setup

Gets DashyHQ (production) and DashyHQ Test (staging) from GitHub Actions onto your iPhone through
TestFlight. Background: `docs/NATIVE_APP_SPEC.md`. You do these steps once, in a browser (and
Xcode for step 7); after that, every merge to `main` that touches the app uploads new builds.

Nothing here is pasted into a Claude session except the values marked **not secret**. The App Store
Connect key goes straight into GitHub.

| What | Where it ends up | Secret? |
| --- | --- | --- |
| Apple Team ID | `stacks.config.json` → `native.appleTeamId` (both environments) | No |
| Two App IDs and two App Store Connect apps | Apple | No |
| App Store Connect API key (`.p8`, Key ID, Issuer ID) | GitHub environment `ios-release` secrets | **Yes** |
| Two iOS OAuth clients | `stacks.config.json` → `native.googleIosClientIds` | No |

## 1. Your Team ID (not secret)

[developer.apple.com/account](https://developer.apple.com/account) → **Membership details** → **Team ID**
(10 characters, e.g. `A1B2C3D4E5`).

## 2. Register the two App IDs

[Certificates, Identifiers & Profiles → Identifiers](https://developer.apple.com/account/resources/identifiers/list)
→ **+** → **App IDs** → **App**. Do this twice:

| Description | Bundle ID (Explicit) |
| --- | --- |
| DashyHQ | `com.dashyhq.stacks` |
| DashyHQ Test | `com.dashyhq.stacks.test` |

Capabilities: tick **Associated Domains** (universal links). Push Notifications and Sign in with Apple
come in later phases; you can tick them now or then.

## 3. Create the two apps in App Store Connect

[App Store Connect → Apps](https://appstoreconnect.apple.com/apps) → **+** → **New App**, twice:

| Name | Primary language | Bundle ID | SKU |
| --- | --- | --- | --- |
| DashyHQ | English (U.S.) | `com.dashyhq.stacks` | `dashyhq` |
| DashyHQ Test | English (U.S.) | `com.dashyhq.stacks.test` | `dashyhq-test` |

Platform iOS; User Access **Full Access**. (The App Store name must be unique worldwide; if "DashyHQ"
is taken, pick another name here. The name on the home screen comes from the build, not from this.)

Then, in each app: **TestFlight** → **Internal Testing** → **+** → a group (e.g. "Dash"), add
yourself, and turn on **Automatic Distribution** so every new build reaches you without clicking.

## 4. An App Store Connect API key for GitHub Actions (secret)

[App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
→ **Team Keys** → **Generate API Key**:

- Name: `GitHub Actions (stacks)`
- Access: **Admin**. CI uses Xcode's cloud-managed signing, which creates and renews the signing
  certificates itself; that needs Admin (or App Manager with *Access to Cloud Managed Distribution
  Certificate*).

Note the **Issuer ID** (top of the page) and the **Key ID**, and **Download** the `.p8` file. Apple
lets you download it only once; keep it somewhere safe or revoke and make a new one if lost.

## 5. Put the key in GitHub (secret)

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
  uploads them. Until steps 4–5 and 7 are done it says "TestFlight upload skipped: not set up yet"
  and passes.

## 8. Install

Install **TestFlight** from the App Store on your iPhone or iPad, sign in with the Apple ID you added
in step 3, and install **DashyHQ Test** first (staging). Builds appear 5–15 minutes after the upload,
once Apple has processed them; the first build of each app may ask you to confirm export compliance
(the app declares it uses no non-exempt encryption).

Check, in DashyHQ Test: sign in with Google in one tap, open two apps with no second prompt, pull to
refresh, airplane mode shows "Can't reach Stacks" with a retry, and a link to
`https://hello.test.iamdashnash.com` tapped in Messages opens in the app. Then DashyHQ. That is the
N2 gate.

## Later

- Builds expire after 90 days in TestFlight; the workflow rebuilds on the 1st of every month.
- Signing certificates are cloud-managed and renewed by Xcode: nothing to rotate except the API key
  (revoke it in step 4's page and repeat step 5 if it leaks).
- Inviting other people: TestFlight → **External Testing** (needs Apple's Beta App Review once per
  version), or add them to your team in App Store Connect as internal testers.
