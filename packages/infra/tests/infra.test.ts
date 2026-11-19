import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppManifest } from '@stacks/manifest';
import { API_BURST_LIMIT, API_RATE_LIMIT, APP_ROUTE_THROTTLES, AppStack, buildCsp, bundleGameServer, checkAssembly, BUDGET_NAME, CiStack, loadStacksConfig, stagingRecordNames, stagingRootDomains, GAME_BOOTSTRAP_SCRIPT, GAME_BUNDLE_URL_ENV, GAME_SERVER_IMAGE, type EnvConfig, type EnvName } from '../src/index';

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

function synth(envName: EnvName, env = envs[envName], m: AppManifest = manifest) {
  // Skip Lambda bundling in unit tests; the synth in CI bundles for real.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new AppStack(app, {
    manifest: m,
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
  it("passes the environment's maintenance flag to the app's Lambda", () => {
    const vars = (t: Template) => JSON.stringify(Object.values(t.findResources('AWS::Lambda::Function')).map((f) => f.Properties?.Environment?.Variables ?? {}));
    expect(vars(synth('staging').template)).not.toContain('STACKS_MAINTENANCE');
    expect(vars(synth('staging', { ...envs.staging, maintenance: true }).template)).toContain('"STACKS_MAINTENANCE":"1"');
  });

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

  it('caps sign-in and error reports per route, each on its own route to the same Lambda (#102)', () => {
    const { template } = synth('staging');
    const json = template.toJSON() as { Resources: Record<string, { Type: string; Properties: Record<string, unknown>; DependsOn?: string[] }> };
    const resources = Object.entries(json.Resources);
    const routes = resources.filter(([, r]) => r.Type === 'AWS::ApiGatewayV2::Route');
    const target = (key: string) => routes.find(([, r]) => r.Properties.RouteKey === key)?.[1].Properties.Target;
    expect(target('ANY /api/{proxy+}')).toBeDefined();
    for (const { routeKey } of APP_ROUTE_THROTTLES) expect(target(routeKey), routeKey).toEqual(target('ANY /api/{proxy+}'));
    expect(routes).toHaveLength(APP_ROUTE_THROTTLES.length + 1);
    const [, stage] = resources.find(([, r]) => r.Type === 'AWS::ApiGatewayV2::Stage')!;
    expect(stage.Properties.DefaultRouteSettings).toEqual({ ThrottlingRateLimit: API_RATE_LIMIT, ThrottlingBurstLimit: API_BURST_LIMIT });
    expect(stage.Properties.RouteSettings).toEqual(
      Object.fromEntries(APP_ROUTE_THROTTLES.map((r) => [r.routeKey, { ThrottlingRateLimit: r.rate, ThrottlingBurstLimit: r.burst }])),
    );
    for (const r of APP_ROUTE_THROTTLES) {
      expect(r.rate, r.routeKey).toBeLessThan(API_RATE_LIMIT);
      expect(r.burst, r.routeKey).toBeLessThan(API_BURST_LIMIT);
      const [id] = routes.find(([, x]) => x.Properties.RouteKey === r.routeKey)!;
      expect(stage.DependsOn ?? [], r.routeKey).toContain(id);
    }
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
    expect(csp).toContain("connect-src 'self' https://auth.example.com https://api.example.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(buildCsp({ ...manifest, csp: { frameSrc: ['https://www.youtube.com'] } }, { authOrigin: 'a' })).toContain('frame-src https://www.youtube.com');
  });
});

