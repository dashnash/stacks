import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  LegacyRedirectStack,
  legacyRedirectCode,
  loadStacksConfig,
  parseZoneIds,
  resolveZoneIds,
  ZONE_ID_PLACEHOLDER,
  zonesToLookUp,
  type EnvConfig,
} from '../src/index';
// @ts-expect-error: plain .mjs script, no types
import { listHostedZonesByName, parseHostedZones, pickZone, signV4, zoneNames } from '../../../scripts/lookup-zones.mjs';

type Query = Record<string, { value: string; multiValue?: { value: string }[] }>;

/** Run the redirect function the way CloudFront would, for one request. */
function redirect(oldRoot: string, newRoot: string, host: string, uri = '/', querystring: Query = {}) {
  const handler = new Function(`${legacyRedirectCode(oldRoot, newRoot)}; return handler;`)() as (e: unknown) => any;
  const res = handler({ request: { uri, querystring, headers: { host: { value: host } } } });
  expect(res.statusCode).toBe(301);
  return res.headers.location.value as string;
}
const staging = (host: string, uri?: string, q?: Query) => redirect('test.old.example', 'test.new.example', host, uri, q);
const production = (host: string, uri?: string, q?: Query) => redirect('old.example', 'new.example', host, uri, q);

describe('legacy redirect function', () => {
  it('sends the bare old root to auth. on the new root, keeping path and query', () => {
    expect(staging('test.old.example')).toBe('https://auth.test.new.example/');
    expect(production('old.example', '/x', { a: { value: '1' } })).toBe('https://auth.new.example/x?a=1');
  });

  it('keeps the host label, path and query', () => {
    expect(staging('auth.test.old.example', '/authorize', { app: { value: 'hello' } })).toBe('https://auth.test.new.example/authorize?app=hello');
    expect(staging('hello.test.old.example', '/x', { y: { value: '1' } })).toBe('https://hello.test.new.example/x?y=1');
    expect(staging('Hello.Test.Old.Example', '/a/b')).toBe('https://hello.test.new.example/a/b');
    expect(production('mofobookklub.old.example', '/book/42')).toBe('https://mofobookklub.new.example/book/42');
  });

  it('keeps repeated, empty and encoded query values', () => {
    const q: Query = { t: { value: 'a', multiValue: [{ value: 'a' }, { value: 'b' }] }, flag: { value: '' }, s: { value: 'x%20y' } };
    expect(staging('hello.test.old.example', '/', q)).toBe('https://hello.test.new.example/?t=a&t=b&flag&s=x%20y');
  });

  it("doesn't mix up staging and production roots", () => {
    // Staging's own hosts land on staging, never on production or a doubled test. label.
    expect(staging('hello.test.old.example')).toBe('https://hello.test.new.example/');
    // A production host that reached the staging redirect is not its business: the front page.
    expect(staging('hello.old.example', '/x')).toBe('https://auth.test.new.example/');
    // Production never builds a host from two labels.
    expect(production('hello.test.old.example', '/x')).toBe('https://auth.new.example/');
    expect(production('hello.old.example', '/x')).toBe('https://hello.new.example/x');
  });

  it('never builds a location from a lookalike or odd host', () => {
    for (const host of ['old.example.evil.example', 'hello.old.example.evil.example', 'evilold.example', '', 'a_b.old.example', '-x.old.example']) {
      expect(production(host, '/steal', { q: { value: '1' } })).toBe('https://auth.new.example/');
    }
  });

  it('answers the apple-app-site-association path with a redirect too (no app links on the old domain)', () => {
    expect(staging('hello.test.old.example', '/.well-known/apple-app-site-association')).toBe('https://hello.test.new.example/.well-known/apple-app-site-association');
  });
});

