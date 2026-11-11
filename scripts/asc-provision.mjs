#!/usr/bin/env node
/**
 * Sets up the iOS apps in Apple's developer account through the App Store Connect API, so the
 * one-time setup (docs/IOS_SETUP.md) is mostly clicks-free. Safe to run again: it only creates what
 * is missing. Runs in CI (.github/workflows/ios-provision.yml) with the ios-release secrets; never
 * in a Claude session, which must not hold the key.
 *
 * For each environment's app (bundle ID from stacks.config.json):
 *   1. registers the bundle ID and turns on Associated Domains (universal links) and Push
 *      Notifications (the release job does this too, so a new capability needs no re-run);
 *   2. if the app record exists in App Store Connect (Apple offers no API to create one), makes an
 *      internal TestFlight group that gets every build automatically, and adds TESTER_EMAIL to it.
 *
 * Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 (the .p8 contents), optional TESTER_EMAIL.
 * `--check-apps` only checks that both app records exist (exit 3 if not): the release job's guard.
 *
 * Release signing (the release job): each run signs with a certificate made for that run, and the
 * next run revokes it, so no certificate or key is ever stored. (Revoking a distribution
 * certificate doesn't affect builds already processed; waiting for the next run gives Apple time
 * to process this run's.)
 * `--release-signing <request.csr> <out-dir> <profile-dir...>` revokes the previous run's
 * certificate, has Apple issue an Apple Distribution certificate for the CSR (the key stays on the
 * runner), makes fresh App Store profiles with it, and writes <out-dir>/certificate.cer,
 * <out-dir>/certificate-id, <out-dir>/profiles.json (`{ bundleId: profileName }`) and the profiles
 * into each <profile-dir>.
 * `--revoke-certificate <id>`: a run that failed before uploading revokes its own.
 * `--what-to-test <build>` (after the upload, WHAT_TO_TEST): waits for that build of each app to
 * appear in App Store Connect and sets its TestFlight "What to Test" note (the commit it was built
 * from: TestFlight's build numbers can only be numbers).
 */
import { createPrivateKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.appstoreconnect.apple.com';
export const GROUP_NAME = 'Internal (automatic)';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** An App Store Connect token: ES256-signed, valid 15 minutes (Apple allows at most 20). */
export function ascToken({ keyId, issuerId, privateKeyPem, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: issuerId, iat, exp: iat + 900, aud: 'appstoreconnect-v1' }));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: createPrivateKey(privateKeyPem), dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(signature)}`;
}

/** `api(method, path, body?)` against the App Store Connect API; throws with Apple's error details. */
export function createApi({ keyId, issuerId, privateKeyPem, fetchImpl = fetch }) {
  let token = null;
  let tokenAt = 0;
  return async (method, path, body) => {
    if (!token || Date.now() - tokenAt > 10 * 60_000) {
      token = ascToken({ keyId, issuerId, privateKeyPem });
      tokenAt = Date.now();
    }
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = (json.errors ?? []).map((e) => `${e.title}: ${e.detail}`).join('; ') || text;
      throw new Error(`${method} ${path} → ${res.status} ${detail}`);
    }
    return json;
  };
}

/** The apps to set up, from stacks.config.json. */
export function appsFromConfig(config) {
  return Object.entries(config.environments)
    .filter(([, env]) => env.native?.iosBundleId)
    .map(([name, env]) => ({ env: name, bundleId: env.native.iosBundleId, name: name === 'production' ? 'DashyHQ' : 'DashyHQ Test' }));
}

const q = (s) => encodeURIComponent(s);

/** What the app's entitlements use; profiles made afterwards include them. */
export const CAPABILITIES = [
  ['ASSOCIATED_DOMAINS', 'Associated Domains'],
  ['PUSH_NOTIFICATIONS', 'Push Notifications'],
];

async function ensureBundleId(api, app, log) {
  const found = (await api('GET', `/v1/bundleIds?filter[identifier]=${q(app.bundleId)}&limit=200`)).data ?? [];
  let bundle = found.find((b) => b.attributes?.identifier === app.bundleId);
  if (bundle) log(`= bundle ID ${app.bundleId} is registered`);
  else {
    bundle = (await api('POST', '/v1/bundleIds', { data: { type: 'bundleIds', attributes: { identifier: app.bundleId, name: app.name, platform: 'IOS' } } })).data;
    log(`+ registered bundle ID ${app.bundleId}`);
  }
  const caps = (await api('GET', `/v1/bundleIds/${bundle.id}/bundleIdCapabilities`)).data ?? [];
  for (const [type, label] of CAPABILITIES) {
    if (caps.some((c) => c.attributes?.capabilityType === type)) log(`= ${label} is on for ${app.bundleId}`);
    else {
      await api('POST', '/v1/bundleIdCapabilities', {
        data: { type: 'bundleIdCapabilities', attributes: { capabilityType: type }, relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } } } },
      });
      log(`+ turned on ${label} for ${app.bundleId}`);
    }
  }
  return bundle;
}

async function ensureTestFlight(api, app, testerEmail, log) {
  const record = ((await api('GET', `/v1/apps?filter[bundleId]=${q(app.bundleId)}`)).data ?? []).find((a) => a.attributes?.bundleId === app.bundleId);
  if (!record) {
    log(`! no App Store Connect app for ${app.bundleId} yet: create "${app.name}" (docs/IOS_SETUP.md step 3), then run this again`);
    return { appMissing: true };
  }
  const groups = (await api('GET', `/v1/apps/${record.id}/betaGroups?limit=200`)).data ?? [];
  let group = groups.find((g) => g.attributes?.isInternalGroup && g.attributes?.hasAccessToAllBuilds);
  if (group) log(`= ${app.name} has internal TestFlight group "${group.attributes.name}" (every build, automatically)`);
  else {
    group = (
      await api('POST', '/v1/betaGroups', {
        data: { type: 'betaGroups', attributes: { name: GROUP_NAME, isInternalGroup: true, hasAccessToAllBuilds: true }, relationships: { app: { data: { type: 'apps', id: record.id } } } },
      })
    ).data;
    log(`+ created internal TestFlight group "${GROUP_NAME}" for ${app.name}`);
  }
  if (!testerEmail) return { appMissing: false };
  const testers = (await api('GET', `/v1/betaTesters?filter[email]=${q(testerEmail)}&limit=200`)).data ?? [];
  const tester = testers.find((t) => t.attributes?.email?.toLowerCase() === testerEmail.toLowerCase());
  const invite = () =>
    api('POST', '/v1/betaTesters', {
      data: { type: 'betaTesters', attributes: { email: testerEmail }, relationships: { betaGroups: { data: [{ type: 'betaGroups', id: group.id }] } } },
    });
  try {
    if (!tester) {
      // Internal testers must be members of the App Store Connect team (the account holder is).
      await invite();
      log(`+ invited ${testerEmail} to ${app.name}'s TestFlight group`);
    } else if (((await api('GET', `/v1/betaGroups/${group.id}/betaTesters?limit=200`)).data ?? []).some((t) => t.id === tester.id)) {
      log(`= ${testerEmail} is a tester of ${app.name}`);
    } else {
      try {
        await api('POST', `/v1/betaGroups/${group.id}/relationships/betaTesters`, { data: [{ type: 'betaTesters', id: tester.id }] });
      } catch (err) {
        // Apple refuses to assign an existing tester to some internal groups ("409 Tester(s) cannot
        // be assigned"); inviting them to the group by email works where that doesn't.
        if (!/→ 409\b/.test(String(err?.message))) throw err;
        await invite();
      }
      log(`+ added ${testerEmail} to ${app.name}'s TestFlight group`);
    }
  } catch (err) {
    // The tester is a convenience: never let it fail the run (bundle IDs and groups are what matter).
    log(`! couldn't add ${testerEmail} to ${app.name}'s TestFlight group (${err?.message ?? err}); add yourself in App Store Connect → ${app.name} → TestFlight → "${group.attributes?.name ?? GROUP_NAME}"`);
    return { appMissing: false, testerProblem: true };
  }
  return { appMissing: false };
}

/** The apps whose App Store Connect record doesn't exist yet (uploads need it). */
export async function missingApps(api, apps) {
  const missing = [];
  for (const app of apps) {
    const found = ((await api('GET', `/v1/apps?filter[bundleId]=${q(app.bundleId)}`)).data ?? []).some((a) => a.attributes?.bundleId === app.bundleId);
    if (!found) missing.push(app);
  }
  return missing;
}

export const profileName = (app) => `${app.name} CI App Store`;

/**
 * Fresh App Store profiles for each app, signed by `certificateId`: the previous CI profile is
 * deleted first, so a capability added since (push, Sign in with Apple) is always included.
 * Returns `[{ bundleId, name, uuid, content }]` (content: the .mobileprovision, base64).
 */
