#!/usr/bin/env node
/**
 * Run the Book Club migration with your own admin AWS credentials (never in CI or a Claude session):
 *
 *   npm run migrate -w tools/migrate-book-club -- \
 *     --source-table <old BookClubTable name> --app-table <new app table> --platform-table <platform table> \
 *     [--source-bucket <old EasterEggBucketName> --content-bucket <new ContentBucketName>] [--dry-run]
 *
 * Set AWS_PROFILE (e.g. admin) and AWS_REGION=us-east-1. Safe to re-run: app items are rewritten
 * as they were, platform users and grants are only added if missing, photos are recopied.
 */
import { CopyObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { Item } from '@stacks/api';
import { DynamoStore } from '@stacks/api/lambda';
import { migrateBookClub } from './migrate';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const need = (name: string) => arg(name) ?? (console.error(`--${name} is required`), process.exit(2));

const sourceTable = need('source-table');
const appTable = need('app-table');
const platformTable = need('platform-table');
const sourceBucket = arg('source-bucket');
const contentBucket = arg('content-bucket');
const dryRun = process.argv.includes('--dry-run');

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
async function* scan(): AsyncIterable<Item> {
  let start: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(new ScanCommand({ TableName: sourceTable, ExclusiveStartKey: start }));
    for (const item of page.Items ?? []) yield item as Item;
    start = page.LastEvaluatedKey;
  } while (start);
}

const s3 = new S3Client({});
async function copyObjects(prefix: string): Promise<number> {
  if (!sourceBucket || !contentBucket) return 0;
  let copied = 0;
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: sourceBucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      if (!o.Key || o.Key.endsWith('/')) continue;
      await s3.send(new CopyObjectCommand({ Bucket: contentBucket, Key: o.Key, CopySource: `${sourceBucket}/${encodeURIComponent(o.Key).replace(/%2F/g, '/')}` }));
      copied++;
    }
    token = page.NextContinuationToken;
  } while (token);
  return copied;
}

const report = await migrateBookClub({
  source: scan(),
  appStore: new DynamoStore(appTable),
  platformStore: new DynamoStore(platformTable),
  appSlug: 'mofobookklub',
  copyObjects,
  dryRun,
  log: (line) => console.log(line),
});
if (report.skipped.length) process.exitCode = 1;
