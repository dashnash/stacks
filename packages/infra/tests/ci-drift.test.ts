import * as cdk from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { CiStack } from '../src/index';
// @ts-expect-error plain .mjs script, no types
import { checkDrift, diffPolicies, expectedPolicies, inSync, normalizePolicy, parsePolicyVersion, report, resolveIntrinsics } from '../../../scripts/check-ci-drift.mjs';

// #101: stacks-ci is deployed by hand; this compares the live staging policies with main's.
const account = '123456789012';
const template = cdk.assertions.Template.fromStack(new CiStack(new cdk.App(), 'stacks-ci', { githubRepo: 'dashnash/stacks', region: 'us-east-1' })).toJSON();
const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token' };

/** An IAM stub answering GetPolicy / GetPolicyVersion with the given live documents. */
function iam(live: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
    const u = new URL(url);
    calls.push(u.searchParams.get('Action')!);
    expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/iam\/aws4_request/);
    const name = u.searchParams.get('PolicyArn')!.split('/').pop()!;
    const body =
      u.searchParams.get('Action') === 'GetPolicy'
        ? `<GetPolicyResponse><GetPolicyResult><Policy><DefaultVersionId>v3</DefaultVersionId></Policy></GetPolicyResult></GetPolicyResponse>`
        : `<GetPolicyVersionResponse><GetPolicyVersionResult><PolicyVersion><Document>${encodeURIComponent(JSON.stringify(live[name]))}</Document><VersionId>${u.searchParams.get('VersionId')}</VersionId></PolicyVersion></GetPolicyVersionResult></GetPolicyVersionResponse>`;
    return new Response(body, { status: 200 });
  };
  return { fetchImpl, calls };
}

describe('check-ci-drift (#101)', () => {
  it('resolves Fn::Join and the pseudo-parameters, and refuses anything else', () => {
    const v = { Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, ':policy/x']] } };
    expect(resolveIntrinsics(v, account)).toEqual({ Resource: `arn:aws:iam::${account}:policy/x` });
    expect(() => resolveIntrinsics({ Resource: { 'Fn::GetAtt': ['Role', 'Arn'] } }, account)).toThrow(/can't resolve Fn::GetAtt/);
    expect(() => resolveIntrinsics({ Resource: { Ref: 'SomeRole' } }, account)).toThrow(/can't resolve Ref/);
  });

  it('finds both guardrail policies in the real template, fully resolved', () => {
    const expected = expectedPolicies(template, account);
    expect(Object.keys(expected).sort()).toEqual(['stacks-test-boundary', 'stacks-test-cfn-exec']);
    expect(JSON.stringify(expected)).not.toMatch(/Fn::|"Ref"/);
    expect(JSON.stringify(expected)).toContain(`arn:aws:iam::${account}:policy/stacks-test-boundary`);
  });

  it('treats a single value and a one-item list, and any order, as the same', () => {
    const a = { Version: '2012-10-17', Statement: [{ Sid: 'B', Effect: 'Allow', Action: 's3:*', Resource: ['y', 'x'] }, { Sid: 'A', Effect: 'Deny', Action: ['*'], Resource: '*', Condition: { StringEquals: { k: 'v' } } }] };
    const b = { Version: '2012-10-17', Statement: [{ Sid: 'A', Effect: 'Deny', Action: '*', Resource: ['*'], Condition: { StringEquals: { k: ['v'] } } }, { Resource: ['x', 'y'], Action: ['s3:*'], Effect: 'Allow', Sid: 'B' }] };
    expect(normalizePolicy(a)).toEqual(normalizePolicy(b));
    expect(inSync(diffPolicies(a, b))).toBe(true);
  });

  it('reports a changed statement by Sid, and statements only on one side', () => {
    const repo = { Statement: [{ Sid: 'A', Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::stacks-test-*' }, { Sid: 'New', Effect: 'Deny', Action: '*', Resource: '*' }] };
    const live = { Statement: [{ Sid: 'A', Effect: 'Allow', Action: 's3:*', Resource: '*' }, { Sid: 'Old', Effect: 'Allow', Action: 'ssm:*', Resource: '*' }] };
    const d = diffPolicies(repo, live);
    expect(d.changed.map((c: { sid: string }) => c.sid)).toEqual(['A']);
    expect(d.onlyRepo.map((s: { Sid: string }) => s.Sid)).toEqual(['New']);
    expect(d.onlyLive.map((s: { Sid: string }) => s.Sid)).toEqual(['Old']);
    const { lines, summary } = report({ 'stacks-test-boundary': d });
    expect(lines[0]).toMatch(/DIFFERS/);
    expect(summary).toMatch(/\*\*differs\*\*: only in the repo: New; only live: Old; changed: A/);
  });

  it('decodes the URL-encoded document IAM returns', () => {
    const doc = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'iam:GetPolicy', Resource: 'arn:aws:iam::1:policy/a b' }] };
    expect(parsePolicyVersion(`<Document>${encodeURIComponent(JSON.stringify(doc))}</Document>`)).toEqual(doc);
  });

  it('is in sync when the live policies are what main synthesizes (signed IAM calls, default version)', async () => {
    const expected = expectedPolicies(template, account);
    const { fetchImpl, calls } = iam(expected);
    const diffs = await checkDrift(template, account, credentials, fetchImpl);
    expect(Object.values(diffs).every(inSync)).toBe(true);
    expect(calls).toEqual(['GetPolicy', 'GetPolicyVersion', 'GetPolicy', 'GetPolicyVersion']);
    expect(report(diffs).lines).toEqual(['stacks-test-boundary: in sync', 'stacks-test-cfn-exec: in sync']);
  });

  it('catches a guardrail change that was merged but never deployed', async () => {
    const expected = expectedPolicies(template, account);
    const stale = JSON.parse(JSON.stringify(expected));
    stale['stacks-test-boundary'].Statement = stale['stacks-test-boundary'].Statement.filter((s: { Sid?: string }) => s.Sid !== 'NeverProductionByName');
    const diffs = await checkDrift(template, account, credentials, iam(stale).fetchImpl);
    expect(inSync(diffs['stacks-test-cfn-exec'])).toBe(true);
    expect(diffs['stacks-test-boundary'].onlyRepo.map((s: { Sid: string }) => s.Sid)).toEqual(['NeverProductionByName']);
  });
});
