import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { bootstrapQualifier, STAGING_BOUNDARY_NAME, type EnvName } from './config';

export const STAGING_EXEC_POLICY_NAME = 'stacks-test-cfn-exec';
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
}

/**
 * Deployed once, by hand, with admin credentials. It lets GitHub Actions deploy without stored
 * keys and keeps staging away from production in a single account:
 *
 * - a GitHub OIDC provider and one role per environment, each trusted only by jobs running in
 *   that GitHub environment (`staging` / `production`, both limited to `main`);
 * - each role may only assume its own environment's CDK bootstrap roles (qualifier `stktest` / `stkprod`);
 * - `stacks-test-cfn-exec`: what CloudFormation may do for staging deploys (staging is bootstrapped
 *   with it instead of AdministratorAccess);
 * - `stacks-test-boundary`: the permissions boundary every role a staging deploy creates must carry.
 *
 * Both staging policies deny anything on resources tagged `stacks:env=production`.
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

    new iam.ManagedPolicy(this, 'StagingBoundary', {
      managedPolicyName: STAGING_BOUNDARY_NAME,
      description: 'Upper limit for every role created by a Stacks staging deploy',
      statements: [
        new iam.PolicyStatement({
          sid: 'AppRuntime',
          actions: [
            'dynamodb:*', 's3:*', 'logs:*', 'secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret',
            'ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'kms:Decrypt', 'cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation',
            'lambda:InvokeFunction', 'lambda:GetFunction', 'events:PutEvents', 'xray:PutTraceSegments', 'xray:PutTelemetryRecords',
          ],
          resources: ['*'],
        }),
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
      ],
    });

    new iam.ManagedPolicy(this, 'StagingExecPolicy', {
      managedPolicyName: STAGING_EXEC_POLICY_NAME,
      description: 'What CloudFormation may do for Stacks staging deploys (bootstrap qualifier stktest)',
      statements: [
        new iam.PolicyStatement({
          sid: 'StackServices',
          actions: [
            'cloudformation:*', 'dynamodb:*', 'lambda:*', 's3:*', 'cloudfront:*', 'apigateway:*', 'logs:*', 'events:*',
            'secretsmanager:*', 'ssm:GetParameter*', 'ssm:DescribeParameters', 'acm:DescribeCertificate', 'acm:ListCertificates',
            'acm:RequestCertificate', 'acm:DeleteCertificate', 'acm:AddTagsToCertificate', 'route53:GetHostedZone',
            'route53:ListResourceRecordSets', 'route53:ChangeResourceRecordSets', 'route53:GetChange', 'kms:Decrypt',
            'cloudwatch:ListDashboards',
          ],
          resources: ['*'],
        }),
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
        new iam.PolicyStatement({
          sid: 'KeepGuardrails',
          effect: iam.Effect.DENY,
          actions: ['iam:DeleteRolePermissionsBoundary', 'iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:SetDefaultPolicyVersion', 'iam:CreateUser', 'iam:CreateAccessKey'],
          resources: ['*'],
        }),
      ],
    });

    new cdk.CfnOutput(this, 'StagingRoleArn', { value: this.roles.staging.roleArn });
    new cdk.CfnOutput(this, 'ProductionRoleArn', { value: this.roles.production.roleArn });
  }
}
