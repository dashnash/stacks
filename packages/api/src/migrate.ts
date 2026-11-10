import type { Item } from './store';

/**
 * The one-time move from email keys to user ids (`tools/migrate-user-ids`). The tool scans each
 * app's table and offers every item to the app's `migrations/user-ids.ts`, which composes the SDK's
 * and its modules' migrations with its own.
 */

/**
 * The user id for an email (any case). Always answers: people the platform no longer knows get a
 * stable placeholder id that no account has, so their old posts show as "Former member".
 */
export type IdFor = (email: string) => string;

/** `undefined`: not mine, leave it; `null`: delete it; an item: write it instead (the old one is deleted if its keys changed). */
export type ItemMigration = (item: Item, idFor: IdFor) => Item | null | undefined;

/** The first migration with an opinion about an item wins. */
export function composeMigrations(...migrations: ItemMigration[]): ItemMigration {
  return (item, idFor) => {
    for (const m of migrations) {
      const out = m(item, idFor);
      if (out !== undefined) return out;
    }
    return undefined;
  };
}

/** Swap an email-valued field for an id-valued one. */
export function renameEmailField(item: Item, from: string, to: string, idFor: IdFor): Item {
  const { [from]: email, ...rest } = item as Item & Record<string, unknown>;
  return typeof email === 'string' && email ? ({ ...rest, [to]: idFor(email) } as Item) : item;
}

/**
 * What the SDK itself stores in an app's table: sessions and sign-in codes (dropped: everyone signs
 * in again) and the activity log (`actorEmail` becomes `actorId`).
 */
export const migrateSdkItems: ItemMigration = (item, idFor) => {
  if (item.SK === 'SESSION' && item.PK.startsWith('SESSION#')) return null;
  if (item.PK.startsWith('AUDIT#')) return 'actorEmail' in item ? renameEmailField(item, 'actorEmail', 'actorId', idFor) : undefined;
  return undefined;
};

/**
 * The id demo personas and test users get from their email (`ann@demo.dev` → `u_ann_demo_dev`), so
 * seed data and tests can name people by email. Never used for real accounts.
 */
export const fixtureUserId = (email: string): string => `u_${email.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