describe('AppStack realtime module', () => {
  const live = { ...manifest, modules: ['realtime' as const] };

  it('adds an Event API with IAM and Lambda auth, the authorizer, the key, a scoped publish grant and the CSP host', () => {
    const { template, app } = synth('staging', envs.staging, live);
    template.resourceCountIs('AWS::AppSync::Api', 1);
    template.hasResourceProperties('AWS::AppSync::Api', {
      Name: 'stacks-test-hello',
      EventConfig: Match.objectLike({
        AuthProviders: Match.arrayWith([
          { AuthType: 'AWS_IAM' },
          Match.objectLike({ AuthType: 'AWS_LAMBDA', LambdaAuthorizerConfig: Match.objectLike({ AuthorizerResultTtlInSeconds: 0 }) }),
        ]),
        ConnectionAuthModes: [{ AuthType: 'AWS_LAMBDA' }],
        DefaultSubscribeAuthModes: [{ AuthType: 'AWS_LAMBDA' }],
        DefaultPublishAuthModes: [{ AuthType: 'AWS_IAM' }, { AuthType: 'AWS_LAMBDA' }],
      }),
    });
    template.hasResourceProperties('AWS::AppSync::ChannelNamespace', { Name: 'app', CodeHandlers: Match.stringLikeRegexp('onPublish') });
    template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'stacks-test-app-hello-realtime-key' });
    // The authorizer: Node 22 on arm64, its own logs, the key, and the staging boundary like every role.
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Environment: { Variables: Match.objectLike({ STACKS_REALTIME_NAMESPACE: 'app', STACKS_REALTIME_KEY_ARN: Match.anyValue() }) },
      LoggingConfig: Match.objectLike({ LogGroup: Match.anyValue() }),
    });
    template.hasResourceProperties('AWS::Lambda::Permission', { Principal: 'appsync.amazonaws.com', Action: 'lambda:InvokeFunction' });
    for (const role of Object.values(template.findResources('AWS::IAM::Role'))) expect(role.Properties.PermissionsBoundary).toBeDefined();
    // The API Lambda: where to publish, and appsync:EventPublish on this API's namespace only.
    const vars = JSON.stringify(Object.values(template.findResources('AWS::Lambda::Function')).map((f) => f.Properties?.Environment?.Variables ?? {}));
    for (const v of ['STACKS_REALTIME_HTTP_HOST', 'STACKS_REALTIME_WS_HOST', 'STACKS_REALTIME_KEY_ARN']) expect(vars).toContain(v);
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('appsync:EventPublish');
    expect(policies).toContain('appsync:EventConnect');
    expect(policies).toContain('/channelNamespace/app');
    expect(policies).not.toMatch(/"Action":"appsync:\*"/);
    // CSP: the app's own wss host, from the Event API.
    const csp = JSON.stringify(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
    expect(csp).toContain('wss://');
    expect(csp).toContain('Dns.Realtime');
    // config.json gets both endpoints.
    expect(JSON.stringify(app.synth().getStackByName('stacks-test-app-hello').template)).toContain('Dns.Http');
    expect(checkAssemblyProblems(app)).toEqual([]);
  });

  it('adds none of it without the module', () => {
    const { template } = synth('staging');
    template.resourceCountIs('AWS::AppSync::Api', 0);
    template.resourceCountIs('AWS::AppSync::ChannelNamespace', 0);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/realtime|appsync/i);
  });

  it('builds the production stack too', () => {
    const { template } = synth('production', envs.production, live);
    template.hasResourceProperties('AWS::AppSync::Api', { Name: 'stacks-prod-hello' });
    template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'stacks-prod-app-hello-realtime-key' });
  });
});

