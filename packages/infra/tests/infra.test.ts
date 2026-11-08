import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppManifest } from '@stacks/manifest';
import { AppStack, buildCsp, checkAssembly, CiStack, type EnvConfig, type EnvName } from '../src/index';

const manifest: AppManifest = {
  slug: 'hello',
  name: 'Hello',
  tagline: 't',
  description: 'd',
  visibility: 'public',
  roles: [
    { id: 'OWNER', label: 'Owner', canManageAccess: true },
    { id: 'MEMBER', label: 'Member' },
  ],
  topRole: 'OWNER',
  defaultRole: 'MEMBER',
  csp: { imgSrc: ['https://covers.openlibrary.org'], connectSrc: ['https://api.example.com'] },
  owners: ['o@x.dev'],
};

const envs: Record<EnvName, EnvConfig> = {
  production: { rootDomain: 'example.com', hostedZoneId: 'Z123', googleClientId: 'g', platformAdmins: [] },
  staging: { rootDomain: 'test.example.com', hostedZoneId: 'Z123', hostedZoneName: 'example.com', googleClientId: 'g', platformAdmins: [] },
};

let webDist: string;
const repoRoot = path.resolve(__dirname, '../../..');

beforeAll(() => {
  webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-web-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html>');
  fs.mkdirSync(path.join(webDist, 'assets'));
  fs.writeFileSync(path.join(webDist, 'assets', 'index-abc.js'), '1');
});

function synth(envName: EnvName, env = envs[envName]) {
  // Skip Lambda bundling in unit tests; the synth in CI bundles for real.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new AppStack(app, {
    manifest,
    envName,
    env,
    region: 'us-east-1',
    repoRoot,
    appDir: path.join(repoRoot, 'apps/hello'),
    webDistPath: webDist,
    apiEntry: path.join(repoRoot, 'packages/infra/tests/fake-entry.ts'),
  });
  return { app, stack, template: Template.fromStack(stack) };
}

describe('AppStack', () => {
  it('is named by environment and slug, and uses that environment\'s bootstrap', () => {
    const { stack, app } = synth('staging');
    expect(stack.stackName).toBe('stacks-test-app-hello');
    expect(synth('production').stack.stackName).toBe('stacks-prod-app-hello');
    const assembly = app.synth();
    const tpl = JSON.stringify(assembly.getStackByName('stacks-test-app-hello').template);
    expect(tpl).toContain('cdk-stktest');
  });

  it('creates the single table; retained and recoverable only in production', () => {
    const prod = synth('production').template;
    prod.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'GSI1' })],
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
    });
    synth('staging').template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  });

  it('wires the Lambda to its table, origins, platform URL and credential', () => {
    const { template } = synth('production');
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Environment: {
        Variables: Match.objectLike({
          STACKS_APP_ORIGIN: 'https://hello.example.com',
          STACKS_AUTH_ORIGIN: 'https://auth.example.com',
          STACKS_PLATFORM_URL: 'https://auth.example.com/api',
          TABLE_NAME: Match.anyValue(),
          STACKS_APP_SECRET_ARN: Match.anyValue(),
        }),
      },
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'stacks-prod-app-hello-credential' });
  });

  it('serves the site at <slug>.<rootDomain> with the manifest CSP and API on the same origin', () => {
    const { template } = synth('staging');
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['hello.test.example.com'],
        CacheBehaviors: [Match.objectLike({ PathPattern: '/api/*' })],
      }),
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'hello.test.example.com.', Type: 'A' });
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: { ContentSecurityPolicy: buildCsp(manifest, { authOrigin: 'https://auth.test.example.com' }), Override: true },
        }),
      }),
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', { DefaultRouteSettings: { ThrottlingRateLimit: 25, ThrottlingBurstLimit: 50 } });
  });

  it('falls back to the CloudFront domain when no hosted zone is configured', () => {
    const { template } = synth('production', { ...envs.production, hostedZoneId: '' });
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
    expect(JSON.stringify(template.toJSON())).not.toContain('Aliases');
  });

  it('puts the staging permissions boundary on every role, and passes the assembly check', () => {
    const { app } = synth('staging');
    const out = app.synth();
    const roles = Object.values(out.getStackByName('stacks-test-app-hello').template.Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>).filter(
      (r) => r.Type === 'AWS::IAM::Role',
    );
    expect(roles.length).toBeGreaterThan(0);
    for (const r of roles) expect(JSON.stringify(r.Properties.PermissionsBoundary)).toContain('stacks-test-boundary');
    expect(checkAssembly(out.directory, 'stacks-test-app-hello')).toEqual([]);
    expect(checkAssembly(out.directory, 'stacks-test-app-other')[0]).toMatch(/exactly the stack stacks-test-app-other/);
  });

  it('tags resources with their environment', () => {
    const { template } = synth('production');
    template.hasResourceProperties('AWS::DynamoDB::Table', { Tags: Match.arrayWith([{ Key: 'stacks:env', Value: 'production' }]) });
  });
});

describe('buildCsp', () => {
  it('adds manifest sources to the defaults and allows the portal bar from the auth origin', () => {
    const csp = buildCsp(manifest, { authOrigin: 'https://auth.example.com' });
    expect(csp).toContain("script-src 'self' https://auth.example.com");
    expect(csp).toContain("img-src 'self' data: blob: https://lh3.googleusercontent.com https://covers.openlibrary.org");
    expect(csp).toContain("connect-src 'self' https://api.example.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(buildCsp({ ...manifest, csp: { frameSrc: ['https://www.youtube.com'] } }, { authOrigin: 'a' })).toContain('frame-src https://www.youtube.com');
  });
});

describe('CiStack', () => {
  it('trusts each role only from its own GitHub environment and lets it assume only its bootstrap roles', () => {
    const app = new cdk.App();
    const template = Template.fromStack(new CiStack(app, 'stacks-ci', { githubRepo: 'dashnash/stacks', region: 'us-east-1' }));
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'stacks-ci-staging',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': 'repo:dashnash/stacks:environment:staging',
              },
            },
          }),
        ],
      },
    });
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('role/cdk-stktest-*');
    expect(policies).toContain('role/cdk-stkprod-*');
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'stacks-test-cfn-exec',
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Sid: 'NeverProduction', Effect: 'Deny' })]) },
    });
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', { ManagedPolicyName: 'stacks-test-boundary' });
  });

  it('trusts the immutable subject claim when the repo uses one', () => {
    const app = new cdk.App();
    const template = Template.fromStack(
      new CiStack(app, 'stacks-ci', { githubRepo: 'dashnash/stacks', githubSubjectPrefix: 'repo:dashnash@3804293/stacks@1449992124', region: 'us-east-1' }),
    );
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'stacks-ci-production',
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: { StringEquals: Match.objectLike({ 'token.actions.githubusercontent.com:sub': 'repo:dashnash@3804293/stacks@1449992124:environment:production' }) },
          }),
        ],
      },
    });
  });
});
