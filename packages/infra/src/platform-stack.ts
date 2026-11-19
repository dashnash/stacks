import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
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
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { API_BURST_LIMIT, API_RATE_LIMIT } from './app-stack';
import { addRouteThrottles, PLATFORM_ROUTE_THROTTLES } from './throttles';
import { addApiMetricFilters, logGroupName, Monitoring } from './monitoring';
import { aasaRoute, authOrigin, bootstrapQualifier, envTag, gameAlarmTopicName, gameClusterName, ssmNames, stackName, STAGING_BOUNDARY_NAME, type EnvConfig, type EnvName } from './config';

/** The portal needs Google Identity Services; nothing else may load from elsewhere. */
/** AWS Backup for production tables (#97). */
export const BACKUP_VAULT_NAME = 'stacks-prod-backups';
export const BACKUP_PLAN_NAME = 'stacks-prod-monthly';
export const BACKUP_RETENTION_DAYS = 365;

export const PORTAL_CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client https://appleid.cdn-apple.com",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' https: data: blob:",
  "connect-src 'self' https://accounts.google.com/gsi/ https://appleid.apple.com",
  'frame-src https://accounts.google.com/gsi/ https://appleid.apple.com',
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Viewer-request function: the bare domain redirects to the portal; extension-less paths serve the SPA. */
export const portalRouterCode = (rootDomain: string, env?: EnvConfig) => `
function handler(event) {
  var request = event.request;
  var host = request.headers.host && request.headers.host.value;${env ? aasaRoute(env) : ''}
  if (host === '${rootDomain}') {
    return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: 'https://auth.${rootDomain}' + request.uri } } };
  }
  if (request.uri.split('/').pop().indexOf('.') === -1) request.uri = '/index.html';
  return request;
}`;

export interface PlatformStackProps {
  envName: EnvName;
  env: EnvConfig;
  region: string;
  repoRoot: string;
  /** Overrides for tests. */
  webDistPath?: string;
  apiEntry?: string;
  /** The commit being deployed, stamped on every log line (`STACKS_BUILD_SHA`). The deploy workflows pass it. */
  buildSha?: string;
  /** This environment's apps: the dashboard's log tables and the saved queries read their log groups. */
  appSlugs?: string[];
}

/**
 * The platform: the portal and sign-in at `auth.<rootDomain>` (the bare domain redirects there),
 * the Platform API, the platform table, and the wildcard certificate every app uses.
 */
export class PlatformStack extends cdk.Stack {
  readonly table: dynamodb.Table;
  readonly handler: nodejs.NodejsFunction;

