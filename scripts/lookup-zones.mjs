#!/usr/bin/env node
/**
 * Resolves the Route 53 zones that stacks.config.json marks `hostedZoneId: "lookup"` and prints
 * them as the synth context `<name>=<id>,<name>=<id>` (empty if none). The deploy workflows run it
 * with AWS credentials in the environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 * AWS_SESSION_TOKEN) and pass the result as `cdk synth -c hostedZoneIds=…`. Each name must match
 * exactly one public zone, or it fails loudly.
 *
 * It needs nothing but Node: no AWS CLI or SDK on the runner. It signs its one Route 53 call
 * (ListHostedZonesByName) with SigV4 itself.
 *
 *   node scripts/lookup-zones.mjs
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Zone names to look up (same rule as `zonesToLookUp` in @stacks/infra). */
export function zoneNames(config) {
  const names = new Set();
  for (const env of Object.values(config.environments)) {
    for (const z of [env, ...(env.legacyRedirects ?? [])]) if (z.hostedZoneId === 'lookup') names.add(z.hostedZoneName ?? z.rootDomain);
  }
  return [...names].sort();
}

/** The zone ID for `name` from a ListHostedZonesByName answer: exactly one public, exact match. */
export function pickZone(name, response) {
  const matches = (response.HostedZones ?? []).filter((z) => z.Name === `${name}.` && !z.Config?.PrivateZone);
  if (matches.length !== 1) throw new Error(`Route 53: expected exactly one public hosted zone named ${name}, found ${matches.length}`);
  const id = matches[0].Id.replace(/^\/hostedzone\//, '');
  if (!/^Z[A-Z0-9]{1,31}$/.test(id)) throw new Error(`Route 53: unexpected zone ID "${id}" for ${name}`);
  return id;
}

/** The hosted zones in a ListHostedZonesByName XML answer, shaped like the SDK's. */
export function parseHostedZones(xml) {
  const tag = (block, name) => block.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
  return {
    HostedZones: [...xml.matchAll(/<HostedZone>([\s\S]*?)<\/HostedZone>/g)].map(([, z]) => ({
      Id: tag(z, 'Id') ?? '',
      Name: tag(z, 'Name') ?? '',
      Config: { PrivateZone: tag(z, 'PrivateZone') === 'true' },
    })),
  };
}

const sha256 = (data) => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();
/** RFC 3986 encoding, as SigV4 wants it. */
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Signs a request without a body with AWS Signature Version 4 and returns the headers to send
 * (`authorization`, `x-amz-date`, and `x-amz-security-token` with a session token).
 */
export function signV4({ method = 'GET', host, path = '/', query = {}, headers = {}, region, service, credentials, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])), host, 'x-amz-date': amzDate };
  if (credentials.sessionToken) all['x-amz-security-token'] = credentials.sessionToken;
  const names = Object.keys(all).sort();
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encode(k)}=${encode(String(query[k]))}`)
    .join('&');
  const canonicalHeaders = names.map((n) => `${n}:${all[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, sha256('')].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  const { host: _host, ...sent } = all;
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/** ListHostedZonesByName for one name (Route 53 is global; it signs for us-east-1). */
export async function listHostedZonesByName(name, credentials, fetchImpl = fetch) {
  const host = 'route53.amazonaws.com';
  const path = '/2013-04-01/hostedzonesbyname';
  const query = { dnsname: name, maxitems: '10' };
  const headers = signV4({ host, path, query, region: 'us-east-1', service: 'route53', credentials });
  const res = await fetchImpl(`https://${host}${path}?${new URLSearchParams(query)}`, { headers });
  const body = await res.text();
  if (!res.ok) throw new Error(`Route 53 ListHostedZonesByName ${name}: HTTP ${res.status} ${body.slice(0, 300)}`);
  return parseHostedZones(body);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(join(root, 'stacks.config.json'), 'utf8'));
  const names = zoneNames(config);
  const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN };
  if (names.length && (!credentials.accessKeyId || !credentials.secretAccessKey)) {
    console.error('lookup-zones: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set');
    process.exit(1);
  }
  const pairs = [];
  for (const name of names) {
    const id = pickZone(name, await listHostedZonesByName(name, credentials));
    console.error(`${name} → ${id}`);
    pairs.push(`${name}=${id}`);
  }
  console.log(pairs.join(','));
}
