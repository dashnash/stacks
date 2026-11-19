#!/usr/bin/env node
/**
 * Compares the live staging guardrail policies (`stacks-test-boundary`, `stacks-test-cfn-exec`)
 * with the ones in a synthesized `stacks-ci` template (#101). `stacks-ci` is deployed by hand, so a
 * merged guardrail change only protects anything once someone deploys it; this says when that
 * hasn't happened.
 *
 *   node scripts/check-ci-drift.mjs <stacks-ci.template.json> --account <id> [--warn]
 *
 * It reads the default version of each policy with the `stacks-ci-drift-check` role's credentials
 * from the environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN). Node only: it
 * signs its IAM calls itself (`signV4` from lookup-zones.mjs), no AWS CLI or SDK. Exit 1 on any
 * difference; with --warn, differences become ::warning annotations and it exits 0. Both modes write
 * a Markdown table to $GITHUB_STEP_SUMMARY when it is set.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signV4 } from './lookup-zones.mjs';

export const POLICY_NAMES = ['stacks-test-boundary', 'stacks-test-cfn-exec'];

/**
 * Resolves the intrinsics CDK writes into the policies: Fn::Join and Ref to the pseudo-parameters.
 * Anything else throws, so a change in how CDK writes the template fails loudly instead of
 * comparing something half-resolved.
 */
export function resolveIntrinsics(value, account) {
  const pseudo = { 'AWS::Partition': 'aws', 'AWS::AccountId': account, 'AWS::Region': 'us-east-1', 'AWS::URLSuffix': 'amazonaws.com' };
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const keys = Object.keys(v);
    if (keys.length === 1 && (keys[0] === 'Ref' || keys[0].startsWith('Fn::'))) {
      const [k] = keys;
      if (k === 'Ref' && v.Ref in pseudo) return pseudo[v.Ref];
      if (k === 'Fn::Join') {
        const [sep, parts] = v['Fn::Join'];
        return parts.map(walk).join(sep);
      }
      throw new Error(`check-ci-drift: can't resolve ${k} ${JSON.stringify(v[k])} in the template`);
    }
    return Object.fromEntries(keys.map((key) => [key, walk(v[key])]));
  };
  return walk(value);
}

const asList = (v) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).map(String).sort());

