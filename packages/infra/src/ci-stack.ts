import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { bootstrapQualifier, STAGING_BOUNDARY_NAME, type EnvName } from './config';

export const STAGING_EXEC_POLICY_NAME = 'stacks-test-cfn-exec';
/** Read-only: the drift check compares the live staging policies with this stack (#101). */
export const DRIFT_CHECK_ROLE_NAME = 'stacks-ci-drift-check';
const GITHUB_OIDC = 'token.actions.githubusercontent.com';

export interface CiStackProps {
  /** `owner/repo` whose GitHub Actions may deploy. */
  githubRepo: string;
  /**
   * The start of the OIDC `sub` claim GitHub sends for this repo, before `:environment:<name>`.
   * Defaults to `repo:<owner>/<repo>`. Repos with GitHub's immutable subject claims send IDs instead,
   * e.g. `repo:dashnash@3804293/stacks@1449992124` (see `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`).
   */
  githubSubjectPrefix?: string;
  region: string;
  /** Reuse an existing GitHub OIDC provider in the account instead of creating one. */
  existingOidcProviderArn?: string;
  /**
   * DNS names staging deploys may create records for (#94): each staging root domain and
   * `*.<root>` (`stagingRecordNames()`). Without it staging may change no record at all.
   */
  stagingRecordNames?: string[];
  /**
   * The account-wide monthly cost budget (#98): email at 80% of actual and 100% of forecast spend.
   * Both or neither; without them there is no budget.
   */
  budget?: { monthlyUsd: number; alertEmail: string };
}

export const BUDGET_NAME = 'stacks-monthly';

/**
 * The staging root domains in a config: `rootDomain` and each legacy redirect's, or, for a legacy
 * redirect with `hosts`, only `<label>.<old>` for each label (the rest of the old root is not Stacks').
 */
export const stagingRootDomains = (env: { rootDomain: string; legacyRedirects?: Array<{ rootDomain: string; hosts?: string[] }> }) => [
  env.rootDomain,
  ...(env.legacyRedirects ?? []).flatMap((r) => (r.hosts?.length ? r.hosts.map((h) => `${h}.${r.rootDomain}`) : [r.rootDomain])),
];

/** The record names a staging deploy may write: each staging root domain (and legacy name), and everything under it (ACM validation records included). */
export const stagingRecordNames = (rootDomains: string[]) =>
  [...new Set(rootDomains.map((d) => d.toLowerCase().replace(/\.$/, '')))].flatMap((d) => [d, `*.${d}`]);

/**
 * Deployed once, by hand, with admin credentials. It lets GitHub Actions deploy without stored
 * keys and keeps staging away from production in a single account:
 *
 * - a GitHub OIDC provider and one role per environment, each trusted only by jobs running in
 *   that GitHub environment (`staging` / `production`, both limited to `main`);
 * - each role may only assume its own environment's CDK bootstrap roles (qualifier `stktest` / `stkprod`);
 * - `stacks-test-cfn-exec`: what CloudFormation may do for staging deploys (staging is bootstrapped
 *   with it instead of AdministratorAccess);
 * - `stacks-test-boundary`: the permissions boundary every role a staging deploy creates must carry;
 * - `stacks-ci-drift-check`: reads those two policies, from `main` only, to detect drift (#101).
 *
 * Both staging policies deny anything on resources tagged `stacks:env=production`, and (#94) name
 * production's buckets and parameters explicitly, because S3 buckets and hand-made SSM parameters
 * don't carry that tag where IAM can see it. S3 and SSM are allowed only on staging names, and
 * Route 53 changes only on staging record names.
 */
