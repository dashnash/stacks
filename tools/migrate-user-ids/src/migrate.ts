import { createHash } from 'node:crypto';
import type { IdFor, Item, ItemMigration } from '@stacks/api';

/**
 * The one-time move from email keys to user ids (docs/NATIVE_APP_SPEC.md, "Identity v2"). Pure
 * functions over a table, so the same code runs against DynamoDB (cli.ts) and in tests. Every step
 * is idempotent: items already in the new shape are left alone, so a run can be repeated.
 */

/** What the migration needs from a table. */
export interface Table {
  scan(): AsyncIterable<Item> | Iterable<Item>;
  put(item: Item): Promise<void>;
  delete(pk: string, sk: string): Promise<void>;
}

export interface Report {
  /** Counts per kind of change, e.g. `user` → 3. */
  counts: Record<string, number>;
  /** Items whose migration threw; the run carries on and the CLI exits non-zero. */
  errors: string[];
}

interface RunOptions {
  dryRun?: boolean;
  log?: (line: string) => void;
}

/**
 * Refuse a platform table from another environment: `--env` picks the app tables, so a mismatch
 * would rewrite one environment's apps with the other's user ids. CDK names it `stacks-<tag>-platform-…`.
 */
export function platformTableProblem(env: 'staging' | 'production', table: string): string | null {
  const tag = env === 'production' ? 'prod' : 'test';
  return table.startsWith(`stacks-${tag}-platform-`)
    ? null
    : `--platform-table ${table} is not ${env}'s platform table (expected stacks-${tag}-platform-…). Check --env.`;
}

const isEmail = (s: unknown): s is string => typeof s === 'string' && s.includes('@');

/**
 * The id for someone the platform no longer knows (they left before the cut-over, but their posts
 * stay): stable for an email, so every app gets the same one, and no account ever has it.
 */
export const formerUserId = (email: string) => `u_x${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 23)}`;

async function collect(table: Table): Promise<Item[]> {
  const items: Item[] = [];
  for await (const item of table.scan()) items.push(item);
  return items;
}

/** Write `next` in place of `item` (deleting the old one if its keys changed), unless dry-running. */
async function replace(table: Table, item: Item, next: Item, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await table.put(next);
  if (next.PK !== item.PK || next.SK !== item.SK) await table.delete(item.PK, item.SK);
}

/**
 * Migrate the platform table: users (`USER#<email>` → `USER#<id>` plus an `EMAIL#` lookup), grants,
 * notifications and the central audit feed; sessions and sign-in codes are dropped (everyone signs
 * in again). Returns the email → id map the apps' migrations use.
 */
