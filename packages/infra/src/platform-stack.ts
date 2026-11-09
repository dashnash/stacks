import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { API_BURST_LIMIT, API_RATE_LIMIT } from './app-stack';
import { authOrigin, bootstrapQualifier, envTag, ssmNames, stackName, STAGING_BOUNDARY_NAME, type EnvConfig, type EnvName } from './config';

/** The portal needs Google Identity Services; nothing else may load from elsewhere. */
export const PORTAL_CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' https: data: blob:",
  "connect-src 'self' https://accounts.google.com/gsi/",
  'frame-src https://accounts.google.com/gsi/',
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Viewer-request function: the bare domain redirects to the portal; extension-less paths serve the SPA. */
export const portalRouterCode = (rootDomain: string) => `
function handler(event) {
  var request = event.request;
  var host = request.headers.host && request.headers.host.value;
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
    if (certificate) new ssm.StringParameter(this, 'CertificateArnParam', { parameterName: ssmNames(envName).certificateArn, stringValue: certificate.certificateArn });

    // 2. Users, grants, master sessions, codes, notifications, the central audit feed.
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

    // 3. The Platform API.
    this.handler = new nodejs.NodejsFunction(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: props.apiEntry ?? path.join(props.repoRoot, 'platform/api/src/lambda.ts'),
      handler: 'handler',
      projectRoot: props.repoRoot,
      depsLockFilePath: path.join(props.repoRoot, 'package-lock.json'),
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: isProd ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: true, target: 'node22' },
      environment: {
        TABLE_NAME: this.table.tableName,
        STACKS_ENV_TAG: tag,
        STACKS_ROOT_DOMAIN: env.rootDomain,
        GOOGLE_CLIENT_ID: env.googleClientId,
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
    httpApi.addRoutes({ path: '/authorize', methods: [apigw.HttpMethod.GET], integration });
    httpApi.addRoutes({ path: '/logout', methods: [apigw.HttpMethod.GET], integration });
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
      code: cloudfront.FunctionCode.fromInline(portalRouterCode(env.rootDomain)),
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

    new cdk.CfnOutput(this, 'PortalURL', { value: useDomain ? authOrigin(env) : `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
  }
}
