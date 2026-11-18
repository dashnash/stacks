#!/usr/bin/env node
/**
 * Copy every item from one DynamoDB table into another (#97, docs/RESTORE.md). A restore always
 * makes a new table; this puts its items back into the stack's live table, so stacks, the registry
 * and names never change. Run by the owner with admin credentials, never in CI:
 *
 *   npm run table-copy -- --from <restored table> --to <live table> [--dry-run] [--region us-east-1]
 *
 * Items are written whole (PutItem semantics): same key → replaced, items only in the live table
 * stay. Uses the AWS SDK's default credentials (AWS_PROFILE=admin).
 */
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const opts = { dryRun: false, region: 'us-east-1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--from' || a === '--to' || a === '--region') opts[a.slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.from || !opts.to) throw new Error('Usage: table-copy --from <restored table> --to <live table> [--dry-run] [--region us-east-1]');
  if (opts.from === opts.to) throw new Error('--from and --to are the same table');
  return opts;
}

/**
 * The copy. `client` has `scan({ TableName, ExclusiveStartKey })` → `{ Items, LastEvaluatedKey }`,
 * `batchWrite({ RequestItems })` → `{ UnprocessedItems }` and `describe(table)` (throws if missing).
 */
export async function copyTable(client, { from, to, dryRun = false, maxRetries = 8, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  await client.describe(from);
  await client.describe(to);
  let scanned = 0;
  let written = 0;
  let start;
  do {
    const page = await client.scan({ TableName: from, ExclusiveStartKey: start });
    const items = page.Items ?? [];
    scanned += items.length;
    for (let i = 0; i < items.length && !dryRun; i += 25) {
      let pending = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
      for (let attempt = 0; pending.length; attempt++) {
        if (attempt > maxRetries) throw new Error(`Gave up after ${maxRetries} retries with ${pending.length} unprocessed items (${written} written so far)`);
        if (attempt) await sleep(Math.min(100 * 2 ** attempt, 5000));
        const res = await client.batchWrite({ RequestItems: { [to]: pending } });
        const left = res.UnprocessedItems?.[to] ?? [];
        written += pending.length - left.length;
        pending = left;
      }
    }
    start = page.LastEvaluatedKey;
    log(`${scanned} scanned, ${dryRun ? 'dry run' : `${written} written`}`);
  } while (start);
  return { scanned, written };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { DynamoDBClient, ScanCommand, BatchWriteItemCommand, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');
  const ddb = new DynamoDBClient({ region: opts.region });
  const client = {
    scan: (input) => ddb.send(new ScanCommand(input)),
    batchWrite: (input) => ddb.send(new BatchWriteItemCommand(input)),
    describe: (TableName) => ddb.send(new DescribeTableCommand({ TableName })),
  };
  console.log(`${opts.dryRun ? 'Dry run: ' : ''}copying ${opts.from} → ${opts.to} (${opts.region})`);
  const { scanned, written } = await copyTable(client, { ...opts, log: (m) => console.log(m) });
  console.log(opts.dryRun ? `Done: ${scanned} items would be written.` : `Done: ${written} of ${scanned} items written.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
