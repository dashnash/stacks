#!/usr/bin/env node
/**
 * Makes the Apple Distribution certificate the iOS release signs with, once a year (it expires
 * after one). Run it on your own machine, never in CI or a Claude session: it needs the App
 * Store Connect key (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 = the .p8 contents) and `openssl`.
 *
 *   ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8="$(cat AuthKey_….p8)" node scripts/ios-signing-cert.mjs
 *
 * The private key is made here and never sent anywhere; Apple only sees a signing request. It
 * writes, into a new folder `ios-signing-<date>/` (readable only by you):
 *   - dashyhq-distribution.p12      the certificate and key, password-protected
 *   - dashyhq-distribution.p12.b64  the same, base64: the DIST_CERT_P12 secret
 *   - password.txt                  the DIST_CERT_PASSWORD secret
 * Put the two secrets in the `ios-release` GitHub environment (docs/IOS_SETUP.md), keep the .p12
 * somewhere safe (or delete it: you can always make a new certificate), and delete the folder.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './asc-provision.mjs';

/** The App Store Connect request that turns a signing request into a distribution certificate. */
export const certificateRequest = (csrPem) => ({ data: { type: 'certificates', attributes: { certificateType: 'DISTRIBUTION', csrContent: csrPem } } });

/**
 * `openssl pkcs12 -export` arguments. OpenSSL 3 encrypts .p12 files with algorithms macOS's
 * `security import` can't always read, so it is asked for the legacy ones; LibreSSL (macOS's own
 * openssl) uses those already.
 */
export function pkcs12Args(opensslVersion, { key, cert, out, passFile }) {
  const legacy = /^OpenSSL 3/.test(opensslVersion) ? ['-legacy'] : [];
  return ['pkcs12', '-export', ...legacy, '-inkey', key, '-in', cert, '-name', 'Apple Distribution (DashyHQ CI)', '-out', out, '-passout', `file:${passFile}`];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const need = (name) => process.env[name] || (console.error(`${name} is not set (see the top of this file)`), process.exit(2));
  const api = createApi({ keyId: need('ASC_KEY_ID'), issuerId: need('ASC_ISSUER_ID'), privateKeyPem: need('ASC_KEY_P8') });
  const openssl = (args) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
  const version = openssl(['version']).trim();

  const dir = `ios-signing-${new Date().toISOString().slice(0, 10)}`;
  mkdirSync(dir, { mode: 0o700 });
  const f = (name) => join(dir, name);
  const password = randomBytes(18).toString('base64url');
  writeFileSync(f('password.txt'), password, { mode: 0o600 });

  // 1. A private key and a signing request, made here.
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('key.pem'), '-out', f('request.csr'), '-subj', '/CN=DashyHQ CI/O=DashyHQ']);
  chmodSync(f('key.pem'), 0o600);

  // 2. Apple signs it.
  const res = await api('POST', '/v1/certificates', certificateRequest(readFileSync(f('request.csr'), 'utf8')));
  const attrs = res.data.attributes;
  writeFileSync(f('certificate.cer'), Buffer.from(attrs.certificateContent, 'base64'));
  openssl(['x509', '-inform', 'DER', '-in', f('certificate.cer'), '-out', f('certificate.pem')]);

  // 3. Key + certificate in one password-protected .p12, and its base64 for the GitHub secret.
  openssl(pkcs12Args(version, { key: f('key.pem'), cert: f('certificate.pem'), out: f('dashyhq-distribution.p12'), passFile: f('password.txt') }));
  writeFileSync(f('dashyhq-distribution.p12.b64'), readFileSync(f('dashyhq-distribution.p12')).toString('base64'), { mode: 0o600 });

  console.log(`Apple Distribution certificate "${attrs.name ?? attrs.displayName ?? 'DashyHQ CI'}", serial ${attrs.serialNumber}, expires ${attrs.expirationDate}.`);
  console.log(`\nIn ${dir}/:`);
  console.log(`  DIST_CERT_P12      = the contents of dashyhq-distribution.p12.b64`);
  console.log(`  DIST_CERT_PASSWORD = the contents of password.txt`);
  console.log(`\nAdd both to the ios-release GitHub environment, then delete the folder (key.pem is the private key).`);
}