export async function freshProfiles(api, apps, certificateId, log = () => {}) {
  const out = [];
  for (const app of apps) {
    const name = profileName(app);
    const bundle = ((await api('GET', `/v1/bundleIds?filter[identifier]=${q(app.bundleId)}&limit=200`)).data ?? []).find((b) => b.attributes?.identifier === app.bundleId);
    if (!bundle) throw new Error(`Bundle ID ${app.bundleId} isn't registered: run the iOS provision workflow (docs/IOS_SETUP.md step 4)`);
    for (const old of (await api('GET', `/v1/profiles?filter[name]=${q(name)}&limit=200`)).data ?? []) {
      if (old.attributes?.name === name) await api('DELETE', `/v1/profiles/${old.id}`);
    }
    const created = (
      await api('POST', '/v1/profiles', {
        data: {
          type: 'profiles',
          attributes: { name, profileType: 'IOS_APP_STORE' },
          relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } }, certificates: { data: [{ type: 'certificates', id: certificateId }] } },
        },
      })
    ).data;
    log(`+ App Store profile "${name}" for ${app.bundleId}`);
    out.push({ bundleId: app.bundleId, name, uuid: created.attributes.uuid, content: created.attributes.profileContent });
  }
  return out;
}

/**
 * Certificates the CI profiles were made with: earlier runs' (normally just the last one). Only CI
 * makes these profiles, so a certificate you made yourself (Xcode) is never touched.
 */
export async function leftoverCertificates(api, apps) {
  const ids = new Set();
  for (const app of apps) {
    const name = profileName(app);
    for (const prof of (await api('GET', `/v1/profiles?filter[name]=${q(name)}&limit=200`)).data ?? []) {
      if (prof.attributes?.name !== name) continue;
      for (const c of (await api('GET', `/v1/profiles/${prof.id}/certificates?limit=200`)).data ?? []) ids.add(c.id);
    }
  }
  return [...ids];
}

/** Revoke a certificate; one already gone (revoked, expired) is fine. */
export async function revokeCertificate(api, id) {
  try {
    await api('DELETE', `/v1/certificates/${id}`);
    return true;
  } catch (err) {
    if (/ → 404 /.test(err.message)) return false;
    throw err;
  }
}

/** Apple issues an Apple Distribution certificate for the signing request. */
export async function createDistributionCertificate(api, csrPem) {
  try {
    return (await api('POST', '/v1/certificates', { data: { type: 'certificates', attributes: { certificateType: 'DISTRIBUTION', csrContent: csrPem } } })).data;
  } catch (err) {
    throw new Error(
      `${err.message}\nIf the team has reached its limit of distribution certificates, revoke one you don't use at https://developer.apple.com/account/resources/certificates/list and re-run.`,
    );
  }
}

/** Everything a release run signs with: earlier runs' certificates revoked, a new one, fresh profiles. */
export async function releaseSigning(api, apps, csrPem, { log = () => {}, onCertificate = () => {} } = {}) {
  // A capability the app started using since provisioning (push) is turned on before profiles are made.
  for (const app of apps) await ensureBundleId(api, app, log);
  for (const id of await leftoverCertificates(api, apps)) {
    if (await revokeCertificate(api, id)) log(`- revoked certificate ${id}, from an earlier run`);
  }
  const certificate = await createDistributionCertificate(api, csrPem);
  log(`+ Apple Distribution certificate ${certificate.id} for this run (expires ${certificate.attributes?.expirationDate})`);
  onCertificate(certificate); // before anything else can fail, so the run's cleanup can revoke it
  const profiles = await freshProfiles(api, apps, certificate.id, log);
  return { certificate, profiles };
}

/** The build with this build number (CFBundleVersion) of an app, once App Store Connect lists it. */
export async function findBuild(api, app, version) {
  const record = ((await api('GET', `/v1/apps?filter[bundleId]=${q(app.bundleId)}`)).data ?? []).find((a) => a.attributes?.bundleId === app.bundleId);
  if (!record) return null;
  return ((await api('GET', `/v1/builds?filter[app]=${record.id}&filter[version]=${q(String(version))}&limit=1`)).data ?? [])[0] ?? null;
}

/** The build's TestFlight "What to Test" note (en-US), created or replaced. Apple allows 4000 characters. */
export async function setWhatToTest(api, buildId, text, locale = 'en-US') {
  const whatsNew = text.slice(0, 4000);
  const existing = ((await api('GET', `/v1/builds/${buildId}/betaBuildLocalizations`)).data ?? []).find((l) => l.attributes?.locale === locale);
  if (existing) {
    await api('PATCH', `/v1/betaBuildLocalizations/${existing.id}`, { data: { type: 'betaBuildLocalizations', id: existing.id, attributes: { whatsNew } } });
  } else {
    await api('POST', '/v1/betaBuildLocalizations', {
      data: { type: 'betaBuildLocalizations', attributes: { locale, whatsNew }, relationships: { build: { data: { type: 'builds', id: buildId } } } },
    });
  }
}