describe('AppStack gameServer module', () => {
  const game: AppManifest = { ...manifest, modules: ['realtime', 'gameServer'] };
  const synthGame = (envName: EnvName = 'staging', m: AppManifest = game, extra: Partial<ConstructorParameters<typeof AppStack>[1]> = {}) => {
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new AppStack(app, {
      manifest: m,
      envName,
      env: envs[envName],
      region: 'us-east-1',
      repoRoot,
      appDir: path.join(repoRoot, 'apps/hello'),
      webDistPath: webDist,
      apiEntry: path.join(repoRoot, 'packages/infra/tests/fake-entry.ts'),
      ...extra,
    });
    return { app, stack, template: Template.fromStack(stack) };
  };
  const statements = (template: Template, roleMatch: RegExp): Array<Record<string, any>> =>
    Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => roleMatch.test(id))
      .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as Array<Record<string, any>>);
  const withAction = (list: Array<Record<string, any>>, action: string) => list.filter((s) => [s.Action].flat().includes(action));

  it('defines an arm64 Fargate task on the pinned Node image that fetches its game, logging to its own group, with the room server\'s environment', () => {
    const { template } = synthGame();
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'stacks-test-app-hello-game',
      RequiresCompatibilities: ['FARGATE'],
      NetworkMode: 'awsvpc',
      Cpu: '256',
      Memory: '512',
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
      ContainerDefinitions: [
        Match.objectLike({
          Name: 'game',
          Image: GAME_SERVER_IMAGE,
          Command: ['node', '--enable-source-maps', '-e', GAME_BOOTSTRAP_SCRIPT],
          User: 'node',
          StopTimeout: 30,
          LogConfiguration: Match.objectLike({ LogDriver: 'awslogs', Options: Match.objectLike({ 'awslogs-stream-prefix': 'room' }) }),
        }),
      ],
    });
    const def = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0]!;
    const env = Object.fromEntries((def.Properties.ContainerDefinitions[0].Environment as { Name: string; Value: unknown }[]).map((e) => [e.Name, e.Value]));
    expect(env).toMatchObject({
      STACKS_APP: 'hello',
      STACKS_REALTIME_NAMESPACE: 'app',
      STACKS_GAME_MAX_PLAYERS: '8',
      STACKS_GAME_IDLE_MINUTES: '10',
      STACKS_GAME_MAX_HOURS: '2',
      STACKS_GAME_PORT_MIN: '40000',
      STACKS_GAME_PORT_MAX: '40019',
    });
    for (const name of ['TABLE_NAME', 'STACKS_REALTIME_HTTP_HOST', 'STACKS_REALTIME_WS_HOST', 'STACKS_GAME_KEY_ARN']) expect(env[name], name).toBeDefined();
    // Nothing secret in the environment: the key is an ARN the task role may read.
    expect(JSON.stringify(env.STACKS_GAME_KEY_ARN)).toContain('GameKey');
    template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/stacks/test/hello/game-server', RetentionInDays: 7 });
    template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'stacks-test-app-hello-game-key' });
  });

  it('honours the manifest\'s cpu, memory and limits', () => {
    const { template } = synthGame('staging', { ...game, gameServer: { cpu: 512, memory: 1024, maxPlayers: 4, idleMinutes: 5, maxHours: 0.5 } });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', { Cpu: '512', Memory: '1024' });
    const env = JSON.stringify(Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0]!.Properties.ContainerDefinitions[0].Environment);
    expect(env).toContain('{"Name":"STACKS_GAME_MAX_PLAYERS","Value":"4"}');
    expect(env).toContain('{"Name":"STACKS_GAME_MAX_HOURS","Value":"0.5"}');
  });

  it('opens UDP 40000-40019 from anywhere and nothing else inbound', () => {
    const { template } = synthGame();
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      VpcId: { Ref: Match.stringLikeRegexp('game.*vpcid|SsmParameterValuestackstestgamevpcid') },
      SecurityGroupIngress: [
        { IpProtocol: 'udp', FromPort: 40000, ToPort: 40019, CidrIp: '0.0.0.0/0', Description: 'WebRTC data channels' },
        { IpProtocol: 'udp', FromPort: 40000, ToPort: 40019, CidrIpv6: '::/0', Description: 'WebRTC data channels' },
      ],
      SecurityGroupEgress: [Match.objectLike({ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }), Match.objectLike({ IpProtocol: '-1', CidrIpv6: '::/0' })],
    });
    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });

  it('reads the shared network from SSM at deploy time (no lookups at synth)', () => {
    const { template, app } = synthGame();
    const params = Object.values(template.toJSON().Parameters as Record<string, { Type: string; Default?: string }>);
    const ssmDefaults = params.filter((p) => p.Type.startsWith('AWS::SSM::Parameter::Value')).map((p) => p.Default);
    for (const name of ['/stacks/test/game/vpc-id', '/stacks/test/game/subnet-ids', '/stacks/test/game/cluster-arn', '/stacks/test/game/alarm-topic-arn']) expect(ssmDefaults).toContain(name);
    expect(app.synth().manifest.missing ?? []).toEqual([]);
  });

  it('gives the task role the table, the game key and its own Event API, and nothing wider', () => {
    const { template } = synthGame();
    const task = statements(template, /GameServerTaskTaskRole/);
    expect(withAction(task, 'appsync:EventConnect')).toHaveLength(1);
    const channels = withAction(task, 'appsync:EventSubscribe');
    expect(channels).toHaveLength(1);
    expect(channels[0]!.Action).toEqual(['appsync:EventSubscribe', 'appsync:EventPublish']);
    expect(JSON.stringify(channels[0]!.Resource)).toContain('/channelNamespace/app');
    expect(JSON.stringify(task)).toContain('dynamodb:PutItem');
    expect(withAction(task, 'secretsmanager:GetSecretValue')).toHaveLength(1);
    expect(JSON.stringify(withAction(task, 'secretsmanager:GetSecretValue')[0]!.Resource)).toContain('GameKey');
    for (const s of task) expect(JSON.stringify(s.Action)).not.toMatch(/ecs:|iam:|ssm:|"\*"/);

    // The task role can't read the bundle (the API hands it a signed link) or anything in S3.
    for (const st of task) expect(JSON.stringify(st.Action)).not.toMatch(/s3:/);

    // The execution role only writes logs: the image is public, there is nothing to pull from ECR.
    const exec = statements(template, /GameServerTaskExecutionRole/);
    expect(exec.flatMap((s) => [s.Action].flat()).sort()).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
  });

  it('lets the server connect and subscribe with IAM on the Event API; browsers still use tokens', () => {
    const { template } = synthGame();
    template.hasResourceProperties('AWS::AppSync::Api', {
      EventConfig: Match.objectLike({
        ConnectionAuthModes: [{ AuthType: 'AWS_IAM' }, { AuthType: 'AWS_LAMBDA' }],
        DefaultSubscribeAuthModes: [{ AuthType: 'AWS_IAM' }, { AuthType: 'AWS_LAMBDA' }],
      }),
    });
    // The API Lambda may publish, not subscribe.
    expect(withAction(statements(template, /ApiHandlerServiceRole/), 'appsync:EventSubscribe')).toEqual([]);
  });

  it('lets the API Lambda run, stop and describe only this app\'s tasks on the shared cluster, and pass only the two task roles', () => {
    const { template } = synthGame();
    const api = statements(template, /ApiHandlerServiceRole/);
    const cluster = { ArnEquals: { 'ecs:cluster': { Ref: expect.stringMatching(/clusterarn/i) } } };

    const run = withAction(api, 'ecs:RunTask');
    expect(run).toHaveLength(1);
    expect(JSON.stringify(run[0]!.Resource)).toContain(':task-definition/stacks-test-app-hello-game:*');
    expect(run[0]!.Condition).toEqual(cluster);

    const stop = withAction(api, 'ecs:StopTask');
    expect(stop).toHaveLength(1);
    expect(stop[0]!.Action).toEqual(['ecs:StopTask', 'ecs:DescribeTasks']);
    expect(JSON.stringify(stop[0]!.Resource)).toContain(':task/stacks-test-games/*');
    expect(stop[0]!.Condition).toEqual({ ...cluster, StringEquals: { 'aws:ResourceTag/stacks:app': 'hello' } });

    const tag = withAction(api, 'ecs:TagResource');
    expect(tag[0]!.Condition).toEqual({ StringEquals: { 'ecs:CreateAction': 'RunTask', 'aws:RequestTag/stacks:app': 'hello' } });

    const pass = withAction(api, 'iam:PassRole');
    expect(pass).toHaveLength(1);
    expect(pass[0]!.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } });
    expect(JSON.stringify(pass[0]!.Resource)).toMatch(/GameServerTaskTaskRole.*GameServerTaskExecutionRole/);

    expect(withAction(api, 'ec2:DescribeNetworkInterfaces')).toHaveLength(1);
    // The two TURN parameters, and no other platform secret (the APNs key lives beside them).
    const ssmRead = withAction(api, 'ssm:GetParameter');
    expect(ssmRead).toHaveLength(1);
    const resources = JSON.stringify(ssmRead[0]!.Resource);
    expect(resources).toContain('parameter/stacks/test/secrets/platform/CLOUDFLARE_TURN_KEY_ID');
    expect(resources).toContain('parameter/stacks/test/secrets/platform/CLOUDFLARE_TURN_API_TOKEN');
    expect(resources).not.toContain('platform/*');
    expect(withAction(api, 'kms:Decrypt').map((st) => st.Condition)).toContainEqual({ StringEquals: { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com' } });
  });

  it('tells the API Lambda where to run tasks', () => {
    const { template } = synthGame();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          STACKS_GAME_CLUSTER_ARN: Match.anyValue(),
          STACKS_GAME_TASK_DEFINITION: 'stacks-test-app-hello-game',
          STACKS_GAME_CONTAINER: 'game',
          STACKS_GAME_SUBNET_IDS: Match.anyValue(),
          STACKS_GAME_SECURITY_GROUP: { 'Fn::GetAtt': [Match.stringLikeRegexp('GameServerSecurityGroup'), 'GroupId'] },
          STACKS_GAME_KEY_ARN: Match.anyValue(),
          STACKS_GAME_TURN_PREFIX: '/stacks/test/secrets/platform/',
        }),
      },
    });
  });

  it('alarms on a task alive past 3 hours, to the environment\'s topic', () => {
    const { template } = synthGame();
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '{ $.uptimeSeconds >= 10800 }',
      MetricTransformations: [Match.objectLike({ MetricNamespace: 'Stacks/test/GameServer', MetricName: 'hello-long-running', MetricValue: '1' })],
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'stacks-test-hello-game-server-long-running',
      Namespace: 'Stacks/test/GameServer',
      MetricName: 'hello-long-running',
      Statistic: 'Sum',
      Period: 300,
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: Match.stringLikeRegexp('alarmtopicarn') }],
    });
  });

  it('puts the staging boundary on every role, and passes the deploy gate', () => {
    const { template, app } = synthGame();
    const roles = Object.entries(template.findResources('AWS::IAM::Role'));
    expect(roles.map(([id]) => id).filter((id) => /GameServerTask/.test(id))).toHaveLength(2);
    for (const [id, r] of roles) expect(JSON.stringify(r.Properties.PermissionsBoundary), id).toContain('stacks-test-boundary');
    expect(checkAssemblyProblems(app)).toEqual([]);
  });

  it('adds none of it without the module', () => {
    for (const m of [manifest, { ...manifest, modules: ['realtime' as const] }]) {
      const { template } = synth('staging', envs.staging, m);
      for (const type of ['AWS::ECS::TaskDefinition', 'AWS::EC2::SecurityGroup', 'AWS::CloudWatch::Alarm']) template.resourceCountIs(type, 0);
      // (The API's own metric filters are monitoring's; none reads a game server's heartbeat.)
      expect(JSON.stringify(template.findResources('AWS::Logs::MetricFilter'))).not.toContain('uptimeSeconds');
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toMatch(/ecs:|STACKS_GAME|game-key|game\/vpc-id|"ConnectionAuthModes":\[\{"AuthType":"AWS_IAM"/);
    }
  });

  it('builds the production stack too: no boundary, a month of logs', () => {
    const { template } = synthGame('production');
    template.hasResourceProperties('AWS::ECS::TaskDefinition', { Family: 'stacks-prod-app-hello-game' });
    template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'stacks-prod-app-hello-game-key' });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'stacks-prod-hello-game-server-long-running' });
    expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).toContain('parameter/stacks/prod/secrets/platform/CLOUDFLARE_TURN_KEY_ID');
    const logGroups = Object.entries(template.findResources('AWS::Logs::LogGroup')).filter(([id]) => /GameServerLogs/.test(id));
    expect(logGroups[0]![1].Properties.RetentionInDays).toBe(30);
  });

  it('refuses gameServer without realtime', () => {
    expect(() => synthGame('staging', { ...manifest, modules: ['gameServer'] })).toThrow(/needs "realtime"/);
  });

  describe('the game bundle', () => {
    it('is a single-file asset, and the API may read that one object to sign links to it', () => {
      const { template, app } = synthGame();
      const api = statements(template, /ApiHandlerServiceRole/);
      const reads = withAction(api, 's3:GetObject');
      expect(reads).toHaveLength(1);
      // Exactly the bundle's key in the bootstrap's asset bucket: no wildcard over every app's code.
      const resource = JSON.stringify(reads[0]!.Resource);
      expect(resource).toContain('cdk-stktest-assets');
      // (`.mjs` in a real synth; these tests skip bundling, which stages the game folder as a zip.)
      expect(resource).toMatch(/\/[0-9a-f]{64}\.(mjs|zip)"/);
      expect(resource).not.toContain('/*');
      expect(withAction(api, 's3:GetObject*')).toEqual([]);
      expect(JSON.stringify(withAction(api, 's3:PutObject'))).toBe('[]');
      expect(withAction(api, 'kms:Decrypt').map((s) => s.Condition)).toContainEqual({ StringEquals: { 'kms:ViaService': 's3.us-east-1.amazonaws.com' } });
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: { Variables: Match.objectLike({ STACKS_GAME_BUNDLE_BUCKET: Match.anyValue(), STACKS_GAME_BUNDLE_KEY: Match.anyValue() }) },
      });
      const assets = JSON.parse(fs.readFileSync(path.join(app.synth().directory, 'stacks-test-app-hello.assets.json'), 'utf8'));
      expect(assets.dockerImages ?? {}).toEqual({});
    });

    it('bundles a real game into one runnable module (it starts, and asks for its room)', () => {
      const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-bundle-')), 'server.mjs');
      bundleGameServer({ repoRoot, appDir: path.join(repoRoot, 'apps/hello'), outfile: out });
      const size = fs.statSync(out).size;
      expect(size).toBeGreaterThan(100_000);
      expect(size).toBeLessThan(6_000_000);
      // Deterministic: the same sources give the same bytes, so the asset hash (and upload) is stable.
      const again = path.join(path.dirname(out), 'again.mjs');
      bundleGameServer({ repoRoot, appDir: path.join(repoRoot, 'apps/hello'), outfile: again });
      expect(fs.readFileSync(again).equals(fs.readFileSync(out))).toBe(true);
      // Runs as is under Node, and stops at the first thing only a real task has.
      const run = spawnSync(process.execPath, [out], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 20_000 });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('Missing required environment variable STACKS_ROOM_ID');
    });

    it('names the app when its game/server.ts is missing', () => {
      const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-nogame-'));
      expect(() => bundleGameServer({ repoRoot, appDir, outfile: path.join(appDir, 'x.mjs') })).toThrow(/no game\/server\.ts/);
    });
  });

  describe('the start script', () => {
    /** Serve `body` (or a status) on a local port, as S3 would through the signed link. */
    const serve = (respond: (n: number) => { status: number; body?: string }) =>
      new Promise<{ url: string; hits: () => number; close: () => void }>((resolve) => {
        let hits = 0;
        const server = http.createServer((_req, res) => {
          const r = respond(++hits);
          res.writeHead(r.status).end(r.body ?? '');
        });
        server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/bundle.mjs`, hits: () => hits, close: () => server.close() }));
      });
    const runScript = (env: Record<string, string>) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ['--enable-source-maps', '-e', GAME_BOOTSTRAP_SCRIPT], { env: { PATH: process.env.PATH ?? '', ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });

    it('fetches the bundle from the link and runs it as an ES module', async () => {
      const s = await serve(() => ({ status: 200, body: "import { platform } from 'node:os';\nconsole.log('game running on', platform(), typeof import.meta.url);\n" }));
      const r = await runScript({ [GAME_BUNDLE_URL_ENV]: s.url });
      s.close();
      expect(r.stdout).toContain('game running on');
      expect(r.stdout).toContain('string');
      expect(r.status).toBe(0);
    });

    it('retries a failed fetch, and fails the task after four tries', async () => {
      const flaky = await serve((n) => (n < 3 ? { status: 503 } : { status: 200, body: "console.log('third time lucky')" }));
      const ok = await runScript({ [GAME_BUNDLE_URL_ENV]: flaky.url });
      flaky.close();
      expect(ok.stdout).toContain('third time lucky');
      expect(flaky.hits()).toBe(3);

      const down = await serve(() => ({ status: 403 }));
      const failed = await runScript({ [GAME_BUNDLE_URL_ENV]: down.url });
      down.close();
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('Could not fetch the game bundle');
      expect(down.hits()).toBe(4);
    }, 20_000);

    it('refuses to start without a link (a task started by hand)', async () => {
      const r = await runScript({});
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`No ${GAME_BUNDLE_URL_ENV}`);
    });
  });

  describe('the deploy gate, on assets', () => {
    const tamper = (change: (assets: any) => void) => {
      const { app } = synthGame();
      const dir = app.synth().directory;
      const file = path.join(dir, 'stacks-test-app-hello.assets.json');
      const assets = JSON.parse(fs.readFileSync(file, 'utf8'));
      change(assets);
      fs.writeFileSync(file, JSON.stringify(assets));
      return checkAssembly(dir, 'stacks-test-app-hello');
    };

    it('refuses any container image (app stacks have none)', () => {
      const image = { source: { executable: ['sh', '-c', 'docker load -i "$1"', 'x', 'asset.tar'] }, destinations: {} };
      expect(tamper((a) => (a.dockerImages = { evil: image })).join()).toMatch(/app stacks have no container images/);
      expect(tamper((a) => (a.dockerImages = { built: { source: { directory: 'asset.x' }, destinations: {} } })).join()).toMatch(/app stacks have no container images/);
    });
    it('refuses a file asset that runs a command', () => {
      expect(tamper((a) => ((Object.values(a.files)[0] as { source: Record<string, unknown> }).source = { executable: ['sh', '-c', 'id'] })).join()).toMatch(/file assets may not run a command/);
    });
  });
});

function checkAssemblyProblems(app: cdk.App): string[] {
  const dir = app.synth().directory;
  return checkAssembly(dir, 'stacks-test-app-hello');
}

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

  it('lets staging deploy Event APIs and app Lambdas publish to them, and still never touch production', () => {
    const app = new cdk.App();
    const template = Template.fromStack(new CiStack(app, 'stacks-ci', { githubRepo: 'dashnash/stacks', region: 'us-east-1' }));
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'stacks-test-cfn-exec',
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'RealtimeEventApis', Effect: 'Allow', Action: 'appsync:*', Resource: '*' }),
          Match.objectLike({ Sid: 'NeverProduction', Effect: 'Deny', Action: '*', Condition: { StringEquals: { 'aws:ResourceTag/stacks:env': 'production' } } }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'stacks-test-boundary',
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'RealtimePublish', Effect: 'Allow', Action: ['appsync:EventConnect', 'appsync:EventPublish'] }),
          Match.objectLike({ Sid: 'NeverProduction', Effect: 'Deny', Action: '*' }),
        ]),
      },
    });
  });

  describe('gameServer module permissions (#44)', () => {
    const template = Template.fromStack(new CiStack(new cdk.App(), 'stacks-ci', { githubRepo: 'dashnash/stacks', region: 'us-east-1' }));
    const statements = (policyName: string): Array<Record<string, any>> => {
      const found = Object.values(template.findResources('AWS::IAM::ManagedPolicy', { Properties: { ManagedPolicyName: policyName } }));
      expect(found).toHaveLength(1);
      return found[0]!.Properties.PolicyDocument.Statement;
    };
    const statement = (policyName: string, sid: string) => {
      const s = statements(policyName).find((x) => x.Sid === sid);
      expect(s, `${policyName} ${sid}`).toBeDefined();
      return s!;
    };
    const neverProduction = { Sid: 'NeverProduction', Effect: 'Deny', Action: '*', Resource: '*', Condition: { StringEquals: { 'aws:ResourceTag/stacks:env': 'production' } } };

    it('lets staging deploys manage VPC resources, scoped by resource type', () => {
      const s = statement('stacks-test-cfn-exec', 'GameServerNetwork');
      expect(s).toMatchObject({ Effect: 'Allow', Action: 'ec2:*' });
      const resources = JSON.stringify(s.Resource);
      for (const type of ['vpc', 'subnet', 'internet-gateway', 'route-table', 'security-group', 'security-group-rule']) expect(resources).toContain(`:${type}/*`);
      expect(s.Resource).toHaveLength(6);
      expect(resources).not.toContain('instance');
      expect(statement('stacks-test-cfn-exec', 'GameServerNetworkRead')).toMatchObject({ Effect: 'Allow', Action: 'ec2:Describe*', Resource: '*' });
    });

    it('lets staging deploys manage ECS, and create only the ECS service-linked role', () => {
      expect(statement('stacks-test-cfn-exec', 'GameServerEcs')).toMatchObject({ Effect: 'Allow', Action: 'ecs:*', Resource: '*' });
      const slr = statement('stacks-test-cfn-exec', 'GameServerEcsServiceRole');
      expect(slr).toMatchObject({ Effect: 'Allow', Action: 'iam:CreateServiceLinkedRole', Condition: { StringEquals: { 'iam:AWSServiceName': 'ecs.amazonaws.com' } } });
      expect(JSON.stringify(slr.Resource)).toContain('role/aws-service-role/ecs.amazonaws.com/*');
    });

    it('lets staging deploys manage the alarm topic (stacks-test-* only) and CloudWatch alarms', () => {
      const topic = statement('stacks-test-cfn-exec', 'GameServerAlarmTopic');
      expect(topic).toMatchObject({ Effect: 'Allow', Action: 'sns:*' });
      expect(JSON.stringify(topic.Resource)).toContain(':stacks-test-*');
      expect(statement('stacks-test-cfn-exec', 'GameServerAlarms').Action).toEqual(
        expect.arrayContaining(['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms']),
      );
    });

    it('lets staging deploys pass only stacks-test-* roles', () => {
      const s = statement('stacks-test-cfn-exec', 'ManageStagingRoles');
      expect(s.Action).toContain('iam:PassRole');
      expect(JSON.stringify(s.Resource)).toContain('role/stacks-test-*');
    });

    it('lets app Lambdas run, stop and describe tasks and read their network interfaces', () => {
      expect(statement('stacks-test-boundary', 'GameServerTasks')).toMatchObject({
        Effect: 'Allow',
        Action: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks', 'ecs:TagResource', 'ec2:DescribeNetworkInterfaces'],
      });
    });

    it('lets app Lambdas pass stacks-test-* roles to ECS tasks and nothing else', () => {
      const s = statement('stacks-test-boundary', 'GameServerPassTaskRoles');
      expect(s).toMatchObject({ Effect: 'Allow', Action: 'iam:PassRole', Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } });
      expect(JSON.stringify(s.Resource)).toContain('role/stacks-test-*');
      // The only PassRole in the boundary is the conditioned one.
      const passers = statements('stacks-test-boundary').filter((x) => x.Effect === 'Allow' && JSON.stringify(x.Action).includes('iam:'));
      expect(passers.map((x) => x.Sid)).toEqual(['GameServerPassTaskRoles']);
    });

    it('lets game servers subscribe to their signaling channels, and pull nothing from ECR (they run a public image)', () => {
      expect(statement('stacks-test-boundary', 'GameServerSignaling')).toMatchObject({ Effect: 'Allow', Action: 'appsync:EventSubscribe' });
      expect(JSON.stringify(statements('stacks-test-boundary'))).not.toContain('ecr:');
    });

    it('still denies everything tagged production in both policies', () => {
      for (const policy of ['stacks-test-cfn-exec', 'stacks-test-boundary']) expect(statement(policy, 'NeverProduction')).toEqual(neverProduction);
    });
  });

  describe('production by name, not only by tag (#94)', () => {
    const names = stagingRecordNames(['test.dashnash.ninja', 'test.iamdashnash.com', 'Test.dashnash.ninja.']);
    const template = Template.fromStack(new CiStack(new cdk.App(), 'stacks-ci', { githubRepo: 'dashnash/stacks', region: 'us-east-1', stagingRecordNames: names }));
    const statements = (policyName: string, t = template): Array<Record<string, any>> =>
      Object.values(t.findResources('AWS::IAM::ManagedPolicy', { Properties: { ManagedPolicyName: policyName } }))[0]!.Properties.PolicyDocument.Statement;
    const actions = (s: Record<string, any>) => [s.Action].flat() as string[];
    const policies = ['stacks-test-cfn-exec', 'stacks-test-boundary'];
    const arn = (x: unknown) => JSON.stringify(x);

    it('derives each staging root and everything under it, once', () => {
      expect(names).toEqual(['test.dashnash.ninja', '*.test.dashnash.ninja', 'test.iamdashnash.com', '*.test.iamdashnash.com']);
    });

    it('allows S3 and SSM reads on no resource "*"', () => {
      for (const policy of policies) {
        for (const s of statements(policy).filter((x) => x.Effect === 'Allow' && x.Resource === '*')) {
          expect(actions(s).filter((a) => a === 's3:*' || a.startsWith('ssm:GetParameter')), `${policy} ${s.Sid}`).toEqual([]);
        }
      }
    });

    it('allows S3 only on staging and stktest buckets, and SSM reads only on staging parameters', () => {
      for (const policy of policies) {
        const buckets = statements(policy).find((x) => x.Sid === 'StagingBuckets')!;
        expect(buckets).toMatchObject({ Effect: 'Allow', Action: 's3:*' });
        expect(buckets.Resource).toHaveLength(4);
        expect(arn(buckets.Resource)).toContain(':s3:::stacks-test-*/*');
        expect(arn(buckets.Resource)).toContain(':s3:::cdk-stktest-*');
        expect(arn(buckets.Resource)).not.toContain('prod');
        const params = statements(policy).find((x) => x.Sid === 'StagingParametersRead')!;
        expect(params.Action).toEqual(['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath']);
        expect(arn(params.Resource)).toContain(':parameter/stacks/test/*');
        expect(arn(params.Resource)).toContain(':parameter/cdk-bootstrap/stktest/*');
        expect(arn(params.Resource)).not.toContain('prod');
      }
    });

    it('denies production buckets and parameters by name in both policies, next to the tag deny', () => {
      for (const policy of policies) {
        const deny = statements(policy).find((x) => x.Sid === 'NeverProductionByName')!;
        expect(deny).toMatchObject({ Effect: 'Deny', Action: ['s3:*', 'ssm:*'] });
        const resources = arn(deny.Resource);
        for (const r of [':s3:::stacks-prod-*"', ':s3:::stacks-prod-*/*', ':s3:::cdk-stkprod-*"', ':s3:::cdk-stkprod-*/*', ':parameter/stacks/prod/*', ':parameter/cdk-bootstrap/stkprod/*']) {
          expect(resources).toContain(r);
        }
        expect(statements(policy).find((x) => x.Sid === 'NeverProduction')).toMatchObject({ Effect: 'Deny', Action: '*' });
      }
    });

    it('lets staging change DNS records only under the staging names', () => {
      const exec = statements('stacks-test-cfn-exec');
      const changers = exec.filter((x) => x.Effect === 'Allow' && actions(x).some((a) => a === 'route53:ChangeResourceRecordSets' || a === 'route53:*'));
      expect(changers.map((x) => x.Sid)).toEqual(['StagingRecords']);
      expect(changers[0]!.Condition).toEqual({
        'ForAllValues:StringLike': { 'route53:ChangeResourceRecordSetsNormalizedRecordNames': names },
        Null: { 'route53:ChangeResourceRecordSetsNormalizedRecordNames': 'false' },
      });
      expect(arn(statements('stacks-test-boundary'))).not.toContain('route53');
    });

    it('takes the staging roots, legacy ones included, from the real stacks.config.json', () => {
      const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'stacks.config.json'), 'utf8'));
      const roots = stagingRootDomains(config.environments.staging);
      expect(roots[0]).toBe(config.environments.staging.rootDomain);
      expect(roots).toHaveLength(1 + (config.environments.staging.legacyRedirects ?? []).length);
      for (const root of roots) expect(stagingRecordNames(roots)).toEqual(expect.arrayContaining([root, `*.${root}`]));
      expect(roots).not.toContain(config.environments.production.rootDomain);
    });

    it('allows no DNS change at all without staging names', () => {
      const bare = Template.fromStack(new CiStack(new cdk.App(), 'stacks-ci', { githubRepo: 'dashnash/stacks', region: 'us-east-1' }));
      expect(arn(statements('stacks-test-cfn-exec', bare))).not.toContain('route53:ChangeResourceRecordSets');
    });
  });

  describe('monthly budget (#98)', () => {
    const ci = (budget?: { monthlyUsd: number; alertEmail: string }) =>
      Template.fromStack(new CiStack(new cdk.App(), 'stacks-ci', { githubRepo: 'dashnash/stacks', region: 'us-east-1', ...(budget ? { budget } : {}) }));

    it('emails at 80% of actual and 100% of forecast spend', () => {
      const t = ci({ monthlyUsd: 50, alertEmail: 'owner@example.com' });
      t.resourceCountIs('AWS::Budgets::Budget', 1);
      const subscribers = [{ SubscriptionType: 'EMAIL', Address: 'owner@example.com' }];
      t.hasResourceProperties('AWS::Budgets::Budget', {
        Budget: { BudgetName: BUDGET_NAME, BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 50, Unit: 'USD' } },
        NotificationsWithSubscribers: [
          { Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80, ThresholdType: 'PERCENTAGE' }, Subscribers: subscribers },
          { Notification: { NotificationType: 'FORECASTED', ComparisonOperator: 'GREATER_THAN', Threshold: 100, ThresholdType: 'PERCENTAGE' }, Subscribers: subscribers },
        ],
      });
    });

    it('has no budget without one configured', () => {
      ci().resourceCountIs('AWS::Budgets::Budget', 0);
    });

    it('is configured at 50 USD in stacks.config.json, and rejects a bad amount', () => {
      const file = path.join(repoRoot, 'stacks.config.json');
      expect(loadStacksConfig(file).budget).toEqual({ monthlyUsd: 50 });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-budget-'));
      const bad = path.join(dir, 'c.json');
      fs.writeFileSync(bad, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), budget: { monthlyUsd: 0 } }));
      expect(() => loadStacksConfig(bad)).toThrow(/budget.monthlyUsd must be a positive number/);
    });
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