export async function migratePlatform(
  table: Table,
  opts: RunOptions & { mintId: () => string; now: () => Date },
): Promise<{ idFor: IdFor; ids: Map<string, string>; report: Report }> {
  const dryRun = !!opts.dryRun;
  const log = opts.log ?? (() => undefined);
  const report: Report = { counts: {}, errors: [] };
  const count = (kind: string) => (report.counts[kind] = (report.counts[kind] ?? 0) + 1);
  const items = await collect(table);

  // Ids already assigned (a re-run), then one per legacy user.
  const ids = new Map<string, string>();
  for (const i of items) if (i.PK.startsWith('EMAIL#') && i.SK === 'EMAIL') ids.set(i.PK.slice('EMAIL#'.length), String(i.userId));
  const userItem = (id: string, user: Record<string, unknown>): Item => ({ PK: `USER#${id}`, SK: 'PROFILE', GSI1PK: 'USERS', GSI1SK: id, ...user, id });
  const emailItem = (email: string, id: string): Item => ({ PK: `EMAIL#${email}`, SK: 'EMAIL', userId: id });

  async function ensureUser(rawEmail: string, profile: Record<string, unknown>, kind: string): Promise<string> {
    const email = rawEmail.trim().toLowerCase();
    const known = ids.get(email);
    if (known) return known;
    const id = opts.mintId();
    ids.set(email, id);
    if (!dryRun) {
      await table.put(userItem(id, { ...profile, email }));
      await table.put(emailItem(email, id));
    }
    count(kind);
    log(`${kind}: ${email} → ${id}`);
    return id;
  }

  // 1. Users.
  for (const item of items) {
    if (!(item.PK.startsWith('USER#') && item.SK === 'PROFILE' && isEmail(item.PK.slice('USER#'.length)))) continue;
    const { PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g2, ...user } = item;
    const email = String(user.email ?? item.PK.slice('USER#'.length)).toLowerCase();
    const known = ids.get(email);
    const id = known ?? (await ensureUser(email, user, 'user'));
    if (known && !dryRun) {
      await table.put(userItem(id, { ...user, email }));
      await table.put(emailItem(email, id));
    }
    if (!dryRun) await table.delete(item.PK, item.SK);
  }

  const idFor: IdFor = (email) => ids.get(email.trim().toLowerCase()) ?? formerUserId(email);
  const actor = (value: unknown) => (isEmail(value) ? idFor(value) : value);

  // 2. Everything that names a user by email.
  for (const item of items) {
    try {
      if (item.PK.startsWith('APP#') && item.SK.startsWith('GRANT#') && isEmail(item.SK.slice('GRANT#'.length))) {
        const { email: rawEmail, ...grant } = item as Item & { email?: string };
        const email = String(rawEmail ?? item.SK.slice('GRANT#'.length)).toLowerCase();
        // A grant for someone who never signed in (a manifest owner, an imported member): they get an account now.
        const at = String(item.grantedAt ?? item.requestedAt ?? opts.now().toISOString());
        const userId = await ensureUser(email, { name: email.split('@')[0], createdAt: at }, 'user.placeholder');
        const slug = item.PK.slice('APP#'.length);
        const next: Item = { ...grant, PK: item.PK, SK: `GRANT#${userId}`, GSI1PK: `USERGRANTS#${userId}`, GSI1SK: slug, userId, ...(grant.grantedBy ? { grantedBy: actor(grant.grantedBy) } : {}) };
        await replace(table, item, next, dryRun);
        count('grant');
      } else if (item.PK.startsWith('NOTIF#') && isEmail(item.PK.slice('NOTIF#'.length))) {
        await replace(table, item, { ...item, PK: `NOTIF#${idFor(item.PK.slice('NOTIF#'.length))}` }, dryRun);
        count('notification');
      } else if ((item.PK.startsWith('SESSION#') && item.SK === 'SESSION') || (item.PK.startsWith('CODE#') && item.SK === 'CODE')) {
        if (!dryRun) await table.delete(item.PK, item.SK);
        count(item.SK === 'SESSION' ? 'session.dropped' : 'code.dropped');
      } else if (item.PK.startsWith('AUDIT#') && 'actorEmail' in item) {
        const { actorEmail, ...rest } = item as Item & { actorEmail: string };
        await replace(table, item, { ...rest, actorId: actorEmail === 'platform' ? 'platform' : idFor(actorEmail) } as Item, dryRun);
        count('audit');
      }
    } catch (err) {
      report.errors.push(`${item.PK} ${item.SK}: ${(err as Error).message}`);
    }
  }
  return { idFor, ids, report };
}

/** Migrate one app's table with its `api/migrations/user-ids.ts` (or the SDK's default). */
export async function migrateApp(table: Table, migrate: ItemMigration, idFor: IdFor, opts: RunOptions = {}): Promise<Report> {
  const dryRun = !!opts.dryRun;
  const report: Report = { counts: {}, errors: [] };
  const count = (kind: string) => (report.counts[kind] = (report.counts[kind] ?? 0) + 1);
  for (const item of await collect(table)) {
    try {
      const next = migrate(item, idFor);
      if (next === undefined) continue;
      if (next === null) {
        if (!dryRun) await table.delete(item.PK, item.SK);
        count('deleted');
      } else {
        await replace(table, item, next, dryRun);
        count(next.PK !== item.PK || next.SK !== item.SK ? 'rekeyed' : 'rewritten');
      }
    } catch (err) {
      report.errors.push(`${item.PK} ${item.SK}: ${(err as Error).message}`);
    }
  }
  return report;
}