describe('LegacyRedirectStack', () => {
  const env: EnvConfig = {
    rootDomain: 'test.new.example',
    hostedZoneId: 'ZNEW',
    hostedZoneName: 'new.example',
    googleClientId: 'g',
    platformAdmins: [],
    legacyRedirects: [{ rootDomain: 'test.old.example', hostedZoneId: 'ZOLD', hostedZoneName: 'old.example' }],
  };
  const t = Template.fromStack(new LegacyRedirectStack(new cdk.App(), { envName: 'staging', env, region: 'us-east-1' }));

  it('holds the old root and its wildcard on its own certificate, in the old zone', () => {
    t.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'test.old.example',
      SubjectAlternativeNames: ['*.test.old.example'],
      DomainValidationOptions: Match.arrayWith([Match.objectLike({ HostedZoneId: 'ZOLD' })]),
    });
    t.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({ Aliases: ['test.old.example', '*.test.old.example'] }) });
    for (const name of ['test.old.example.', '*.test.old.example.']) {
      for (const type of ['A', 'AAAA']) t.hasResourceProperties('AWS::Route53::RecordSet', { Name: name, Type: type, HostedZoneId: 'ZOLD' });
    }
    t.resourceCountIs('AWS::Route53::RecordSet', 4);
    t.resourceCountIs('AWS::S3::Bucket', 0);
    t.resourceCountIs('AWS::Lambda::Function', 0);
  });

  it('with hosts, holds only those names and leaves the bare old root and its wildcard free', () => {
    const only = Template.fromStack(
      new LegacyRedirectStack(new cdk.App(), {
        envName: 'production',
        env: { ...env, rootDomain: 'new.example', legacyRedirects: [{ rootDomain: 'old.example', hostedZoneId: 'ZOLD', hosts: ['mofobookklub'] }] },
        region: 'us-east-1',
      }),
    );
    only.hasResourceProperties('AWS::CertificateManager::Certificate', { DomainName: 'mofobookklub.old.example', SubjectAlternativeNames: Match.absent() });
    only.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({ Aliases: ['mofobookklub.old.example'] }) });
    for (const type of ['A', 'AAAA']) only.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'mofobookklub.old.example.', Type: type, HostedZoneId: 'ZOLD' });
    only.resourceCountIs('AWS::Route53::RecordSet', 2);
    expect(JSON.stringify(only.toJSON())).not.toMatch(/"\*\.old\.example|"old\.example\.?"/);
  });

  it('is named per environment', () => {
    const app = new cdk.App();
    expect(new LegacyRedirectStack(app, { envName: 'production', env, region: 'us-east-1' }).stackName).toBe('stacks-prod-legacy-redirect');
    expect(new LegacyRedirectStack(app, { envName: 'staging', env, region: 'us-east-1' }).stackName).toBe('stacks-test-legacy-redirect');
  });
});

