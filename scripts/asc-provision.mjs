#!/usr/bin/env node
/**
 * Sets up the iOS apps in Apple's developer account through the App Store Connect API, so the
 * one-time setup (docs/IOS_SETUP.md) is mostly clicks-free. Safe to run again: it only creates what
 * is missing. Runs in CI (.github/workflows/ios-provision.yml) with the ios-release secrets; never
 * in a Claude session, which must not hold the key.
 *
 * For each environment's app (bundle ID from stacks.config.json):
 *   1. registers the bundle ID and turns on Associated Domains (universal links);
 *   2. if the app record exists in App Store Connect (Apple offers no API to create one), makes an
 *      internal TestFlight group that gets every build automatically, and adds TESTER_EMAIL to it.
 *
 * Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 (the .p8 contents), optional TESTER_EMAIL.
 * `--check-apps` only checks that both app records exist (exit 3 if not): the release job's guard.
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

async function ensureBundleId(api, app, log) {
  const found = (await api('GET', `/v1/bundleIds?filter[identifier]=${q(app.bundleId)}&limit=200`)).data ?? [];
  let bundle = found.find((b) => b.attributes?.identifier === app.bundleId);
  if (bundle) log(`= bundle ID ${app.bundleId} is registered`);
  else {
    bundle = (await api('POST', '/v1/bundleIds', { data: { type: 'bundleIds', attributes: { identifier: app.bundleId, name: app.name, platform: 'IOS' } } })).data;
    log(`+ registered bundle ID ${app.bundleId}`);
  }
  const caps = (await api('GET', `/v1/bundleIds/${bundle.id}/bundleIdCapabilities`)).data ?? [];
  if (caps.some((c) => c.attributes?.capabilityType === 'ASSOCIATED_DOMAINS')) log(`= Associated Domains is on for ${app.bundleId}`);
  else {
    await api('POST', '/v1/bundleIdCapabilities', {
      data: { type: 'bundleIdCapabilities', attributes: { capabilityType: 'ASSOCIATED_DOMAINS' }, relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } } } },
    });
    log(`+ turned on Associated Domains for ${app.bundleId}`);
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
  if (tester) {
    const inGroup = ((await api('GET', `/v1/betaGroups/${group.id}/betaTesters?limit=200`)).data ?? []).some((t) => t.id === tester.id);
    if (inGroup) log(`= ${testerEmail} is a tester of ${app.name}`);
    else {
      await api('POST', `/v1/betaGroups/${group.id}/relationships/betaTesters`, { data: [{ type: 'betaTesters', id: tester.id }] });
      log(`+ added ${testerEmail} to ${app.name}'s TestFlight group`);
    }
  } else {
    // Internal testers must be members of the App Store Connect team (the account holder is).
    await api('POST', '/v1/betaTesters', {
      data: { type: 'betaTesters', attributes: { email: testerEmail }, relationships: { betaGroups: { data: [{ type: 'betaGroups', id: group.id }] } } },
    });
    log(`+ invited ${testerEmail} to ${app.name}'s TestFlight group`);
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
  const testerEmail = (process.env.TESTER_EMAIL ?? '').trim() || undefined;
  const { appsMissing } = await provision({ api, apps: appsFromConfig(config), testerEmail });
  if (appsMissing) console.log(`\n${appsMissing} app record(s) still to create in App Store Connect; run this again afterwards.`);
}
