import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { bootstrapQualifier, STAGING_BOUNDARY_NAME, type EnvName } from './config';

export const STAGING_EXEC_POLICY_NAME = 'stacks-test-cfn-exec';
const GITHUB_OIDC = 'token.actions.githubusercontent.com';

export interface CiStackProps {
  /** `owner/repo` whose GitHub Actions may deploy. */
  githubRepo: string;
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

    const deployRole = (envName: EnvName, githubEnvironment: string) => {
      const role = new iam.Role(this, `${envName === 'production' ? 'Production' : 'Staging'}DeployRole`, {
        roleName: `stacks-ci-${envName}`,
        description: `GitHub Actions deploys to ${envName} (environment "${githubEnvironment}" only)`,
        maxSessionDuration: cdk.Duration.hours(1),
        assumedBy: new iam.WebIdentityPrincipal(providerArn, {
          StringEquals: {
            [`${GITHUB_OIDC}:aud`]: 'sts.amazonaws.com',
            [`${GITHUB_OIDC}:sub`]: `repo:${props.githubRepo}:environment:${githubEnvironment}`,
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
