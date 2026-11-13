#!/usr/bin/env node
/**
 * Resolves the Route 53 zones that stacks.config.json marks `hostedZoneId: "lookup"` and prints
 * them as the synth context `<name>=<id>,<name>=<id>` (empty if none). The deploy workflows run it
 * with AWS credentials and pass the result as `cdk synth -c hostedZoneIds=…`. Each name must match
 * exactly one public zone, or it fails loudly.
 *
 *   node scripts/lookup-zones.mjs            (needs the aws CLI and credentials)
 */
import { execFileSync } from 'node:child_process';
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

/** The zone ID for `name` from a `list-hosted-zones-by-name` response: exactly one public, exact match. */
export function pickZone(name, response) {
  const matches = (response.HostedZones ?? []).filter((z) => z.Name === `${name}.` && !z.Config?.PrivateZone);
  if (matches.length !== 1) throw new Error(`Route 53: expected exactly one public hosted zone named ${name}, found ${matches.length}`);
  const id = matches[0].Id.replace(/^\/hostedzone\//, '');
  if (!/^Z[A-Z0-9]{1,31}$/.test(id)) throw new Error(`Route 53: unexpected zone ID "${id}" for ${name}`);
  return id;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(join(root, 'stacks.config.json'), 'utf8'));
  const pairs = zoneNames(config).map((name) => {
    const out = execFileSync('aws', ['route53', 'list-hosted-zones-by-name', '--dns-name', name, '--max-items', '10', '--output', 'json'], { encoding: 'utf8' });
    const id = pickZone(name, JSON.parse(out));
    console.error(`${name} → ${id}`);
    return `${name}=${id}`;
  });
  console.log(pairs.join(','));
}
