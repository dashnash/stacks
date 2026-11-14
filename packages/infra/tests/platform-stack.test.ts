import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppManifest } from '@stacks/manifest';
import { AppStack, PlatformStack, PORTAL_CSP, portalRouterCode, type EnvConfig } from '../src/index';

const env: EnvConfig = { rootDomain: 'test.example.com', hostedZoneId: 'Z123', hostedZoneName: 'example.com', googleClientId: 'gid', platformAdmins: ['root@x.dev', 'two@x.dev'] };
const repoRoot = path.resolve(__dirname, '../../..');
let webDist: string;

beforeAll(() => {
  webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-portal-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html>');
  fs.mkdirSync(path.join(webDist, 'assets'));
  fs.writeFileSync(path.join(webDist, 'assets', 'a.js'), '1');
});

function synth(e = env) {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new PlatformStack(app, { envName: 'staging', env: e, region: 'us-east-1', repoRoot, webDistPath: webDist, apiEntry: path.join(__dirname, 'fake-entry.ts') });
  return Template.fromStack(stack);
}

describe('PlatformStack', () => {
  it('creates the wildcard certificate and shares its ARN through SSM', () => {
    const t = synth();
    t.hasResourceProperties('AWS::CertificateManager::Certificate', { DomainName: '*.test.example.com', SubjectAlternativeNames: ['test.example.com'] });
    t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/stacks/test/certificate-arn' });
    // Replacing it (a new rootDomain) must not try to delete the old one while app distributions use it.
    t.hasResource('AWS::CertificateManager::Certificate', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  });

  it('serves the portal at auth.<domain> and the bare domain, with sign-in routes going to the API', () => {
    const t = synth();
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['auth.test.example.com', 'test.example.com'],
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: '/api/*' }), Match.objectLike({ PathPattern: '/authorize' }), Match.objectLike({ PathPattern: '/logout' })]),
      }),
    });
    for (const key of ['GET /authorize', 'GET /logout', 'ANY /api/{proxy+}']) t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: key });
    t.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'auth.test.example.com.', Type: 'A' });
    t.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({ SecurityHeadersConfig: Match.objectLike({ ContentSecurityPolicy: { ContentSecurityPolicy: PORTAL_CSP, Override: true } }) }),
    });
    expect(portalRouterCode('test.example.com')).toContain("'https://auth.test.example.com' + request.uri");
  });

  it('puts the API into maintenance only when the environment says so', () => {
    const vars = (t: Template) => JSON.stringify(Object.values(t.findResources('AWS::Lambda::Function')).map((f) => f.Properties?.Environment?.Variables ?? {}));
    expect(vars(synth())).not.toContain('STACKS_MAINTENANCE');
    expect(vars(synth({ ...env, maintenance: true }))).toContain('"STACKS_MAINTENANCE":"1"');
  });

  it('configures the Lambda and limits it to the registry, app credentials and app session items', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ STACKS_ENV_TAG: 'test', STACKS_ROOT_DOMAIN: 'test.example.com', GOOGLE_CLIENT_ID: 'gid', PLATFORM_ADMINS: 'root@x.dev,two@x.dev' }) },
    });
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('parameter/stacks/test/apps/*');
    expect(policies).toContain('secret:stacks-test-app-*');
    expect(policies).toContain('table/stacks-test-app-*');
    expect(policies).toContain('"dynamodb:LeadingKeys":["SESSION#*","USERSESSIONS#*"]');
  });

  it('tells the Lambda the web Services ID for Sign in with Apple, and lets the portal load Apple JS', () => {
    const t = synth({ ...env, appleServicesId: 'ninja.dashnash.stacks.test.web' });
    t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ APPLE_SERVICES_ID: 'ninja.dashnash.stacks.test.web' }) } });
    expect(PORTAL_CSP).toContain('https://appleid.cdn-apple.com');
    expect(PORTAL_CSP).toMatch(/frame-src[^;]*https:\/\/appleid\.apple\.com/);
  });

  it('lets the Lambda read the APNs key from its own secrets path, decrypting only through SSM', () => {
    const t = synth({ ...env, native: { appleTeamId: '47ZUZ59AHR', iosBundleId: 'ninja.dashnash.stacks.test', googleIosClientIds: [], minShellVersion: '1.0.0' } });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ PLATFORM_SECRETS_PREFIX: '/stacks/test/secrets/platform/', IOS_BUNDLE_ID: 'ninja.dashnash.stacks.test', APPLE_TEAM_ID: '47ZUZ59AHR' }) },
    });
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).toContain(':parameter/stacks/test/secrets/platform/*');
    expect(policies).toContain('ssm.us-east-1.amazonaws.com');
    expect(JSON.stringify(t.findResources('AWS::SSM::Parameter'))).not.toContain('/secrets/');
  });

  it('works without a hosted zone (CloudFront domain, no certificate)', () => {
    const t = synth({ ...env, hostedZoneId: '' });
    t.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    t.resourceCountIs('AWS::Route53::RecordSet', 0);
  });
});

