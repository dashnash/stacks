#!/usr/bin/env node
/**
 * The user-id cut-over, run by a platform admin with their own admin AWS credentials (never in CI
 * or a Claude session), while `maintenance` is on for that environment. Runbook: docs/USER_IDS_CUTOVER.md.
 *
 *   AWS_PROFILE=admin AWS_REGION=us-east-1 npm run migrate -w tools/migrate-user-ids -- \
 *     --env staging --platform-table <platform TableName output> [--dry-run]
 *
 * Migrates the platform table first, then every app registered for the environment (their tables
 * come from SSM `/stacks/<test|prod>/apps/<slug>/table`), each with `apps/<slug>/api/migrations/user-ids.ts`
 * or, when an app has none, the SDK's default (plus the comments module's if the app enables it).
 * `--app <slug>` (repeatable) limits the apps. Safe to re-run.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { composeMigrations, migrateSdkItems, type Item, type ItemMigration } from '@stacks/api';
import { migrateComments } from '@stacks/comments';
import { parseManifest } from '@stacks/manifest';
import { migrateApp, migratePlatform, platformTableProblem, type Report, type Table } from './migrate';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const all = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

const env = arg('env') ?? fail('--env staging|production is required');
if (env !== 'staging' && env !== 'production') fail('--env must be staging or production');
const tag = env === 'production' ? 'prod' : 'test';
const platformTable = arg('platform-table') ?? fail(`--platform-table is required (the TableName output of stacks-${tag}-platform)`);
const tableProblem = platformTableProblem(env as 'staging' | 'production', platformTable);
if (tableProblem) fail(tableProblem);
const onlyApps = all('app');
const dryRun = args.includes('--dry-run');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
function dynamoTable(name: string): Table {
  return {
    async *scan() {
      let start: Record<string, unknown> | undefined;
      do {
        const page = await doc.send(new ScanCommand({ TableName: name, ExclusiveStartKey: start }));
        for (const item of page.Items ?? []) yield item as Item;
        start = page.LastEvaluatedKey;
      } while (start);
    },
    put: async (item) => void (await doc.send(new PutCommand({ TableName: name, Item: item }))),
    delete: async (PK, SK) => void (await doc.send(new DeleteCommand({ TableName: name, Key: { PK, SK } }))),
  };
}

/** Registered apps and their tables, from the registry parameters each app stack writes. */
async function registeredApps(): Promise<{ slug: string; table: string; modules: string[] }[]> {
  const ssm = new SSMClient({});
  const prefix = `/stacks/${tag}/apps/`;
  const values = new Map<string, Record<string, string>>();
  let token: string | undefined;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({ Path: prefix, Recursive: true, NextToken: token }));
    for (const p of page.Parameters ?? []) {
      const [slug, field] = (p.Name ?? '').slice(prefix.length).split('/');
      if (slug && field && p.Value !== undefined) values.set(slug, { ...values.get(slug), [field]: p.Value });
    }
    token = page.NextToken;
  } while (token);
  return [...values].flatMap(([slug, v]) => {
    if (!v.table) return [];
    const manifest = parseManifest(JSON.parse(v.manifest ?? 'null'), `${prefix}${slug}/manifest`);
    return [{ slug, table: v.table, modules: manifest.modules ?? [] }];
  });
}

async function migrationFor(slug: string, modules: string[]): Promise<{ migrate: ItemMigration; source: string }> {
  const file = resolve(repoRoot, 'apps', slug, 'api/migrations/user-ids.ts');
  if (existsSync(file)) return { migrate: ((await import(pathToFileURL(file).href)) as { migrate: ItemMigration }).migrate, source: `apps/${slug}/api/migrations/user-ids.ts` };
  const parts = [migrateSdkItems, ...(modules.includes('comments') ? [migrateComments] : [])];
  return { migrate: composeMigrations(...parts), source: `SDK default${modules.includes('comments') ? ' + comments' : ''}` };
}

const show = (r: Report) => Object.entries(r.counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing to do';
let failed = false;

console.log(`${dryRun ? 'DRY RUN: ' : ''}user-id cut-over for ${env}`);
const platform = await migratePlatform(dynamoTable(platformTable), {
  mintId: () => `u_${randomBytes(12).toString('hex')}`,
  now: () => new Date(),
  dryRun,
  log: (line) => console.log(`  ${line}`),
});
console.log(`platform (${platformTable}): ${show(platform.report)}`);
for (const e of platform.report.errors) console.error(`  ERROR ${e}`);
failed ||= platform.report.errors.length > 0;

const apps = (await registeredApps()).filter((a) => !onlyApps.length || onlyApps.includes(a.slug));
for (const missing of onlyApps.filter((s) => !apps.some((a) => a.slug === s))) fail(`No app "${missing}" registered in ${env}`);
for (const app of apps) {
  const { migrate, source } = await migrationFor(app.slug, app.modules);
  const report = await migrateApp(dynamoTable(app.table), migrate, platform.idFor, { dryRun });
  console.log(`${app.slug} (${app.table}, ${source}): ${show(report)}`);
  for (const e of report.errors) console.error(`  ERROR ${e}`);
  failed ||= report.errors.length > 0;
}
if (failed) process.exitCode = 1;
console.log(dryRun ? 'Dry run only: nothing was written.' : 'Done. Lift maintenance for this environment when the checks in the runbook pass.');
