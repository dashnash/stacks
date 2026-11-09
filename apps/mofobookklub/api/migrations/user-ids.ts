import { migrateComments } from '@stacks/comments';
import { composeMigrations, migrateSdkItems, renameEmailField, type IdFor, type Item, type ItemMigration } from '@stacks/api';

/**
 * The user-id cut-over (`tools/migrate-user-ids`). Book Club stored people by email in:
 * meetings (`leaderEmail`, `nextLeaderEmail`, and `chosenNomination.nominatedByEmail`),
 * nominations (`nominatedByEmail`, on The Lineup and in older per-meeting partitions),
 * votes (`userEmail`, and the email at the end of their `VOTE#<nomination>#<email>` sort key)
 * and books (`editedBy`). Comments, sessions and the activity log are handled by the SDK and module.
 */
const renameAll = (item: Item, idFor: IdFor, fields: [string, string][]) => fields.reduce((acc, [from, to]) => renameEmailField(acc, from, to, idFor), item);

const bookClub: ItemMigration = (item, idFor) => {
  const rec = item as Item & Record<string, unknown>;
  if (item.PK.startsWith('MEETING#') && item.SK.startsWith('MEETING#')) {
    if (!('leaderEmail' in rec) && !('nextLeaderEmail' in rec) && !(rec.chosenNomination && 'nominatedByEmail' in (rec.chosenNomination as object))) return undefined;
    const out = renameAll(item, idFor, [
      ['leaderEmail', 'leaderId'],
      ['nextLeaderEmail', 'nextLeaderId'],
    ]) as Item & Record<string, unknown>;
    if (out.chosenNomination) out.chosenNomination = renameEmailField(out.chosenNomination as Item, 'nominatedByEmail', 'nominatedById', idFor);
    return out;
  }
  if (item.SK.startsWith('NOMINATION#') && 'nominatedByEmail' in rec) return renameEmailField(item, 'nominatedByEmail', 'nominatedById', idFor);
  if (item.SK.startsWith('VOTE#') && 'userEmail' in rec) {
    const email = String(rec.userEmail);
    const out = renameEmailField(item, 'userEmail', 'userId', idFor);
    // VOTE#<nominationId>#<email> → VOTE#<nominationId>#<userId>
    const cut = item.SK.lastIndexOf('#');
    return item.SK.slice(cut + 1).toLowerCase() === email.toLowerCase() ? { ...out, SK: `${item.SK.slice(0, cut + 1)}${idFor(email)}` } : out;
  }
  if (item.PK.startsWith('BOOK#') && typeof rec.editedBy === 'string' && rec.editedBy.includes('@')) return { ...item, editedBy: idFor(rec.editedBy) };
  return undefined;
};

export const migrate: ItemMigration = composeMigrations(migrateSdkItems, migrateComments, bookClub);