  constructor(scope: Construct, props: PlatformStackProps) {
    const { envName, env } = props;
    super(scope, stackName(envName, 'platform'), {
      env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: props.region },
      synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: bootstrapQualifier(envName) }),
      description: `Stacks platform (${envName})`,
    });
    const isProd = envName === 'production';
    const tag = envTag(envName);
    cdk.Tags.of(this).add('stacks:env', envName);
    if (!isProd) iam.PermissionsBoundary.of(this).apply(iam.ManagedPolicy.fromManagedPolicyName(this, 'Boundary', STAGING_BOUNDARY_NAME));

    // 1. The wildcard certificate for every app and the portal, shared through SSM.
    const useDomain = !!env.hostedZoneId;
    const zone = useDomain
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: env.hostedZoneId, zoneName: env.hostedZoneName ?? env.rootDomain })
      : undefined;
    const certificate = zone
      ? new acm.Certificate(this, 'WildcardCertificate', {
          domainName: `*.${env.rootDomain}`,
          subjectAlternativeNames: [env.rootDomain],
          validation: acm.CertificateValidation.fromDns(zone),
        })
      : undefined;
    // Retained, so a domain move (which replaces it) never waits on deleting the old one: the app
    // distributions still use it until their stacks deploy, after this one (docs/DOMAIN_MOVE.md
    // deletes it by hand afterwards).
    certificate?.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    if (certificate) new ssm.StringParameter(this, 'CertificateArnParam', { parameterName: ssmNames(envName).certificateArn, stringValue: certificate.certificateArn });

    // 1b. The game network (the `gameServer` module): one small VPC with two public subnets and an
    //     internet gateway (no NAT gateway, so nothing here costs anything while no game runs), an
    //     ECS cluster for the per-room Fargate tasks, and the topic their alarms go to. App stacks
    //     read the IDs from SSM at deploy time, like the certificate.
    const gameVpc = new ec2.Vpc(this, 'GameVpc', {
      vpcName: `stacks-${tag}-games`,
      ipAddresses: ec2.IpAddresses.cidr(isProd ? '10.44.0.0/16' : '10.45.0.0/16'),
      // Named, not looked up: synth needs no AWS credentials.
      availabilityZones: [`${props.region}a`, `${props.region}b`],
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      // The default would add a custom-resource Lambda just to empty a security group nothing uses.
      restrictDefaultSecurityGroup: false,
    });
    const gameCluster = new ecs.Cluster(this, 'GameCluster', {
      clusterName: gameClusterName(envName),
      vpc: gameVpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });
    const gameAlarms = new sns.Topic(this, 'GameAlarms', {
      topicName: gameAlarmTopicName(envName),
      displayName: `Stacks ${envName}: a game server has been running too long`,
    });
    const gameNames = ssmNames(envName).game;
    new ssm.StringParameter(this, 'GameVpcIdParam', { parameterName: gameNames.vpcId, stringValue: gameVpc.vpcId });
    new ssm.StringParameter(this, 'GameSubnetIdsParam', { parameterName: gameNames.subnetIds, stringValue: cdk.Fn.join(',', gameVpc.publicSubnets.map((sn) => sn.subnetId)) });
    new ssm.StringParameter(this, 'GameClusterArnParam', { parameterName: gameNames.clusterArn, stringValue: gameCluster.clusterArn });
    new ssm.StringParameter(this, 'GameAlarmTopicArnParam', { parameterName: gameNames.alarmTopicArn, stringValue: gameAlarms.topicArn });
    new cdk.CfnOutput(this, 'GameAlarmTopicArn', { value: gameAlarms.topicArn });

    // 2. Users, grants, master sessions, codes, notifications, the central audit feed.
    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Both environments (#97): staging too, so restores are rehearsed on the real path (docs/RESTORE.md).
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt',
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    // Monthly backups of every production table, kept a year (#97). PITR covers 35 days; this is
    // the longer tail. Production only (staging data is disposable). Restores: docs/RESTORE.md.
    if (isProd) {
      const vault = new backup.BackupVault(this, 'BackupVault', { backupVaultName: BACKUP_VAULT_NAME, removalPolicy: cdk.RemovalPolicy.RETAIN });
      const plan = new backup.BackupPlan(this, 'BackupPlan', {
        backupPlanName: BACKUP_PLAN_NAME,
        backupVault: vault,
        backupPlanRules: [
          new backup.BackupPlanRule({
            ruleName: 'Monthly',
            scheduleExpression: events.Schedule.cron({ minute: '0', hour: '5', day: '1', month: '*', year: '*' }),
            deleteAfter: cdk.Duration.days(BACKUP_RETENTION_DAYS),
          }),
        ],
      });
      const role = new iam.Role(this, 'BackupRole', {
        assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForBackup'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForRestores'),
        ],
      });
      // Every DynamoDB table tagged stacks:env=production (the platform's and each app's), and
      // nothing else: tags alone would also pick up buckets. Resources AND conditions must match.
      new backup.CfnBackupSelection(this, 'BackupTables', {
        backupPlanId: plan.backupPlanId,
        backupSelection: {
          selectionName: 'production-tables',
          iamRoleArn: role.roleArn,
          resources: [this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: '*' })],
          conditions: { StringEquals: [{ ConditionKey: 'aws:ResourceTag/stacks:env', ConditionValue: 'production' }] },
        },
      });
    }

    // 3. The Platform API.
    const apiLogs = new logs.LogGroup(this, 'ApiLogs', {
      logGroupName: logGroupName(tag, 'platform'),
      retention: isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    addApiMetricFilters(this, apiLogs, tag);
    this.handler = new nodejs.NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: props.apiEntry ?? path.join(props.repoRoot, 'platform/api/src/lambda.ts'),
      handler: 'handler',
      projectRoot: props.repoRoot,
      depsLockFilePath: path.join(props.repoRoot, 'package-lock.json'),
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      logGroup: apiLogs,
      loggingFormat: lambda.LoggingFormat.JSON,
      bundling: { minify: true, sourceMap: true, target: 'node22' },
      environment: {
        TABLE_NAME: this.table.tableName,
        STACKS_ENV_TAG: tag,
        ...(props.buildSha ? { STACKS_BUILD_SHA: props.buildSha } : {}),
        STACKS_ROOT_DOMAIN: env.rootDomain,
        GOOGLE_CLIENT_ID: env.googleClientId,
        GOOGLE_IOS_CLIENT_IDS: (env.native?.googleIosClientIds ?? []).join(','),
        MIN_SHELL_VERSION: env.native?.minShellVersion ?? '1.0.0',
        ...(env.native ? { IOS_BUNDLE_ID: env.native.iosBundleId, APPLE_TEAM_ID: env.native.appleTeamId } : {}),
        ...(env.appleServicesId ? { APPLE_SERVICES_ID: env.appleServicesId } : {}),
        // The APNs key (docs/IOS_SETUP.md): SecureStrings an admin puts here by hand, never in git or CI.
        PLATFORM_SECRETS_PREFIX: `/stacks/${tag}/secrets/platform/`,
        PLATFORM_ADMINS: env.platformAdmins.join(','),
        ...(env.maintenance ? { STACKS_MAINTENANCE: '1' } : {}),
        NODE_OPTIONS: '--enable-source-maps',
      },
    });
    this.table.grantReadWriteData(this.handler);
    const arn = (service: string, resource: string) => `arn:${this.partition}:${service}:${this.region}:${this.account}:${resource}`;
    // The app registry each app stack writes, and each app's credential.
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParametersByPath'], resources: [arn('ssm', `parameter/stacks/${tag}/apps`), arn('ssm', `parameter/stacks/${tag}/apps/*`)] }),
    );
    this.handler.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [arn('secretsmanager', `secret:stacks-${tag}-app-*`)] }));
    // The platform's own secrets (the APNs key), decrypted only through SSM. No app can read them:
    // apps read /stacks/<env>/secrets/<slug>/, and "platform" is a reserved slug.
    this.handler.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameters'], resources: [arn('ssm', `parameter/stacks/${tag}/secrets/platform/*`)] }));
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: ['*'], conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } } }),
    );
    // Ending a user's sessions inside apps (revocation, sign-out everywhere): only session items.
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:DeleteItem'],
        resources: [arn('dynamodb', `table/stacks-${tag}-app-*`), arn('dynamodb', `table/stacks-${tag}-app-*/index/GSI1`)],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*', 'USERSESSIONS#*'] } },
      }),
    );

    const httpApi = new apigw.HttpApi(this, 'HttpApi');
    const stage = httpApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: API_RATE_LIMIT * 2, throttlingBurstLimit: API_BURST_LIMIT * 2 };
    const integration = new integrations.HttpLambdaIntegration('LambdaIntegration', this.handler);
    httpApi.addRoutes({ path: '/api/{proxy+}', methods: [apigw.HttpMethod.ANY], integration });
    httpApi.addRoutes({ path: '/logout', methods: [apigw.HttpMethod.GET], integration });
    // Sign-in (incl. GET /authorize), access requests and error reports get their own, lower caps (#102).
    addRouteThrottles(httpApi, stage, integration, PLATFORM_ROUTE_THROTTLES);
    const apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint));

    // 4. The portal site: auth.<rootDomain>, plus the bare domain (redirects to it).
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const router = new cloudfront.Function(this, 'PortalRouter', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(portalRouterCode(env.rootDomain, env)),
    });
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: new origins.HttpOrigin(apiDomain, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };
    const authHost = `auth.${env.rootDomain}`;
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `stacks ${tag} portal`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'PortalHeaders', {
          comment: `Security headers for the Stacks portal (${envName})`,
          securityHeadersBehavior: {
            contentSecurityPolicy: { contentSecurityPolicy: PORTAL_CSP, override: true },
            strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: false, override: true },
            contentTypeOptions: { override: true },
            frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
            referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
          },
        }),
        functionAssociations: [{ function: router, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: { '/api/*': apiBehavior, '/authorize': apiBehavior, '/logout': apiBehavior },
      defaultRootObject: 'index.html',
      ...(certificate ? { domainNames: [authHost, env.rootDomain], certificate } : {}),
    });
    if (zone) {
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
      for (const [id, recordName] of [['Auth', authHost], ['Apex', env.rootDomain]] as const) {
        new route53.ARecord(this, `${id}Record`, { zone, recordName, target });
        new route53.AaaaRecord(this, `${id}RecordIpv6`, { zone, recordName, target });
      }
    }

    const webDist = props.webDistPath ?? path.join(props.repoRoot, 'platform/web/dist');
    const assets = new s3deploy.BucketDeployment(this, 'DeployWebAssets', {
      sources: [s3deploy.Source.asset(path.join(webDist, 'assets'))],
      destinationBucket: webBucket,
      destinationKeyPrefix: 'assets/',
      prune: false,
      cacheControl: [s3deploy.CacheControl.setPublic(), s3deploy.CacheControl.maxAge(cdk.Duration.days(365)), s3deploy.CacheControl.immutable()],
      memoryLimit: 512,
    });
    const site = new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [s3deploy.Source.asset(webDist, { exclude: ['assets', 'assets/**'] })],
      destinationBucket: webBucket,
      exclude: ['assets/*'],
      cacheControl: [s3deploy.CacheControl.noCache()],
      distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
    });
    site.node.addDependency(assets);

    // 5. Monitoring: the environment's one dashboard and its saved queries. No alarms (#75).
    const monitoring = new Monitoring(this, { tag, appSlugs: props.appSlugs ?? [] });
    new cdk.CfnOutput(this, 'DashboardName', { value: monitoring.dashboard.dashboardName });

    new cdk.CfnOutput(this, 'PortalURL', { value: useDomain ? authOrigin(env) : `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
  }
}
