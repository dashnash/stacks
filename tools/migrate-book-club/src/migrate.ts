import { ConditionFailedError, type Item, type Store } from '@stacks/api';

/**
 * One-time move of the MOFO Book Club Portal's data onto Stacks (spec: "Book Club migration").
 *
 * - Book, meeting, Lineup, vote, comment, easter-egg and activity-log items are copied to the new
 *   app table unchanged (the app and the comments module use the same keys).
 * - Users become platform users; their roles become grants for the app. PENDING sign-ups become
 *   pending requests. Existing platform users and grants are never overwritten.
 * - Sessions are dropped: everyone signs in once more.
 * - Critic photos and the shared faces are copied bucket to bucket (they are never in git).
 */

export interface MigrationTargets {
  /** Every item in the old BookClubTable. */
  source: AsyncIterable<Item> | Iterable<Item>;
  appStore: Store;
  platformStore: Store;
  appSlug: string;
  /** Copies `eggs/...` objects from the old assets bucket to the new content bucket. */
  copyObjects?: (prefix: string) => Promise<number>;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface MigrationReport {
  appItems: number;
  sessionsDropped: number;
  users: { created: number; existing: number };
  grants: { created: number; existing: number; pending: number };
  objectsCopied: number;
  skipped: string[];
}

interface OldUser {
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'PENDING';
  name: string;
  displayName?: string;
  pictureUrl?: string;
  createdAt: string;
}

const COPIED_PREFIXES = ['BOOK#', 'MEETING#', 'LINEUP', 'THREAD#', 'EASTEREGG', 'AUDIT#'];

export async function migrateBookClub(t: MigrationTargets): Promise<MigrationReport> {
  const log = t.log ?? (() => undefined);
  const report: MigrationReport = {
    appItems: 0,
    sessionsDropped: 0,
    users: { created: 0, existing: 0 },
    grants: { created: 0, existing: 0, pending: 0 },
    objectsCopied: 0,
    skipped: [],
  };
  const now = new Date().toISOString();

  for await (const item of t.source) {
    if (item.PK.startsWith('SESSION#')) {
      report.sessionsDropped++;
      continue;
    }
    if (item.PK.startsWith('USER#')) {
      await migrateUser(t, item as Item & OldUser, now, report);
      continue;
    }
    if (COPIED_PREFIXES.some((p) => item.PK.startsWith(p))) {
      if (!t.dryRun) await t.appStore.put(item);
      report.appItems++;
      continue;
    }
    report.skipped.push(`${item.PK} / ${item.SK}`);
  }

  if (t.copyObjects) report.objectsCopied = t.dryRun ? 0 : await t.copyObjects('eggs/');
  log(`App items copied: ${report.appItems}; sessions dropped: ${report.sessionsDropped}`);
  log(`Platform users: ${report.users.created} created, ${report.users.existing} already there`);
  log(`Grants: ${report.grants.created} created (${report.grants.pending} pending), ${report.grants.existing} already there`);
  log(`Photos copied: ${report.objectsCopied}${t.dryRun ? ' (dry run: nothing written)' : ''}`);
  if (report.skipped.length) log(`Skipped (unknown items): ${report.skipped.join(', ')}`);
  return report;
}

async function migrateUser(t: MigrationTargets, u: Item & OldUser, now: string, report: MigrationReport) {
  const email = u.email.toLowerCase();
  const profile = {
    PK: `USER#${email}`,
    SK: 'PROFILE',
    GSI1PK: 'USERS',
    GSI1SK: email,
    email,
    name: u.name,
    ...(u.displayName ? { displayName: u.displayName } : {}),
    ...(u.pictureUrl ? { pictureUrl: u.pictureUrl } : {}),
    createdAt: u.createdAt,
  };
  if (await putIfAbsent(t, profile)) report.users.created++;
  else report.users.existing++;

  const pending = u.role === 'PENDING';
  const grant = {
    PK: `APP#${t.appSlug}`,
    SK: `GRANT#${email}`,
    GSI1PK: `USERGRANTS#${email}`,
    GSI1SK: t.appSlug,
    app: t.appSlug,
    email,
    role: u.role,
    ...(pending ? { requestedAt: u.createdAt } : { grantedBy: 'migration', grantedAt: now }),
  };
  if (await putIfAbsent(t, grant)) {
    report.grants.created++;
    if (pending) report.grants.pending++;
  } else report.grants.existing++;
}

/** Write only if nothing is there yet (never clobber the platform's own data). Returns true if written (or would be). */
async function putIfAbsent(t: MigrationTargets, item: Item): Promise<boolean> {
  if (t.dryRun) return !(await t.platformStore.get(item.PK, item.SK));
  try {
    await t.platformStore.put(item, { ifNotExists: true });
    return true;
  } catch (err) {
    if (err instanceof ConditionFailedError) return false;
    throw err;
  }
}
