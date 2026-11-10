import { composeMigrations, migrateSdkItems, renameEmailField, type Item, type ItemMigration } from '@stacks/api';

/**
 * The user-id cut-over (`tools/migrate-user-ids`). Everything lives in `EVENT#<id>` partitions:
 * - the event: `hostEmail` becomes `hostId` (the stored `hostName` goes: names come from `getPeople`);
 * - dishes: `bringerEmail` becomes `bringerId` (`bringerName` goes);
 * - RSVPs: re-keyed from `RSVP#<email>` to `RSVP#<userId>`, `email` becomes `userId` (`name` goes).
 */
const drop = (item: Item, field: string): Item => {
  const { [field]: _gone, ...rest } = item as Item & Record<string, unknown>;
  return rest as Item;
};

export const migrate: ItemMigration = composeMigrations(migrateSdkItems, (item, idFor) => {
  if (!item.PK.startsWith('EVENT#')) return undefined;
  if (item.SK === 'EVENT' && 'hostEmail' in item) return drop(renameEmailField(item, 'hostEmail', 'hostId', idFor), 'hostName');
  if (item.SK.startsWith('DISH#') && 'bringerEmail' in item) return drop(renameEmailField(item, 'bringerEmail', 'bringerId', idFor), 'bringerName');
  if (item.SK.startsWith('RSVP#') && item.SK.includes('@')) {
    const userId = idFor(item.SK.slice('RSVP#'.length));
    const { email: _email, name: _name, ...rest } = item as Item & { email?: string; name?: string };
    return { ...rest, SK: `RSVP#${userId}`, userId };
  }
  return undefined;
});
