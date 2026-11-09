import { composeMigrations, migrateSdkItems, type Item, type ItemMigration } from '@stacks/api';

/**
 * The user-id cut-over (`tools/migrate-user-ids`): flips move from `FLIPS#<email>` to `FLIPS#<userId>`,
 * and leaderboard rows from `PLAYER`/`<email>` (with an `email` field) to `PLAYER`/`<userId>` (with `userId`).
 */
export const migrate: ItemMigration = composeMigrations(migrateSdkItems, (item, idFor) => {
  if (item.PK.startsWith('FLIPS#') && item.PK.includes('@')) return { ...item, PK: `FLIPS#${idFor(item.PK.slice('FLIPS#'.length))}` };
  if (item.PK === 'PLAYER' && item.SK.includes('@')) {
    const { email: _email, ...rest } = item as Item & { email?: string };
    const userId = idFor(item.SK);
    return { ...rest, SK: userId, userId };
  }
  return undefined;
});
