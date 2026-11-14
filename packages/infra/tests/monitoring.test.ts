import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppManifest } from '@stacks/manifest';
import { AppStack, CiStack, PlatformStack, SAVED_QUERIES, type EnvConfig, type EnvName } from '../src/index';

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
  owners: ['o@x.dev'],
};
const envs: Record<EnvName, EnvConfig> = {
  production: { rootDomain: 'example.com', hostedZoneId: 'Z123', googleClientId: 'g', platformAdmins: [] },
  staging: { rootDomain: 'test.example.com', hostedZoneId: 'Z123', hostedZoneName: 'example.com', googleClientId: 'g', platformAdmins: [] },
};
const repoRoot = path.resolve(__dirname, '../../..');
const fakeEntry = path.join(__dirname, 'fake-entry.ts');
let webDist: string;

beforeAll(() => {
  webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-monitoring-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html>');
  fs.mkdirSync(path.join(webDist, 'assets'));
  fs.writeFileSync(path.join(webDist, 'assets', 'a.js'), '1');
});

const newApp = () => new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
const appStack = (envName: EnvName, m: AppManifest = manifest, buildSha?: string) =>
  Template.fromStack(new AppStack(newApp(), { manifest: m, envName, env: envs[envName], region: 'us-east-1', repoRoot, appDir: path.join(repoRoot, 'apps/hello'), webDistPath: webDist, apiEntry: fakeEntry, buildSha }));
const platformStack = (envName: EnvName, appSlugs: string[] = ['hello', 'club'], buildSha?: string) =>
  Template.fromStack(new PlatformStack(newApp(), { envName, env: envs[envName], region: 'us-east-1', repoRoot, webDistPath: webDist, apiEntry: fakeEntry, appSlugs, buildSha }));