/** One statement in a comparable shape: lists sorted, strings where IAM may keep a single value. */
function normalizeStatement(s) {
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (['Action', 'NotAction', 'Resource', 'NotResource'].includes(k)) out[k] = asList(v);
    else if (k === 'Condition') {
      out[k] = Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((op) => [op, Object.fromEntries(Object.keys(v[op]).sort().map((key) => [key, asList(v[op][key])]))]),
      );
    } else out[k] = v;
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/** A policy document as a list of normalized statements, sorted by Sid, then by their JSON. */
export function normalizePolicy(doc) {
  const statements = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
  return statements
    .map(normalizeStatement)
    .sort((a, b) => String(a.Sid ?? '').localeCompare(String(b.Sid ?? '')) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Differences between two documents: `{ onlyRepo, onlyLive, changed: [{ sid, repo, live }] }`, all empty when equal. */
export function diffPolicies(repoDoc, liveDoc) {
  const repo = normalizePolicy(repoDoc);
  const live = normalizePolicy(liveDoc);
  const key = (s) => s.Sid ?? JSON.stringify(s);
  const liveBy = new Map(live.map((s) => [key(s), s]));
  const repoBy = new Map(repo.map((s) => [key(s), s]));
  const changed = [];
  const onlyRepo = [];
  for (const s of repo) {
    const other = liveBy.get(key(s));
    if (!other) onlyRepo.push(s);
    else if (JSON.stringify(other) !== JSON.stringify(s)) changed.push({ sid: key(s), repo: s, live: other });
  }
  const onlyLive = live.filter((s) => !repoBy.has(key(s)));
  // Everything but the statements (Version, Id): a difference there is drift too.
  const rest = (doc) => JSON.stringify(Object.fromEntries(Object.keys(doc).filter((k) => k !== 'Statement').sort().map((k) => [k, doc[k]])));
  if (rest(repoDoc) !== rest(liveDoc)) changed.push({ sid: '(document)', repo: JSON.parse(rest(repoDoc)), live: JSON.parse(rest(liveDoc)) });
  return { onlyRepo, onlyLive, changed };
}

export const inSync = (d) => !d.onlyRepo.length && !d.onlyLive.length && !d.changed.length;

/** `{ <policy name>: <resolved document> }` for the guardrail policies in a stacks-ci template. */
export function expectedPolicies(template, account) {
  const out = {};
  for (const r of Object.values(template.Resources ?? {})) {
    if (r.Type !== 'AWS::IAM::ManagedPolicy' || !POLICY_NAMES.includes(r.Properties?.ManagedPolicyName)) continue;
    out[r.Properties.ManagedPolicyName] = resolveIntrinsics(r.Properties.PolicyDocument, account);
  }
  for (const name of POLICY_NAMES) if (!out[name]) throw new Error(`check-ci-drift: the template has no managed policy ${name}`);
  return out;
}

const xmlField = (xml, tag) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];

/** One signed IAM Query API call (IAM is global; it signs for us-east-1). */
async function iamCall(action, params, credentials, fetchImpl) {
  const host = 'iam.amazonaws.com';
  const query = { Action: action, Version: '2010-05-08', ...params };
  const headers = signV4({ host, path: '/', query, region: 'us-east-1', service: 'iam', credentials });
  const res = await fetchImpl(`https://${host}/?${new URLSearchParams(query)}`, { headers });
  const body = await res.text();
  if (!res.ok) throw new Error(`IAM ${action} ${params.PolicyArn}: HTTP ${res.status} ${body.slice(0, 300)}`);
  return body;
}

/** The parsed default version of a live policy, from a GetPolicyVersion answer. */
export function parsePolicyVersion(xml) {
  const doc = xmlField(xml, 'Document');
  if (!doc) throw new Error('IAM GetPolicyVersion: no Document in the answer');
  return JSON.parse(decodeURIComponent(doc));
}

/** GetPolicy (for the default version), then GetPolicyVersion. */
export async function fetchLivePolicy(arn, credentials, fetchImpl = fetch) {
  const version = xmlField(await iamCall('GetPolicy', { PolicyArn: arn }, credentials, fetchImpl), 'DefaultVersionId');
  if (!version) throw new Error(`IAM GetPolicy ${arn}: no DefaultVersionId in the answer`);
  return parsePolicyVersion(await iamCall('GetPolicyVersion', { PolicyArn: arn, VersionId: version }, credentials, fetchImpl));
}

/** Lines for the log, and a Markdown summary, for each policy's diff. */
export function report(diffs) {
  const lines = [];
  const rows = ['| Policy | Result |', '| --- | --- |'];
  for (const [name, d] of Object.entries(diffs)) {
    if (inSync(d)) {
      lines.push(`${name}: in sync`);
      rows.push(`| \`${name}\` | in sync |`);
      continue;
    }
    const parts = [
      ...d.onlyRepo.map((s) => `only in the repo: ${s.Sid ?? JSON.stringify(s)}`),
      ...d.onlyLive.map((s) => `only live: ${s.Sid ?? JSON.stringify(s)}`),
      ...d.changed.map((c) => `changed: ${c.sid}`),
    ];
    lines.push(`${name}: DIFFERS from main (redeploy stacks-ci, docs/SETUP.md §2)`);
    for (const p of parts) lines.push(`  - ${p}`);
    for (const c of d.changed) lines.push(`    repo: ${JSON.stringify(c.repo)}`, `    live: ${JSON.stringify(c.live)}`);
    rows.push(`| \`${name}\` | **differs**: ${parts.join('; ')} |`);
  }
  return { lines, summary: `### stacks-ci policy drift (#101)\n\n${rows.join('\n')}\n` };
}

/** Compares every guardrail policy; returns the diffs by name. */
export async function checkDrift(template, account, credentials, fetchImpl = fetch) {
  const expected = expectedPolicies(template, account);
  const diffs = {};
  for (const [name, doc] of Object.entries(expected)) {
    diffs[name] = diffPolicies(doc, await fetchLivePolicy(`arn:aws:iam::${account}:policy/${name}`, credentials, fetchImpl));
  }
  return diffs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--account');
  const account = args[args.indexOf('--account') + 1];
  const warn = args.includes('--warn');
  if (!file || !args.includes('--account') || !/^\d{12}$/.test(account ?? '')) {
    console.error('usage: check-ci-drift <stacks-ci.template.json> --account <12-digit id> [--warn]');
    process.exit(2);
  }
  const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN };
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    console.error('check-ci-drift: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set');
    process.exit(2);
  }
  const diffs = await checkDrift(JSON.parse(readFileSync(file, 'utf8')), account, credentials);
  const { lines, summary } = report(diffs);
  const drifted = Object.values(diffs).some((d) => !inSync(d));
  for (const l of lines) console.log(l);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (drifted && warn) {
    for (const [name, d] of Object.entries(diffs)) {
      if (!inSync(d)) console.log(`::warning title=stacks-ci drift::${name} differs from main. Redeploy stacks-ci (docs/SETUP.md §2).`);
    }
  }
  process.exit(drifted && !warn ? 1 : 0);
}