describe('AppStack contentPacks', () => {
  it('adds a private content bucket, lets the Lambda read, write and delete there, and never prunes uploads', () => {
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-content-'));
    fs.writeFileSync(path.join(contentDir, 'quotes.json'), '[]');
    const manifest: AppManifest = {
      slug: 'club', name: 'Club', tagline: 't', description: 'd', visibility: 'private', modules: ['contentPacks'],
      roles: [{ id: 'OWNER', label: 'Owner', canManageAccess: true }, { id: 'MEMBER', label: 'Member' }],
      topRole: 'OWNER', defaultRole: 'MEMBER', owners: ['o@x.dev'],
    };
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const t = Template.fromStack(
      new AppStack(app, { manifest, envName: 'production', env, region: 'us-east-1', repoRoot, appDir: '/nowhere', webDistPath: webDist, contentDir, apiEntry: path.join(__dirname, 'fake-entry.ts') }),
    );
    t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ CONTENT_BUCKET: Match.anyValue() }) } });
    t.hasResourceProperties('Custom::CDKBucketDeployment', { Prune: false });
    const actions = Object.values(t.findResources('AWS::IAM::Policy'))
      .flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } }).Properties.PolicyDocument.Statement)
      .flatMap((st) => [st.Action].flat());
    expect(actions).toEqual(expect.arrayContaining(['s3:GetObject*', 's3:PutObject', 's3:DeleteObject*']));
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', Properties: Match.objectLike({ PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }) }) });
  });
});

describe('AppStack registry entries', () => {
  it('registers the manifest and table name with the platform', () => {
    const manifest: AppManifest = {
      slug: 'hello', name: 'Hello', tagline: 't', description: 'd', visibility: 'public',
      roles: [{ id: 'OWNER', label: 'Owner', canManageAccess: true }, { id: 'MEMBER', label: 'Member' }],
      topRole: 'OWNER', defaultRole: 'MEMBER', owners: ['o@x.dev'],
    };
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const t = Template.fromStack(
      new AppStack(app, { manifest, envName: 'staging', env, region: 'us-east-1', repoRoot, appDir: '/nowhere', webDistPath: webDist, apiEntry: path.join(__dirname, 'fake-entry.ts') }),
    );
    t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/stacks/test/apps/hello/manifest', Value: JSON.stringify(manifest) });
    t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/stacks/test/apps/hello/table' });
  });
});

describe('AppStack secrets', () => {
  const withSecrets = (secrets?: AppManifest['secrets']) => {
    const manifest: AppManifest = {
      slug: 'club', name: 'Club', tagline: 't', description: 'd', visibility: 'private',
      roles: [{ id: 'OWNER', label: 'Owner', canManageAccess: true }, { id: 'MEMBER', label: 'Member' }],
      topRole: 'OWNER', defaultRole: 'MEMBER', owners: ['o@x.dev'], ...(secrets ? { secrets } : {}),
    };
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    return Template.fromStack(
      new AppStack(app, { manifest, envName: 'staging', env, region: 'us-east-1', repoRoot, appDir: '/nowhere', webDistPath: webDist, apiEntry: path.join(__dirname, 'fake-entry.ts') }),
    );
  };

  it('lets the Lambda read only its own secrets, outside the registry path, and decrypt only through SSM', () => {
    const t = withSecrets([{ name: 'GOOGLE_BOOKS_API_KEY', optional: true }]);
    t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ STACKS_SECRETS_PREFIX: '/stacks/test/secrets/club/' }) } });
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).toContain(':parameter/stacks/test/secrets/club/*');
    expect(policies).toContain('ssm.us-east-1.amazonaws.com');
    // No parameter is created: the value is put in by hand, never through CloudFormation.
    expect(JSON.stringify(t.findResources('AWS::SSM::Parameter'))).not.toContain('/secrets/');
  });

  it('adds nothing when the manifest declares no secrets', () => {
    const t = withSecrets();
    expect(JSON.stringify(t.toJSON())).not.toContain('STACKS_SECRETS_PREFIX');
    expect(JSON.stringify(t.findResources('AWS::IAM::Policy'))).not.toContain('kms:ViaService');
  });
});