/** The five metric filters, exactly as deployed: these patterns must match the field names `@stacks/api` logs. */
const filters = (namespace: string) => [
  { FilterPattern: '{ $.message.type = "request" }', MetricTransformations: [{ MetricNamespace: namespace, MetricName: 'Requests', MetricValue: '1', Dimensions: [{ Key: 'app', Value: '$.message.app' }] }] },
  { FilterPattern: '{ $.message.type = "request" && $.message.status >= 500 }', MetricTransformations: [{ MetricNamespace: namespace, MetricName: 'ServerErrors', MetricValue: '1', Dimensions: [{ Key: 'app', Value: '$.message.app' }] }] },
  { FilterPattern: '{ $.message.type = "error" }', MetricTransformations: [{ MetricNamespace: namespace, MetricName: 'UnhandledErrors', MetricValue: '1', Dimensions: [{ Key: 'app', Value: '$.message.app' }] }] },
  { FilterPattern: '{ $.message.type = "client-error" }', MetricTransformations: [{ MetricNamespace: namespace, MetricName: 'ClientErrors', MetricValue: '1', Dimensions: [{ Key: 'app', Value: '$.message.app' }] }] },
  { FilterPattern: '{ $.message.type = "request" }', MetricTransformations: [{ MetricNamespace: namespace, MetricName: 'DurationMs', MetricValue: '$.message.durationMs', Unit: 'Milliseconds', Dimensions: [{ Key: 'app', Value: '$.message.app' }] }] },
];
const filtersOf = (t: Template) =>
  Object.values(t.findResources('AWS::Logs::MetricFilter'))
    .map((r) => {
      const { LogGroupName: _group, ...rest } = r.Properties as Record<string, unknown>;
      return rest;
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const sorted = (list: unknown[]) => [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const noAlerts = (t: Template) => {
  t.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  t.resourceCountIs('AWS::SNS::Topic', 0);
};

describe('AppStack monitoring', () => {
  it('names the API log group by environment and slug, keeps the retention, and logs JSON', () => {
    const staging = appStack('staging');
    staging.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/stacks/test/hello/api', RetentionInDays: 7 });
    staging.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler', LoggingConfig: { LogFormat: 'JSON', LogGroup: Match.anyValue() } });
    appStack('production').hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/stacks/prod/hello/api', RetentionInDays: 30 });
  });

  it('stamps log lines with the environment, slug and build', () => {
    const variables = (t: Template) => Object.values(t.findResources('AWS::Lambda::Function', { Properties: { Handler: 'index.handler', Environment: { Variables: { TABLE_NAME: Match.anyValue() } } } }))[0]!.Properties.Environment.Variables;
    expect(variables(appStack('staging', manifest, 'abc1234'))).toMatchObject({ STACKS_ENV_TAG: 'test', STACKS_APP_SLUG: 'hello', STACKS_BUILD_SHA: 'abc1234' });
    const local = variables(appStack('production'));
    expect(local).toMatchObject({ STACKS_ENV_TAG: 'prod', STACKS_APP_SLUG: 'hello' });
    expect(local).not.toHaveProperty('STACKS_BUILD_SHA');
  });

  it('turns the API log lines into the five metrics, per app, in the environment namespace', () => {
    expect(filtersOf(appStack('staging'))).toEqual(sorted(filters('Stacks/test')));
    expect(filtersOf(appStack('production'))).toEqual(sorted(filters('Stacks/prod')));
  });

  it('names the realtime authorizer log group too, with JSON logs and no metric filters of its own', () => {
    const t = appStack('staging', { ...manifest, modules: ['realtime'] }, 'abc1234');
    t.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/stacks/test/hello/realtime-authorizer', RetentionInDays: 7 });
    t.hasResourceProperties('AWS::Lambda::Function', {
      LoggingConfig: { LogFormat: 'JSON' },
      Environment: { Variables: Match.objectLike({ STACKS_REALTIME_NAMESPACE: 'app', STACKS_APP_SLUG: 'hello', STACKS_ENV_TAG: 'test', STACKS_BUILD_SHA: 'abc1234' }) },
    });
    t.resourceCountIs('AWS::Logs::MetricFilter', 5);
  });

  it('adds no dashboard, alarm or topic', () => {
    const t = appStack('staging', { ...manifest, modules: ['realtime'] });
    t.resourceCountIs('AWS::CloudWatch::Dashboard', 0);
    t.resourceCountIs('AWS::Logs::QueryDefinition', 0);
    noAlerts(t);
  });
});

describe('PlatformStack monitoring', () => {
  it('names the platform log group, logs JSON with the build, and has the same five metrics', () => {
    const t = platformStack('staging', [], 'abc1234');
    t.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/stacks/test/platform/api', RetentionInDays: 7 });
    t.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler', LoggingConfig: { LogFormat: 'JSON' }, Environment: { Variables: Match.objectLike({ STACKS_ENV_TAG: 'test', STACKS_BUILD_SHA: 'abc1234' }) } });
    expect(filtersOf(t)).toEqual(sorted(filters('Stacks/test')));
    platformStack('production').hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/stacks/prod/platform/api' });
  });

  it.each([
    ['staging', 'stacks-test', 'Stacks/test', '/stacks/test/'],
    ['production', 'stacks-prod', 'Stacks/prod', '/stacks/prod/'],
  ] as const)('has exactly one dashboard in %s, named %s', (envName, name, namespace, prefix) => {
    const t = platformStack(envName);
    t.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    const dashboard = Object.values(t.findResources('AWS::CloudWatch::Dashboard'))[0]!.Properties;
    expect(dashboard.DashboardName).toBe(name);
    // The body is a join around the region reference.
    const raw = dashboard.DashboardBody as string | { 'Fn::Join': [string, (string | object)[]] };
    const text = typeof raw === 'string' ? raw : raw['Fn::Join'][1].map((part) => (typeof part === 'string' ? part : 'us-east-1')).join('');
    const body = JSON.parse(text) as { widgets: { type: string; properties: { title?: string; metrics?: [{ expression: string }][]; query?: string } }[] };
    const titles = body.widgets.map((w) => w.properties.title).filter(Boolean);
    expect(titles).toEqual([
      'Requests per app',
      'Server errors per app (5xx and unhandled)',
      'Browser errors per app',
      'Request duration per app (p95, ms)',
      'Lambda errors and throttles',
      'Lambda duration (p95, ms)',
      'DynamoDB throttled requests',
      'Latest errors',
      'Slowest requests',
    ]);
    // Graphs search by namespace, so a new app appears with no platform deploy.
    const expressions = body.widgets.flatMap((w) => (w.properties.metrics ?? []).map((m) => m[0].expression));
    expect(expressions).toEqual([
      `SEARCH('{${namespace},app} MetricName="Requests"', 'Sum', 300)`,
      `SEARCH('{${namespace},app} MetricName="ServerErrors"', 'Sum', 300)`,
      `SEARCH('{${namespace},app} MetricName="UnhandledErrors"', 'Sum', 300)`,
      `SEARCH('{${namespace},app} MetricName="ClientErrors"', 'Sum', 300)`,
      `SEARCH('{${namespace},app} MetricName="DurationMs"', 'p95', 300)`,
      `SEARCH('{AWS/Lambda,FunctionName} MetricName="Errors" stacks ${envName === 'staging' ? 'test' : 'prod'}', 'Sum', 300)`,
      `SEARCH('{AWS/Lambda,FunctionName} MetricName="Throttles" stacks ${envName === 'staging' ? 'test' : 'prod'}', 'Sum', 300)`,
      `SEARCH('{AWS/Lambda,FunctionName} MetricName="Duration" stacks ${envName === 'staging' ? 'test' : 'prod'}', 'p95', 300)`,
      `SEARCH('{AWS/DynamoDB,TableName,Operation} MetricName="ThrottledRequests" stacks ${envName === 'staging' ? 'test' : 'prod'}', 'Sum', 300)`,
    ]);
    // Log tables read the platform's and every app's API log group, by name.
    const tables = body.widgets.filter((w) => w.type === 'log');
    expect(tables).toHaveLength(2);
    for (const w of tables) expect(w.properties.query).toContain(`SOURCE '${prefix}platform/api' | SOURCE '${prefix}club/api' | SOURCE '${prefix}hello/api' | fields`);
    expect(tables[0]!.properties.query).toContain('filter message.type in ["error", "client-error"]');
  });

  it('saves the six queries in the environment folder, over the same log groups', () => {
    const t = platformStack('staging');
    const queries = Object.values(t.findResources('AWS::Logs::QueryDefinition')).map((r) => r.Properties as { Name: string; QueryString: string; LogGroupNames: string[] });
    expect(queries.map((q) => q.Name).sort()).toEqual([
      'stacks-test/Browser errors',
      'stacks-test/Find by ref',
      'stacks-test/Latest errors',
      "stacks-test/One app's requests",
      "stacks-test/One user's trail",
      'stacks-test/Slowest requests',
    ]);
    for (const q of queries) expect(q.LogGroupNames).toEqual(['/stacks/test/platform/api', '/stacks/test/club/api', '/stacks/test/hello/api']);
    const byName = Object.fromEntries(queries.map((q) => [q.Name.split('/')[1], q.QueryString]));
    expect(byName['Find by ref']).toBe(
      'fields @timestamp, message.type, message.app, message.method, message.route, message.status, message.durationMs, message.userId, message.message, message.error.name, message.error.message, message.error.stack\n| filter message.ref = "PASTE-REF"\n| sort @timestamp asc\n| limit 200',
    );
    expect(byName['Browser errors']).toContain('filter message.type = "client-error"');
    expect(byName["One user's trail"]).toContain('filter message.userId = "u_PASTE-USER-ID"\n| sort @timestamp asc');
    expect(byName["One app's requests"]).toContain('filter message.type = "request" and message.app = "APP-SLUG"');
    expect(Object.keys(SAVED_QUERIES)).toHaveLength(6);
  });

  it('adds no alarm or topic', () => {
    noAlerts(platformStack('staging'));
    noAlerts(platformStack('production'));
  });
});

describe('CiStack monitoring', () => {
  it('lets staging deploys manage only the staging dashboard', () => {
    const template = Template.fromStack(new CiStack(new cdk.App(), 'stacks-ci', { githubRepo: 'dashnash/stacks', region: 'us-east-1' }));
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'stacks-test-cfn-exec',
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'StackServices', Action: Match.arrayWith(['logs:*', 'cloudwatch:ListDashboards']), Resource: '*' }),
          {
            Sid: 'MonitoringDashboard',
            Effect: 'Allow',
            Action: ['cloudwatch:PutDashboard', 'cloudwatch:DeleteDashboards', 'cloudwatch:GetDashboard'],
            Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':cloudwatch::', { Ref: 'AWS::AccountId' }, ':dashboard/stacks-test']] },
          },
        ]),
      },
    });
  });
});
