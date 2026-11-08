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
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import type { AppManifest } from '@stacks/manifest';
import {
  appOrigin,
  authOrigin,
  bootstrapQualifier,
  envTag,
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
export const SITE_ROUTER_CODE = `
function handler(event) {
  var request = event.request;
  if (request.uri.split('/').pop().indexOf('.') === -1) request.uri = '/index.html';
  return request;
}`;

/** Requests per second (steady, burst) each app's API accepts across all callers. */
export const API_RATE_LIMIT = 25;
export const API_BURST_LIMIT = 50;

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
  /** Extra environment variables for the app's Lambda. */
  environment?: Record<string, string>;
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
        NODE_OPTIONS: '--enable-source-maps',
        ...props.environment,
      },
    });
    this.table.grantReadWriteData(this.handler);
    credential.grantRead(this.handler);

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
      code: cloudfront.FunctionCode.fromInline(SITE_ROUTER_CODE),
    });
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `stacks ${envTag(envName)} ${slug}`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'SiteHeaders', {
          comment: `Security headers for ${slug} (${envName})`,
          securityHeadersBehavior: {
            contentSecurityPolicy: { contentSecurityPolicy: buildCsp(manifest, { authOrigin: auth }), override: true },
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
        s3deploy.Source.jsonData('config.json', { app: slug, name: manifest.name, env: envName, authOrigin: auth, portalBar: manifest.portalBar ?? 'minimized' }),
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
