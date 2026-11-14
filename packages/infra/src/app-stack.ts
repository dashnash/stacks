import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gameServerSettings, hasModule, secretParameterName, type AppManifest } from '@stacks/manifest';
import {
  aasaRoute,
  appOrigin,
  authOrigin,
  bootstrapQualifier,
  envTag,
  GAME_PORT_MAX,
  GAME_PORT_MIN,
  gameClusterName,
  platformSecretsPrefix,
  ssmNames,
  stackName,
  STAGING_BOUNDARY_NAME,
  type EnvConfig,
  type EnvName,
} from './config';
import { buildCsp } from './csp';

/**
 * CloudFront viewer-request function: every extension-less path serves index.html; files (with a
 * dot) are served as-is. Apps route with #hashes, so nothing more is needed.
 */
export const siteRouterCode = (env?: EnvConfig) => `
function handler(event) {
  var request = event.request;${env ? aasaRoute(env) : ''}
  if (request.uri.split('/').pop().indexOf('.') === -1) request.uri = '/index.html';
  return request;
}`;
/** The router without the iOS association file. */
export const SITE_ROUTER_CODE = siteRouterCode();

/** Requests per second (steady, burst) each app's API accepts across all callers. */
export const API_RATE_LIMIT = 25;
export const API_BURST_LIMIT = 50;

/**
 * The Event API's onPublish handler (APPSYNC_JS): drops any event over 4 KB, whoever sent it (the
 * SDKs never send one; this stops a hand-made client). Channel access is the Lambda authorizer's.
 */
export const REALTIME_ON_PUBLISH_CODE = `export function onPublish(ctx) {
  return ctx.events.filter((e) => JSON.stringify(e.payload).length <= 4096);
}
`;

/** The app channel namespace (the SDK's REALTIME_NAMESPACE). */
const REALTIME_NAMESPACE = 'app';

export interface AppStackProps {
  manifest: AppManifest;
  envName: EnvName;
  env: EnvConfig;
  region: string;
  /** Monorepo root (for bundling and the lockfile). */
  repoRoot: string;
  /** The app's folder, e.g. `<repo>/apps/book-club`. Its `api/index.ts` and `web/dist` are used. */
  appDir: string;
  /** Overrides for tests. */
  webDistPath?: string;
  apiEntry?: string;
  /** Override for tests: the folder uploaded to the content bucket. */
  contentDir?: string;
  /** Extra environment variables for the app's Lambda. */
  environment?: Record<string, string>;
  /**
   * The app's game server image as a `docker save` tarball (the `gameServer` module). Default
   * `<appDir>/game/dist/image.tar`, which `scripts/build-game-images.mjs` writes in the build job.
   */
  gameImageTarball?: string;
  /**
   * Fail when the tarball is missing (deploy builds). Otherwise a placeholder stands in, so
   * `cdk synth` works on a machine without Docker; a stack synthesized that way must not be deployed.
   */
  requireGameImage?: boolean;
}

/** The container in a game server task (RunTask overrides name it). */
export const GAME_CONTAINER_NAME = 'game';
/** A game server task alive this long trips the app's alarm. */
export const GAME_ALARM_AFTER_HOURS = 3;
/** Marks a placeholder image tarball (synth without Docker). */
export const GAME_IMAGE_PLACEHOLDER = 'stacks-game-image-placeholder';

