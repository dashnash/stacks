import { composeMigrations, migrateSdkItems, renameEmailField, type ItemMigration } from '@stacks/api';

/** The user-id cut-over (`tools/migrate-user-ids`): greetings' `authorEmail` becomes `authorId`. */
export const migrate: ItemMigration = composeMigrations(migrateSdkItems, (item, idFor) =>
  item.PK === 'GREETINGS' && 'authorEmail' in item ? renameEmailField(item, 'authorEmail', 'authorId', idFor) : undefined,
);
