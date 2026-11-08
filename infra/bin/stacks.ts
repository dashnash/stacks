#!/usr/bin/env node
/**
 * The CDK app for the whole monorepo. Context:
 *   -c env=staging|production   which environment (default staging)
 *   -c app=<slug>               only that app's stack (the staging pipeline uses this)
 *   -c only=platform            only the platform stack
 *   -c ci=true                  only the one-time CI/OIDC stack (deployed by hand with admin credentials)
 *
 * It never does CDK context lookups, so synth needs no AWS credentials; values that live in AWS
 * (the certificate ARN) are read from SSM by CloudFormation at deploy time.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { AppStack, CiStack, loadStacksConfig, PlatformStack, type EnvName } from '@stacks/infra';
import { discoverApps } from '../lib/apps';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = loadStacksConfig(path.join(repoRoot, 'stacks.config.json'));
const app = new cdk.App();

const envName = (app.node.tryGetContext('env') ?? 'staging') as EnvName;
if (envName !== 'staging' && envName !== 'production') throw new Error('-c env must be staging or production');

if (app.node.tryGetContext('ci') === 'true') {
  new CiStack(app, 'stacks-ci', { githubRepo: config.githubRepo, githubSubjectPrefix: config.githubSubjectPrefix, region: config.region });
} else if (app.node.tryGetContext('only') === 'platform') {
  new PlatformStack(app, { envName, env: config.environments[envName], region: config.region, repoRoot });
} else {
  const only = app.node.tryGetContext('app') as string | undefined;
  if (!only) new PlatformStack(app, { envName, env: config.environments[envName], region: config.region, repoRoot });
  const apps = discoverApps(repoRoot).filter((a) => !only || a.manifest.slug === only);
  if (only && !apps.length) throw new Error(`No app "${only}" in apps/`);
  for (const a of apps) {
    new AppStack(app, { manifest: a.manifest, envName, env: config.environments[envName], region: config.region, repoRoot, appDir: a.dir });
  }
}