describe('hosted zone lookup', () => {
  const env: EnvConfig = { rootDomain: 'test.new.example', hostedZoneId: 'lookup', hostedZoneName: 'new.example', googleClientId: 'g', platformAdmins: [] };

  it('uses the ID CI passes, or a placeholder so synth works without AWS credentials', () => {
    expect(resolveZoneIds(env, parseZoneIds('new.example=Z0123ABC')).hostedZoneId).toBe('Z0123ABC');
    expect(resolveZoneIds(env, {}).hostedZoneId).toBe(ZONE_ID_PLACEHOLDER);
    expect(() => resolveZoneIds(env, {}, true)).toThrow(/No zone ID for new.example/);
    expect(resolveZoneIds({ ...env, hostedZoneId: 'Z9' }, {}, true).hostedZoneId).toBe('Z9');
    expect(() => parseZoneIds('new.example=not-an-id')).toThrow();
    expect(parseZoneIds('')).toEqual({});
  });

  it('picks exactly one public zone with that exact name', () => {
    const zones = { HostedZones: [{ Id: '/hostedzone/ZNINJA1', Name: 'new.example.' }, { Id: '/hostedzone/ZOTHER', Name: 'new.example.evil.' }] };
    expect(pickZone('new.example', zones)).toBe('ZNINJA1');
    expect(() => pickZone('missing.example', zones)).toThrow(/found 0/);
    expect(() => pickZone('new.example', { HostedZones: [...zones.HostedZones, { Id: '/hostedzone/ZTWO', Name: 'new.example.' }] })).toThrow(/found 2/);
    expect(() => pickZone('new.example', { HostedZones: [{ Id: '/hostedzone/ZPRIV', Name: 'new.example.', Config: { PrivateZone: true } }] })).toThrow(/found 0/);
  });

  it('signs requests with SigV4 exactly as in the AWS documentation example', () => {
    const headers = signV4({
      host: 'iam.amazonaws.com',
      query: { Action: 'ListUsers', Version: '2010-05-08' },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      region: 'us-east-1',
      service: 'iam',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  it('reads Route 53 answers and asks for the zone with the session token signed in', async () => {
    const xml = `<?xml version="1.0"?><ListHostedZonesByNameResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><HostedZones>
      <HostedZone><Id>/hostedzone/ZNINJA1</Id><Name>new.example.</Name><CallerReference>x</CallerReference><Config><PrivateZone>false</PrivateZone></Config></HostedZone>
      <HostedZone><Id>/hostedzone/ZPRIV</Id><Name>new.example.</Name><Config><PrivateZone>true</PrivateZone></Config></HostedZone>
    </HostedZones><DNSName>new.example</DNSName><IsTruncated>false</IsTruncated><MaxItems>10</MaxItems></ListHostedZonesByNameResponse>`;
    const parsed = parseHostedZones(xml);
    expect(parsed.HostedZones).toEqual([
      { Id: '/hostedzone/ZNINJA1', Name: 'new.example.', Config: { PrivateZone: false } },
      { Id: '/hostedzone/ZPRIV', Name: 'new.example.', Config: { PrivateZone: true } },
    ]);
    expect(pickZone('new.example', parsed)).toBe('ZNINJA1');

    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fakeFetch = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return new Response(xml, { status: 200 });
    };
    const zones = await listHostedZonesByName('new.example', { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'TOKEN' }, fakeFetch);
    expect(zones.HostedZones).toHaveLength(2);
    const [call] = calls;
    expect(call?.url).toBe('https://route53.amazonaws.com/2013-04-01/hostedzonesbyname?dnsname=new.example&maxitems=10');
    expect(call?.headers['x-amz-security-token']).toBe('TOKEN');
    expect(call?.headers.authorization).toMatch(/Credential=AK\/\d{8}\/us-east-1\/route53\/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);

    const denied = async () => new Response('<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>', { status: 403 });
    await expect(listHostedZonesByName('new.example', { accessKeyId: 'AK', secretAccessKey: 'SK' }, denied)).rejects.toThrow(/HTTP 403.*AccessDenied/);
  });

  it('looks up the same zones as the CDK app, and validates the config', () => {
    const repoConfig = loadStacksConfig(path.resolve(__dirname, '../../../stacks.config.json'));
    expect(zoneNames(repoConfig)).toEqual(zonesToLookUp(repoConfig));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-config-'));
    const write = (staging: object) => {
      const file = path.join(dir, 'c.json');
      fs.writeFileSync(file, JSON.stringify({ ...repoConfig, environments: { ...repoConfig.environments, staging: { ...repoConfig.environments.staging, ...staging } } }));
      return () => loadStacksConfig(file);
    };
    expect(write({ hostedZoneId: 'lookup', hostedZoneName: undefined })).toThrow(/hostedZoneName is required/);
    expect(write({ hostedZoneId: 'nope' })).toThrow(/neither a Route 53 zone ID/);
    expect(write({ legacyRedirects: [{ rootDomain: repoConfig.environments.staging.rootDomain, hostedZoneId: 'Z1' }] })).toThrow(/to itself/);
    expect(write({ legacyRedirects: [{ rootDomain: 'test.old.example', hostedZoneId: 'Z1', hostedZoneName: 'other.example' }] })).toThrow(/not inside the zone/);
    const legacy = { rootDomain: 'test.old.example', hostedZoneId: 'Z1', hostedZoneName: 'old.example' };
    expect(write({ legacyRedirects: [{ ...legacy, hosts: [] }] })).toThrow(/non-empty list/);
    expect(write({ legacyRedirects: [{ ...legacy, hosts: ['a.b'] }] })).toThrow(/not a host label/);
    expect(write({ legacyRedirects: [{ ...legacy, hosts: ['*'] }] })).toThrow(/not a host label/);
    expect(write({ legacyRedirects: [{ ...legacy, hosts: ['mofobookklub'] }] })).not.toThrow();
    expect(write({})).not.toThrow();
  });
});