/** A stand-in tarball for synth on a machine that hasn't built the image. Never deployable. */
function placeholderImageTarball(slug: string): string {
  const dir = path.join(tmpdir(), 'stacks-game-image-placeholder');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.tar`);
  writeFileSync(file, `${GAME_IMAGE_PLACEHOLDER}: run "npm run build-game-images -- ${slug}" (needs Docker) before deploying\n`);
  return file;
}

/**
 * Everything one app needs, from its manifest: a private S3 site behind CloudFront at
 * `<slug>.<rootDomain>`, its API on the same origin at `/api/*`, one Lambda, one DynamoDB single
 * table, and its credential for the Platform API. App folders normally contain no infra code.
 */
export class AppStack extends cdk.Stack {
  readonly table: dynamodb.Table;
  readonly handler: nodejs.NodejsFunction;
  readonly distribution: cloudfront.Distribution;
  readonly siteUrl: string;
  /** The app's AppSync Event API (manifest module `realtime`). */
  readonly eventApi?: appsync.EventApi;

  constructor(scope: Construct, props: AppStackProps) {
    const { manifest, envName, env } = props;
    super(scope, stackName(envName, 'app', manifest.slug), {
      env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: props.region },
      synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: bootstrapQualifier(envName) }),
      description: `Stacks app "${manifest.name}" (${envName})`,
    });
    if (props.region !== 'us-east-1') throw new Error('Stacks deploys to us-east-1 (CloudFront certificates must live there)');

    const isProd = envName === 'production';
    const slug = manifest.slug;
    const origin = appOrigin(env, slug);
    const auth = authOrigin(env);
    cdk.Tags.of(this).add('stacks:env', envName);
    cdk.Tags.of(this).add('stacks:app', slug);
    if (!isProd) iam.PermissionsBoundary.of(this).apply(iam.ManagedPolicy.fromManagedPolicyName(this, 'Boundary', STAGING_BOUNDARY_NAME));

    // 1. Data: one single table (PK/SK, GSI1, TTL on expiresAt for sessions).
    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt',
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    // 2. The app's credential for the Platform API; the platform reads it to check calls.
    const credential = new secretsmanager.Secret(this, 'PlatformCredential', {
      secretName: `stacks-${envTag(envName)}-app-${slug}-credential`,
      description: `Credential ${slug} presents to the Stacks Platform API`,
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });

    // 3. The API Lambda.
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    this.handler = new nodejs.NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: props.apiEntry ?? path.join(props.appDir, 'api/index.ts'),
      handler: 'handler',
      projectRoot: props.repoRoot,
      depsLockFilePath: path.join(props.repoRoot, 'package-lock.json'),
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true, target: 'node22' },
      environment: {
        TABLE_NAME: this.table.tableName,
        STACKS_APP_ORIGIN: origin,
        STACKS_AUTH_ORIGIN: auth,
        STACKS_PLATFORM_URL: `${auth}/api`,
        STACKS_APP_SECRET_ARN: credential.secretArn,
        ...(props.env.maintenance ? { STACKS_MAINTENANCE: '1' } : {}),
        NODE_OPTIONS: '--enable-source-maps',
        ...props.environment,
      },
    });
    this.table.grantReadWriteData(this.handler);
    credential.grantRead(this.handler);

    // Secrets the manifest declares: SecureString parameters an admin puts in by hand (never in
    // git or CI). The app may read only its own, under /stacks/<env>/secrets/<slug>/.
    if (manifest.secrets?.length) {
      const prefix = secretParameterName(envTag(envName), slug, '');
      this.handler.addEnvironment('STACKS_SECRETS_PREFIX', prefix);
      this.handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [cdk.Stack.of(this).formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${prefix.slice(1)}*` })],
        }),
      );
      // SecureStrings use the account's aws/ssm key; decrypting is allowed only through SSM.
      this.handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          resources: ['*'],
          conditions: { StringEquals: { 'kms:ViaService': `ssm.${cdk.Stack.of(this).region}.amazonaws.com` } },
        }),
      );
    }

    // contentPacks: a private bucket for media the app serves through short-lived links. Files in
    // apps/<slug>/content/ are uploaded on deploy; nothing is ever pruned, so media added
    // outside git (e.g. photos of people, uploaded through the app) stays. The Lambda can write
    // and delete there too (`contentStore().put/delete`).
    if (hasModule(manifest, 'contentPacks')) {
      const content = new s3.Bucket(this, 'ContentBucket', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: !isProd,
      });
      content.grantReadWrite(this.handler);
      this.handler.addEnvironment('CONTENT_BUCKET', content.bucketName);
      const contentDir = props.contentDir ?? path.join(props.appDir, 'content');
      if (existsSync(contentDir)) {
        new s3deploy.BucketDeployment(this, 'DeployContent', {
          sources: [s3deploy.Source.asset(contentDir, { exclude: ['*.md', '.*'] })],
          destinationBucket: content,
          prune: false,
          memoryLimit: 512,
        });
      }
      new cdk.CfnOutput(this, 'ContentBucketName', { value: content.bucketName });
    }

    // realtime: the app's own AppSync Event API. Browsers connect with short-lived tokens from the
    // app's POST /api/realtime/token, checked by a small Lambda authorizer (every connect,
    // subscribe and publish, never cached); the API Lambda publishes with IAM. One namespace.
    const gameServerOn = hasModule(manifest, 'gameServer');
    let realtimeHost: string | undefined;
    let realtimeConfig: Record<string, string> = {};
    if (hasModule(manifest, 'realtime')) {
      const key = new secretsmanager.Secret(this, 'RealtimeKey', {
        secretName: `stacks-${envTag(envName)}-app-${slug}-realtime-key`,
        description: `Signs ${slug}'s realtime tokens (the API mints them, the Event API's authorizer checks them)`,
        generateSecretString: { passwordLength: 64, excludePunctuation: true },
      });
      const authorizer = new nodejs.NodejsFunction(this, 'RealtimeAuthorizer', {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(props.repoRoot, 'packages/api/src/realtime-authorizer.ts'),
        handler: 'handler',
        projectRoot: props.repoRoot,
        depsLockFilePath: path.join(props.repoRoot, 'package-lock.json'),
        memorySize: 256,
        timeout: cdk.Duration.seconds(5),
        logGroup: new logs.LogGroup(this, 'RealtimeAuthorizerLogs', {
          retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        bundling: { minify: true, sourceMap: true, target: 'node22' },
        environment: { STACKS_REALTIME_KEY_ARN: key.secretArn, STACKS_REALTIME_NAMESPACE: REALTIME_NAMESPACE, NODE_OPTIONS: '--enable-source-maps' },
      });
      key.grantRead(authorizer);
      key.grantRead(this.handler);

      const eventApi = new appsync.EventApi(this, 'EventApi', {
        apiName: `stacks-${envTag(envName)}-${slug}`,
        authorizationConfig: {
          authProviders: [
            { authorizationType: appsync.AppSyncAuthorizationType.IAM },
            // No result caching: a token names exact channels, so each request is checked on its own.
            { authorizationType: appsync.AppSyncAuthorizationType.LAMBDA, lambdaAuthorizerConfig: { handler: authorizer, resultsCacheTtl: cdk.Duration.seconds(0) } },
          ],
          // Browsers connect and subscribe with tokens (Lambda). With the gameServer module the
          // room's server also does, with IAM: only its task role is granted that.
          connectionAuthModeTypes: [...(gameServerOn ? [appsync.AppSyncAuthorizationType.IAM] : []), appsync.AppSyncAuthorizationType.LAMBDA],
          defaultSubscribeAuthModeTypes: [...(gameServerOn ? [appsync.AppSyncAuthorizationType.IAM] : []), appsync.AppSyncAuthorizationType.LAMBDA],
          defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM, appsync.AppSyncAuthorizationType.LAMBDA],
        },
      });
      const namespace = eventApi.addChannelNamespace(REALTIME_NAMESPACE, {
        channelNamespaceName: REALTIME_NAMESPACE,
        code: appsync.Code.fromInline(REALTIME_ON_PUBLISH_CODE),
      });
      // HTTP publish (SigV4) from the API Lambda: this API's namespace only.
      namespace.grantPublish(this.handler);
      eventApi.grantConnect(this.handler);
      this.handler.addEnvironment('STACKS_REALTIME_HTTP_HOST', eventApi.httpDns);
      this.handler.addEnvironment('STACKS_REALTIME_WS_HOST', eventApi.realtimeDns);
      this.handler.addEnvironment('STACKS_REALTIME_NAMESPACE', REALTIME_NAMESPACE);
      this.handler.addEnvironment('STACKS_REALTIME_KEY_ARN', key.secretArn);
      realtimeHost = eventApi.realtimeDns;
      realtimeConfig = { http: `https://${eventApi.httpDns}/event`, realtime: `wss://${eventApi.realtimeDns}/event/realtime` };
      this.eventApi = eventApi;
      new cdk.CfnOutput(this, 'RealtimeEndpoint', { value: realtimeConfig.realtime! });
    }

    // gameServer: one Fargate task per room, started and stopped by the API Lambda, on the
    // platform's shared cluster and public subnets (a public IP per task; no load balancer, no NAT,
    // nothing running while nobody plays). Players reach it over WebRTC data channels on a fixed
    // UDP port range; the realtime module above carries the signaling.
    if (hasModule(manifest, 'gameServer')) {
      if (!this.eventApi) throw new Error(`${slug}: the "gameServer" module needs "realtime" in "modules" too`);
      const settings = gameServerSettings(manifest);
      const tag = envTag(envName);
      const game = ssmNames(envName).game;
      const vpcId = ssm.StringParameter.valueForStringParameter(this, game.vpcId);
      const subnetIds = ssm.StringParameter.valueForStringParameter(this, game.subnetIds);
      const clusterArn = ssm.StringParameter.valueForStringParameter(this, game.clusterArn);
      const alarmTopicArn = ssm.StringParameter.valueForStringParameter(this, game.alarmTopicArn);

      const gameKey = new secretsmanager.Secret(this, 'GameKey', {
        secretName: `stacks-${tag}-app-${slug}-game-key`,
        description: `Signs ${slug}'s game join tickets (the API mints them, the room's game server checks them)`,
        generateSecretString: { passwordLength: 64, excludePunctuation: true },
      });

      let tarball = props.gameImageTarball ?? path.join(props.appDir, 'game/dist/image.tar');
      if (!existsSync(tarball)) {
        if (props.requireGameImage) throw new Error(`${slug}: no game server image at ${tarball}. Build it first: npm run build-game-images -- ${slug}`);
        tarball = placeholderImageTarball(slug);
        cdk.Annotations.of(this).addWarning(`${slug}: no game server image built; using a placeholder. Do not deploy this assembly (run "npm run build-game-images -- ${slug}" first).`);
      }

      const gameLogs = new logs.LogGroup(this, 'GameServerLogs', {
        retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      const taskDefinition = new ecs.FargateTaskDefinition(this, 'GameServerTask', {
        family: `stacks-${tag}-app-${slug}-game`,
        cpu: settings.cpu,
        memoryLimitMiB: settings.memory,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      });
      taskDefinition.addContainer('GameServer', {
        containerName: GAME_CONTAINER_NAME,
        image: ecs.ContainerImage.fromTarball(tarball),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'room', logGroup: gameLogs }),
        // "Game over" goes out and results are written when ECS asks the task to stop.
        stopTimeout: cdk.Duration.seconds(30),
        environment: {
          TABLE_NAME: this.table.tableName,
          STACKS_APP: slug,
          STACKS_REALTIME_HTTP_HOST: this.eventApi.httpDns,
          STACKS_REALTIME_WS_HOST: this.eventApi.realtimeDns,
          STACKS_REALTIME_NAMESPACE: REALTIME_NAMESPACE,
          STACKS_GAME_KEY_ARN: gameKey.secretArn,
          STACKS_GAME_MAX_PLAYERS: String(settings.maxPlayers),
          STACKS_GAME_IDLE_MINUTES: String(settings.idleMinutes),
          STACKS_GAME_MAX_HOURS: String(settings.maxHours),
          STACKS_GAME_PORT_MIN: String(GAME_PORT_MIN),
          STACKS_GAME_PORT_MAX: String(GAME_PORT_MAX),
          NODE_OPTIONS: '--enable-source-maps',
        },
      });
      // The task role: the app's table, the game key, and the app's own Event API (it listens for
      // offers and publishes answers and room status with IAM).
      this.table.grantReadWriteData(taskDefinition.taskRole);
      gameKey.grantRead(taskDefinition.taskRole);
      const namespaceArn = `${this.eventApi.apiArn}/channelNamespace/${REALTIME_NAMESPACE}`;
      taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['appsync:EventConnect'], resources: [this.eventApi.apiArn] }));
      taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['appsync:EventSubscribe', 'appsync:EventPublish'], resources: [namespaceArn] }));
      // The execution role (pull the image, write logs) must exist before the Lambda can pass it.
      const executionRole = taskDefinition.obtainExecutionRole();

      // Inbound: the UDP port range from anywhere, and nothing else.
      const securityGroup = new ec2.CfnSecurityGroup(this, 'GameServerSecurityGroup', {
        groupDescription: `Stacks ${envName} ${slug} game servers: WebRTC data channels in, anything out`,
        vpcId,
        securityGroupIngress: [
          { ipProtocol: 'udp', fromPort: GAME_PORT_MIN, toPort: GAME_PORT_MAX, cidrIp: '0.0.0.0/0', description: 'WebRTC data channels' },
          { ipProtocol: 'udp', fromPort: GAME_PORT_MIN, toPort: GAME_PORT_MAX, cidrIpv6: '::/0', description: 'WebRTC data channels' },
        ],
        securityGroupEgress: [
          { ipProtocol: '-1', cidrIp: '0.0.0.0/0', description: 'Anything out' },
          { ipProtocol: '-1', cidrIpv6: '::/0', description: 'Anything out' },
        ],
      });

      // The API Lambda runs, stops and checks this app's tasks only: this task definition, this
      // cluster, and (to stop or describe) tasks tagged with this app.
      const taskArns = this.formatArn({ service: 'ecs', resource: 'task', resourceName: `${gameClusterName(envName)}/*` });
      const onCluster = { ArnEquals: { 'ecs:cluster': clusterArn } };
      this.handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ecs:RunTask'],
          resources: [this.formatArn({ service: 'ecs', resource: 'task-definition', resourceName: `${taskDefinition.family}:*` })],
          conditions: onCluster,
        }),
      );
      this.handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ecs:StopTask', 'ecs:DescribeTasks'],
          resources: [taskArns],
          conditions: { ...onCluster, StringEquals: { 'aws:ResourceTag/stacks:app': slug } },
        }),
      );
      this.handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ecs:TagResource'],
          resources: [taskArns],
          conditions: { StringEquals: { 'ecs:CreateAction': 'RunTask', 'aws:RequestTag/stacks:app': slug } },
        }),
      );
      this.handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [taskDefinition.taskRole.roleArn, executionRole.roleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        }),
      );
      // Describe calls can't be scoped to a resource.
      this.handler.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeNetworkInterfaces'], resources: ['*'] }));
      gameKey.grantRead(this.handler);
      // The platform's TURN key (two SecureStrings an admin stores once): these two and no other platform secret.
      const turnPrefix = platformSecretsPrefix(envName);
      this.handler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: ['CLOUDFLARE_TURN_KEY_ID', 'CLOUDFLARE_TURN_API_TOKEN'].map((name) => this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: `${turnPrefix.slice(1)}${name}` })),
        }),
      );
      this.handler.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: ['*'], conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } } }),
      );
      this.handler.addEnvironment('STACKS_GAME_CLUSTER_ARN', clusterArn);
      this.handler.addEnvironment('STACKS_GAME_TASK_DEFINITION', taskDefinition.family);
      this.handler.addEnvironment('STACKS_GAME_CONTAINER', GAME_CONTAINER_NAME);
      this.handler.addEnvironment('STACKS_GAME_SUBNET_IDS', subnetIds);
      this.handler.addEnvironment('STACKS_GAME_SECURITY_GROUP', securityGroup.attrGroupId);
      this.handler.addEnvironment('STACKS_GAME_KEY_ARN', gameKey.secretArn);
      this.handler.addEnvironment('STACKS_GAME_TURN_PREFIX', turnPrefix);
      // RunTask names the family, so it must wait for the first revision to exist.
      this.handler.node.addDependency(taskDefinition);

      // The cost guard's last line: every server logs a heartbeat with its uptime once a minute; a
      // metric filter counts the ones past 3 hours, and one of those is an alarm. (Rooms end by
      // themselves at `maxHours`, and the API stops stragglers; this catches both failing.)
      const longRunning = new logs.MetricFilter(this, 'GameServerLongRunning', {
        logGroup: gameLogs,
        filterPattern: logs.FilterPattern.numberValue('$.uptimeSeconds', '>=', GAME_ALARM_AFTER_HOURS * 3600),
        metricNamespace: `Stacks/${tag}/GameServer`,
        metricName: `${slug}-long-running`,
        metricValue: '1',
      });
      const alarm = new cloudwatch.Alarm(this, 'GameServerLongRunningAlarm', {
        alarmName: `stacks-${tag}-${slug}-game-server-long-running`,
        alarmDescription: `A ${slug} game server (${envName}) has been running for over ${GAME_ALARM_AFTER_HOURS} hours. Stop it in the ECS console (cluster ${gameClusterName(envName)}).`,
        metric: longRunning.metric({ statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction({ bind: () => ({ alarmActionArn: alarmTopicArn }) });

      new cdk.CfnOutput(this, 'GameServerTaskFamily', { value: taskDefinition.family });
      new cdk.CfnOutput(this, 'GameServerLogGroup', { value: gameLogs.logGroupName });
    }

    // 4. HTTP API, reached same-origin through CloudFront (no CORS). Throttled: some routes are public.
    const httpApi = new apigw.HttpApi(this, 'HttpApi');
    const stage = httpApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: API_RATE_LIMIT, throttlingBurstLimit: API_BURST_LIMIT };
    httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration('LambdaIntegration', this.handler),
    });
    const apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint));

    // 5. Domain: <slug>.<rootDomain> with the platform's wildcard certificate (read from SSM at deploy time).
    const domainName = `${slug}.${env.rootDomain}`;
    const useDomain = !!env.hostedZoneId;
    const certificate = useDomain
      ? acm.Certificate.fromCertificateArn(this, 'Certificate', ssm.StringParameter.valueForStringParameter(this, ssmNames(envName).certificateArn))
      : undefined;

    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(siteRouterCode(props.env)),
    });
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `stacks ${envTag(envName)} ${slug}`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'SiteHeaders', {
          comment: `Security headers for ${slug} (${envName})`,
          securityHeadersBehavior: {
            contentSecurityPolicy: { contentSecurityPolicy: buildCsp(manifest, { authOrigin: auth, ...(realtimeHost ? { connectSrc: [`wss://${realtimeHost}`] } : {}) }), override: true },
            strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: false, override: true },
            contentTypeOptions: { override: true },
            frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
            referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
          },
        }),
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiDomain, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Forwards cookies (the session) and the query string; not Host, which API Gateway needs as its own.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: 'index.html',
      ...(useDomain && certificate ? { domainNames: [domainName], certificate } : {}),
    });

    if (useDomain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: env.hostedZoneId,
        zoneName: env.hostedZoneName ?? env.rootDomain,
      });
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution));
      new route53.ARecord(this, 'AliasRecord', { zone, recordName: domainName, target });
      new route53.AaaaRecord(this, 'AliasRecordIpv6', { zone, recordName: domainName, target });
    }

    // 6. The SPA. Hashed assets/ are immutable and never pruned (open tabs keep working across
    //    deploys); everything else is no-cache and goes up after them. config.json is written
    //    here so one build serves every environment.
    const webDist = props.webDistPath ?? path.join(props.appDir, 'web/dist');
    const assets = new s3deploy.BucketDeployment(this, 'DeployWebAssets', {
      sources: [s3deploy.Source.asset(path.join(webDist, 'assets'))],
      destinationBucket: webBucket,
      destinationKeyPrefix: 'assets/',
      prune: false,
      cacheControl: [s3deploy.CacheControl.setPublic(), s3deploy.CacheControl.maxAge(cdk.Duration.days(365)), s3deploy.CacheControl.immutable()],
      memoryLimit: 512,
    });
    const site = new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [
        s3deploy.Source.asset(webDist, { exclude: ['assets', 'assets/**'] }),
        s3deploy.Source.jsonData('config.json', {
          app: slug,
          name: manifest.name,
          env: envName,
          authOrigin: auth,
          ...(realtimeHost ? { realtime: realtimeConfig } : {}),
        }),
      ],
      destinationBucket: webBucket,
      exclude: ['assets/*'],
      cacheControl: [s3deploy.CacheControl.noCache()],
      distribution: this.distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
    });
    site.node.addDependency(assets);

    // 7. Register with the platform: it reads these to list the app, check its credential and end sessions.
    const manifestJson = JSON.stringify(manifest);
    if (manifestJson.length > 4000) throw new Error(`${slug}: app.manifest.json is ${manifestJson.length} characters; the registry allows 4000`);
    new ssm.StringParameter(this, 'RegistryManifest', { parameterName: `/stacks/${envTag(envName)}/apps/${slug}/manifest`, stringValue: manifestJson });
    new ssm.StringParameter(this, 'RegistryTable', { parameterName: `/stacks/${envTag(envName)}/apps/${slug}/table`, stringValue: this.table.tableName });

    this.siteUrl = useDomain ? origin : `https://${this.distribution.distributionDomainName}`;
    new cdk.CfnOutput(this, 'SiteURL', { value: this.siteUrl });
    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
    new cdk.CfnOutput(this, 'CredentialSecretArn', { value: credential.secretArn });
  }
}
