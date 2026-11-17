import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs script, no types
import { copyTable, parseArgs } from '../table-copy.mjs';

type Item = Record<string, unknown>;
function fakeClient(source: Item[], { pageSize = 30, unprocessedOnce = 0, tables = ['restored', 'live'] } = {}) {
  const written: Item[] = [];
  let toFail = unprocessedOnce;
  const client = {
    describe: async (t: string) => {
      if (!tables.includes(t)) throw new Error(`Requested resource not found: ${t}`);
    },
    scan: async ({ ExclusiveStartKey }: { ExclusiveStartKey?: { i: number } }) => {
      const from = ExclusiveStartKey?.i ?? 0;
      const Items = source.slice(from, from + pageSize);
      return { Items, LastEvaluatedKey: from + pageSize < source.length ? { i: from + pageSize } : undefined };
    },
    batchWrite: async ({ RequestItems }: { RequestItems: Record<string, { PutRequest: { Item: Item } }[]> }) => {
      const [[table, reqs]] = Object.entries(RequestItems);
      expect(table).toBe('live');
      expect(reqs.length).toBeLessThanOrEqual(25);
      const keep = toFail > 0 ? reqs.slice(0, reqs.length - 1) : reqs;
      const left = reqs.slice(keep.length);
      toFail -= left.length;
      written.push(...keep.map((r) => r.PutRequest.Item));
      return { UnprocessedItems: left.length ? { [table]: left } : {} };
    },
  };
  return { client, written };
}
const items = Array.from({ length: 73 }, (_, i) => ({ PK: { S: `k${i}` } }));
const opts = { from: 'restored', to: 'live', sleep: async () => {} };

describe('table-copy (#97)', () => {
  it('copies every page in batches of 25', async () => {
    const { client, written } = fakeClient(items);
    expect(await copyTable(client, opts)).toEqual({ scanned: 73, written: 73 });
    expect(written).toEqual(items);
  });

  it('retries unprocessed items', async () => {
    const { client, written } = fakeClient(items, { unprocessedOnce: 3 });
    expect(await copyTable(client, opts)).toEqual({ scanned: 73, written: 73 });
    expect(new Set(written.map((i: any) => i.PK.S)).size).toBe(73);
  });

  it('gives up after too many retries', async () => {
    const { client } = fakeClient(items, { unprocessedOnce: 1000 });
    await expect(copyTable(client, { ...opts, maxRetries: 2 })).rejects.toThrow(/Gave up after 2 retries/);
  });

  it('writes nothing in a dry run', async () => {
    const { client, written } = fakeClient(items);
    expect(await copyTable(client, { ...opts, dryRun: true })).toEqual({ scanned: 73, written: 0 });
    expect(written).toEqual([]);
  });

  it('refuses a missing table before writing anything', async () => {
    const { client, written } = fakeClient(items, { tables: ['restored'] });
    await expect(copyTable(client, opts)).rejects.toThrow(/not found: live/);
    expect(written).toEqual([]);
  });

  it('parses arguments and refuses the same or missing tables', () => {
    expect(parseArgs(['--from', 'a', '--to', 'b', '--dry-run'])).toEqual({ from: 'a', to: 'b', dryRun: true, region: 'us-east-1' });
    expect(() => parseArgs(['--from', 'a'])).toThrow(/Usage/);
    expect(() => parseArgs(['--from', 'a', '--to', 'a'])).toThrow(/same table/);
    expect(() => parseArgs(['--from', 'a', '--to', 'b', '--force'])).toThrow(/Unknown argument/);
  });
});
