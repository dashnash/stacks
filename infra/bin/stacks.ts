#!/usr/bin/env node
/**
 * The CDK app for the whole monorepo. Context:
 *   -c env=staging|production   which environment (default staging)
 *   -c app=<slug>               only that app's stack (the staging pipeline uses this)
 *   -c only=platform            only the platform stack
 *
 * Apps listed in an environment's `holdApps` (stacks.config.json) are left out of that environment.
 *   -c ci=true                  only the one-time CI/OIDC stack (deployed by hand with admin credentials)
 *   -c hostedZoneIds=<name>=<id>,...   IDs for zones the config marks `hostedZoneId: "lookup"`
 *                               (the deploy workflows look them up with scripts/lookup-zones.mjs)
 *   -c requireZones=true        fail instead of synthesizing a placeholder zone ID (deploy builds)
 *
 * `STACKS_BUILD_SHA` (the commit; the deploy workflows set it) is stamped on every Lambda's log lines.
 *
 * The full synth (no `app`/`only`) also has `stacks-<env>-legacy-redirect` when the environment has
 * `legacyRedirects`; it depends on every other stack, so `cdk deploy --all` deploys it last, once
 * they have left the old names.
 *
 * It never does CDK context lookups, so synth needs no AWS credentials; values that live in AWS
 * (the certificate ARN) are read from SSM by CloudFormation at deploy time, and zone IDs come
 * from context (a placeholder without it).
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { AppStack, CiStack, LegacyRedirectStack, loadStacksConfig, parseZoneIds, PlatformStack, resolveZoneIds, stagingRecordNames, stagingRootDomains, type EnvName } from '@stacks/infra';
import { discoverApps } from '../lib/apps';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = loadStacksConfig(path.join(repoRoot, 'stacks.config.json'));
const app = new cdk.App();

const envName = (app.node.tryGetContext('env') ?? 'staging') as EnvName;
if (envName !== 'staging' && envName !== 'production') throw new Error('-c env must be staging or production');
const env = resolveZoneIds(config.environments[envName], parseZoneIds(app.node.tryGetContext('hostedZoneIds')), String(app.node.tryGetContext('requireZones')) === 'true');

const buildSha = process.env.STACKS_BUILD_SHA || undefined;
const held = new Set(env.holdApps ?? []);
const discovered = discoverApps(repoRoot).filter((a) => !held.has(a.manifest.slug));
// The dashboard's log tables and saved queries list each app's log group by name.
const platformProps = { envName, env, region: config.region, repoRoot, buildSha, appSlugs: discovered.map((a) => a.manifest.slug) };

if (app.node.tryGetContext('ci') === 'true') {
  new CiStack(app, 'stacks-ci', {
    githubRepo: config.githubRepo,
    githubSubjectPrefix: config.githubSubjectPrefix,
    region: config.region,
    // The only DNS names staging deploys may write (#94).
    stagingRecordNames: stagingRecordNames(stagingRootDomains(config.environments.staging)),
    // #98: alerts go to production's first platform admin (no new address in git).
    ...(config.budget && config.environments.production.platformAdmins[0]
      ? { budget: { monthlyUsd: config.budget.monthlyUsd, alertEmail: config.environments.production.platformAdmins[0] } }
      : {}),
  });
} else if (app.node.tryGetContext('only') === 'platform') {
  new PlatformStack(app, platformProps);
} else {
  const only = app.node.tryGetContext('app') as string | undefined;
  const platform = only ? undefined : new PlatformStack(app, platformProps);
  if (only && held.has(only)) throw new Error(`"${only}" is on hold for ${envName} (holdApps in stacks.config.json)`);
  const apps = discovered.filter((a) => !only || a.manifest.slug === only);
  if (only && !apps.length) throw new Error(`No app "${only}" in apps/`);
  const appStacks = apps.map((a) => new AppStack(app, { manifest: a.manifest, envName, env, region: config.region, repoRoot, appDir: a.dir, buildSha }));
  if (platform && env.legacyRedirects?.length) {
    const redirect = new LegacyRedirectStack(app, { envName, env, region: config.region });
    for (const s of [platform, ...appStacks]) redirect.addStackDependency(s, 'takes over the old names only after they have left them');
  }
}