export class CiStack extends cdk.Stack {
  readonly roles: Record<EnvName, iam.Role>;

  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, {
      env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: props.region },
      synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: bootstrapQualifier('production') }),
      description: 'Stacks CI: GitHub OIDC deploy roles and staging guardrails',
    });
    cdk.Tags.of(this).add('stacks:env', 'production');

    const providerArn =
      props.existingOidcProviderArn ??
      new iam.OpenIdConnectProvider(this, 'GitHubOidc', { url: `https://${GITHUB_OIDC}`, clientIds: ['sts.amazonaws.com'] }).openIdConnectProviderArn;

    const subjectPrefix = props.githubSubjectPrefix ?? `repo:${props.githubRepo}`;
    const deployRole = (envName: EnvName, githubEnvironment: string) => {
      const role = new iam.Role(this, `${envName === 'production' ? 'Production' : 'Staging'}DeployRole`, {
        roleName: `stacks-ci-${envName}`,
        description: `GitHub Actions deploys to ${envName} (environment "${githubEnvironment}" only)`,
        maxSessionDuration: cdk.Duration.hours(1),
        assumedBy: new iam.WebIdentityPrincipal(providerArn, {
          StringEquals: {
            [`${GITHUB_OIDC}:aud`]: 'sts.amazonaws.com',
            [`${GITHUB_OIDC}:sub`]: `${subjectPrefix}:environment:${githubEnvironment}`,
          },
        }),
      });
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'AssumeOwnBootstrapRoles',
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-${bootstrapQualifier(envName)}-*`],
        }),
      );
      return role;
    };
    this.roles = { production: deployRole('production', 'production'), staging: deployRole('staging', 'staging') };

    const prodTagged = { StringEquals: { 'aws:ResourceTag/stacks:env': 'production' } };
    const boundaryArn = `arn:${this.partition}:iam::${this.account}:policy/${STAGING_BOUNDARY_NAME}`;
    const stagingRoles = `arn:${this.partition}:iam::${this.account}:role/stacks-test-*`;
    const buckets = (...prefixes: string[]) => prefixes.flatMap((p) => [`arn:${this.partition}:s3:::${p}`, `arn:${this.partition}:s3:::${p}/*`]);
    const parameters = (...paths: string[]) => paths.map((p) => `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/${p}`);
    // CDK names buckets after their stack (stacks-test-… / stacks-prod-…); the bootstrap's assets
    // bucket is cdk-<qualifier>-assets-…. CloudFormation resolves /cdk-bootstrap/<qualifier>/version.
    const stagingBuckets = buckets('stacks-test-*', 'cdk-stktest-*');
    const stagingParameters = parameters('stacks/test/*', 'cdk-bootstrap/stktest/*');
    const ssmRead = ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'];
    const neverProductionByName = () =>
      new iam.PolicyStatement({
        sid: 'NeverProductionByName',
        effect: iam.Effect.DENY,
        actions: ['s3:*', 'ssm:*'],
        resources: [...buckets('stacks-prod-*', 'cdk-stkprod-*'), ...parameters('stacks/prod/*', 'cdk-bootstrap/stkprod/*')],
      });
    const recordNames = props.stagingRecordNames ?? [];

    new iam.ManagedPolicy(this, 'StagingBoundary', {
      managedPolicyName: STAGING_BOUNDARY_NAME,
      description: 'Upper limit for every role created by a Stacks staging deploy',
      statements: [
        new iam.PolicyStatement({
          sid: 'AppRuntime',
          actions: [
            'dynamodb:*', 'logs:*', 'secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret',
            'kms:Decrypt', 'cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation',
            'lambda:InvokeFunction', 'lambda:GetFunction', 'events:PutEvents', 'xray:PutTraceSegments', 'xray:PutTelemetryRecords',
          ],
          resources: ['*'],
        }),
        // Only staging's buckets (#94): S3 ABAC is off, so the tag deny below doesn't reach buckets.
        new iam.PolicyStatement({ sid: 'StagingBuckets', actions: ['s3:*'], resources: stagingBuckets }),
        // Only staging's parameters (#94): production secrets are made by hand, without the tag.
        new iam.PolicyStatement({ sid: 'StagingParametersRead', actions: ssmRead, resources: stagingParameters }),
        // The `realtime` module: an app's API Lambda publishes to its own AppSync Event API over
        // HTTP (SigV4). The app stack scopes each grant to that one API.
        new iam.PolicyStatement({ sid: 'RealtimePublish', actions: ['appsync:EventConnect', 'appsync:EventPublish'], resources: ['*'] }),
        // The `gameServer` module (#44). An app's API Lambda starts and stops one Fargate task per
        // room and finds out whether it is still there; the task subscribes to its room's signaling
        // channels. (Tasks run a public image: no ECR pulls.) The app stack scopes each grant to
        // the app's own task definition, cluster, roles and Event API.
        new iam.PolicyStatement({
          sid: 'GameServerTasks',
          actions: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks', 'ecs:TagResource', 'ec2:DescribeNetworkInterfaces'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'GameServerPassTaskRoles',
          actions: ['iam:PassRole'],
          resources: [stagingRoles],
          conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        }),
        new iam.PolicyStatement({ sid: 'GameServerSignaling', actions: ['appsync:EventSubscribe'], resources: ['*'] }),
        new iam.PolicyStatement({ sid: 'NeverProduction', effect: iam.Effect.DENY, actions: ['*'], resources: ['*'], conditions: prodTagged }),
        neverProductionByName(),
      ],
    });

    new iam.ManagedPolicy(this, 'StagingExecPolicy', {
      managedPolicyName: STAGING_EXEC_POLICY_NAME,
      description: 'What CloudFormation may do for Stacks staging deploys (bootstrap qualifier stktest)',
      statements: [
        new iam.PolicyStatement({
          sid: 'StackServices',
          actions: [
            'cloudformation:*', 'dynamodb:*', 'lambda:*', 'cloudfront:*', 'apigateway:*', 'logs:*', 'events:*',
            'secretsmanager:*', 'ssm:DescribeParameters', 'acm:DescribeCertificate', 'acm:ListCertificates',
            'acm:RequestCertificate', 'acm:DeleteCertificate', 'acm:AddTagsToCertificate', 'route53:GetHostedZone',
            'route53:ListResourceRecordSets', 'route53:GetChange', 'kms:Decrypt',
            'cloudwatch:ListDashboards', 's3:ListAllMyBuckets', 's3:GetBucketLocation',
          ],
          resources: ['*'],
        }),
        // #94: buckets, parameters and DNS records by name, not `*`.
        new iam.PolicyStatement({ sid: 'StagingBuckets', actions: ['s3:*'], resources: stagingBuckets }),
        new iam.PolicyStatement({ sid: 'StagingParametersRead', actions: ssmRead, resources: stagingParameters }),
        ...(recordNames.length
          ? [
              new iam.PolicyStatement({
                sid: 'StagingRecords',
                actions: ['route53:ChangeResourceRecordSets'],
                resources: [`arn:${this.partition}:route53:::hostedzone/*`],
                // ForAllValues is vacuously true when the key is missing, so require it to be present.
                conditions: {
                  'ForAllValues:StringLike': { 'route53:ChangeResourceRecordSetsNormalizedRecordNames': recordNames },
                  Null: { 'route53:ChangeResourceRecordSetsNormalizedRecordNames': 'false' },
                },
              }),
            ]
          : []),
        // Monitoring (#75): the one staging dashboard. Dashboards carry no tags, so the name is the
        // limit (never `stacks-prod`). Metric filters and saved queries are `logs:*`, above.
        new iam.PolicyStatement({
          sid: 'MonitoringDashboard',
          actions: ['cloudwatch:PutDashboard', 'cloudwatch:DeleteDashboards', 'cloudwatch:GetDashboard'],
          resources: [`arn:${this.partition}:cloudwatch::${this.account}:dashboard/stacks-test`],
        }),
        // The `realtime` module: one AppSync Event API per app that turns it on (its channel
        // namespace, API keys and Lambda authorizer config). Production deploys with the default
        // bootstrap policy, which already covers this.
        new iam.PolicyStatement({ sid: 'RealtimeEventApis', actions: ['appsync:*'], resources: ['*'] }),
        // The `gameServer` module (#44): the shared VPC (public subnets, internet gateway, no NAT)
        // and ECS cluster in the platform stack; per app a task definition, a security group, a
        // metric filter + alarm on long-running tasks; one SNS topic for those alarms. Production
        // deploys with the default bootstrap policy (AdministratorAccess), which covers all of it.
        new iam.PolicyStatement({
          sid: 'GameServerNetwork',
          actions: ['ec2:*'],
          resources: ['vpc', 'subnet', 'internet-gateway', 'route-table', 'security-group', 'security-group-rule'].map(
            (type) => `arn:${this.partition}:ec2:${this.region}:${this.account}:${type}/*`,
          ),
        }),
        // EC2 Describe* calls cannot be scoped to a resource.
        new iam.PolicyStatement({ sid: 'GameServerNetworkRead', actions: ['ec2:Describe*'], resources: ['*'] }),
        new iam.PolicyStatement({ sid: 'GameServerEcs', actions: ['ecs:*'], resources: ['*'] }),
        // The first ECS cluster in an account creates the ECS service-linked role.
        new iam.PolicyStatement({
          sid: 'GameServerEcsServiceRole',
          actions: ['iam:CreateServiceLinkedRole'],
          resources: [`arn:${this.partition}:iam::${this.account}:role/aws-service-role/ecs.amazonaws.com/*`],
          conditions: { StringEquals: { 'iam:AWSServiceName': 'ecs.amazonaws.com' } },
        }),
        new iam.PolicyStatement({
          sid: 'GameServerAlarmTopic',
          actions: ['sns:*'],
          resources: [`arn:${this.partition}:sns:${this.region}:${this.account}:stacks-test-*`],
        }),
        new iam.PolicyStatement({
          sid: 'GameServerAlarms',
          actions: [
            'cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms',
            'cloudwatch:TagResource', 'cloudwatch:UntagResource', 'cloudwatch:ListTagsForResource',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'StagingParameters',
          actions: ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:AddTagsToResource'],
          resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/stacks/test/*`],
        }),
        new iam.PolicyStatement({
          sid: 'CreateBoundedStagingRoles',
          actions: ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:DeleteRolePolicy', 'iam:PutRolePermissionsBoundary'],
          resources: [stagingRoles],
          conditions: { StringEquals: { 'iam:PermissionsBoundary': boundaryArn } },
        }),
        new iam.PolicyStatement({
          sid: 'ManageStagingRoles',
          actions: ['iam:GetRole', 'iam:GetRolePolicy', 'iam:DeleteRole', 'iam:TagRole', 'iam:UntagRole', 'iam:PassRole', 'iam:UpdateAssumeRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies'],
          resources: [stagingRoles],
        }),
        new iam.PolicyStatement({ sid: 'NeverProduction', effect: iam.Effect.DENY, actions: ['*'], resources: ['*'], conditions: prodTagged }),
        neverProductionByName(),
        new iam.PolicyStatement({
          sid: 'KeepGuardrails',
          effect: iam.Effect.DENY,
          actions: ['iam:DeleteRolePermissionsBoundary', 'iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:SetDefaultPolicyVersion', 'iam:CreateUser', 'iam:CreateAccessKey'],
          resources: ['*'],
        }),
      ],
    });

    // #101: this stack is deployed by hand, so a merged guardrail change may never reach AWS. A
    // daily job on main (.github/workflows/ci-drift.yml) reads the two live policies with this
    // role and compares them with the synthesized ones. No `environment:` in that job, so GitHub
    // sends a ref-based subject: only main can assume it, never a PR.
    const driftRole = new iam.Role(this, 'DriftCheckRole', {
      roleName: DRIFT_CHECK_ROLE_NAME,
      description: 'GitHub Actions on main reads the staging guardrail policies to detect drift (read-only)',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: {
          [`${GITHUB_OIDC}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC}:sub`]: `${subjectPrefix}:ref:refs/heads/main`,
        },
      }),
    });
    driftRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadStagingGuardrails',
        actions: ['iam:GetPolicy', 'iam:GetPolicyVersion'],
        resources: [STAGING_BOUNDARY_NAME, STAGING_EXEC_POLICY_NAME].map((n) => `arn:${this.partition}:iam::${this.account}:policy/${n}`),
      }),
    );

    // A cost guardrail, not ops alerting (#98, compatible with pull-only monitoring #75): the
    // account has open sign-up, public APIs and game servers, and nothing else watches spend.
    if (props.budget) {
      const subscribers = [{ subscriptionType: 'EMAIL', address: props.budget.alertEmail }];
      const alert = (notificationType: 'ACTUAL' | 'FORECASTED', threshold: number) => ({
        notification: { notificationType, comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
        subscribers,
      });
      new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: { budgetName: BUDGET_NAME, budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: props.budget.monthlyUsd, unit: 'USD' } },
        notificationsWithSubscribers: [alert('ACTUAL', 80), alert('FORECASTED', 100)],
      });
    }

    new cdk.CfnOutput(this, 'StagingRoleArn', { value: this.roles.staging.roleArn });
    new cdk.CfnOutput(this, 'ProductionRoleArn', { value: this.roles.production.roleArn });
    new cdk.CfnOutput(this, 'DriftCheckRoleArn', { value: driftRole.roleArn });
  }
}