/** Wait (polling) for each app's build to appear, then note it; apps whose build never appears are returned. */
export async function noteBuilds(api, apps, version, text, { tries = 40, waitMs = 30_000, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const missing = [];
  for (const app of apps) {
    let build = null;
    for (let i = 0; i < tries && !(build = await findBuild(api, app, version)); i++) await sleep(waitMs);
    if (!build) {
      log(`! build ${version} of ${app.name} didn't appear in App Store Connect`);
      missing.push(app);
      continue;
    }
    await setWhatToTest(api, build.id, text);
    log(`+ "What to Test" for ${app.name} build ${version}`);
  }
  return missing;
}

/** Set up every app; returns whether any app record still needs creating by hand. */
export async function provision({ api, apps, testerEmail, log = console.log }) {
  let appsMissing = 0;
  for (const app of apps) {
    log(`${app.name} (${app.env}, ${app.bundleId})`);
    await ensureBundleId(api, app, log);
    if ((await ensureTestFlight(api, app, testerEmail, log)).appMissing) appsMissing++;
  }
  return { appsMissing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const need = (name) => process.env[name] || (console.error(`${name} is not set (docs/IOS_SETUP.md, step 5)`), process.exit(2));
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(readFileSync(join(root, 'stacks.config.json'), 'utf8'));
  const api = createApi({ keyId: need('ASC_KEY_ID'), issuerId: need('ASC_ISSUER_ID'), privateKeyPem: need('ASC_KEY_P8') });
  // `--check-apps` (the release job, before uploading): exit 3 if an app record is missing.
  if (process.argv.includes('--check-apps')) {
    const missing = await missingApps(api, appsFromConfig(config));
    for (const app of missing) console.log(`${app.name} (${app.bundleId}) has no App Store Connect app yet (docs/IOS_SETUP.md steps 4-5)`);
    process.exit(missing.length ? 3 : 0);
  }
  const args = (flag) => {
    const at = process.argv.indexOf(flag);
    return at < 0 ? null : process.argv.slice(at + 1).filter((a) => !a.startsWith('--'));
  };
  const signing = args('--release-signing');
  if (signing) {
    const [csr, out, ...profileDirs] = signing;
    if (!csr || !out || !profileDirs.length) (console.error('usage: --release-signing <request.csr> <out-dir> <profile-dir...>'), process.exit(2));
    mkdirSync(out, { recursive: true });
    const { profiles } = await releaseSigning(api, appsFromConfig(config), readFileSync(csr, 'utf8'), {
      log: console.log,
      onCertificate: (c) => {
        writeFileSync(join(out, 'certificate-id'), c.id);
        writeFileSync(join(out, 'certificate.cer'), Buffer.from(c.attributes.certificateContent, 'base64'));
      },
    });
    writeFileSync(join(out, 'profiles.json'), JSON.stringify(Object.fromEntries(profiles.map((p) => [p.bundleId, p.name]))));
    for (const dir of profileDirs) {
      mkdirSync(dir, { recursive: true });
      for (const p of profiles) writeFileSync(join(dir, `${p.uuid}.mobileprovision`), Buffer.from(p.content, 'base64'));
    }
    process.exit(0);
  }
  const notes = args('--what-to-test');
  if (notes) {
    if (!notes[0]) (console.error('usage: --what-to-test <build>'), process.exit(2));
    const missing = await noteBuilds(api, appsFromConfig(config), notes[0], need('WHAT_TO_TEST'), { log: console.log });
    process.exit(missing.length ? 1 : 0);
  }
  const revoke = args('--revoke-certificate');
  if (revoke) {
    if (!revoke[0]) (console.error('usage: --revoke-certificate <id>'), process.exit(2));
    console.log((await revokeCertificate(api, revoke[0])) ? `- revoked certificate ${revoke[0]}` : `= certificate ${revoke[0]} was already gone`);
    process.exit(0);
  }
  const testerEmail = (process.env.TESTER_EMAIL ?? '').trim() || undefined;
  const { appsMissing } = await provision({ api, apps: appsFromConfig(config), testerEmail });
  if (appsMissing) console.log(`\n${appsMissing} app record(s) still to create in App Store Connect; run this again afterwards.`);
}
