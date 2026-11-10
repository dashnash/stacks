import { composeMigrations, migrateSdkItems, renameEmailField, type Item, type ItemMigration } from '@stacks/api';

/**
 * The user-id cut-over (`tools/migrate-user-ids`):
 * - list meta (`LIST#<listId>`/`META`): `ownerEmail` becomes `ownerId`; the stored `ownerName` goes
 *   (names come from `getPeople`) and the directory key becomes `LISTS`/`<listId>`. List ids stay as
 *   they are (shared links keep working); `myListId` finds them by `ownerId`.
 * - claims (`CLAIMS#<listId>`): `claimerEmail` becomes `claimerId` (`claimerName` goes) and the
 *   by-claimer index moves from `CLAIMER#<email>` to `CLAIMER#<userId>`.
 * List items hold no people and are left alone.
 */
const drop = (item: Item, ...fields: string[]): Item => {
  const out = { ...item } as Item & Record<string, unknown>;
  for (const f of fields) delete out[f];
  return out;
};

export const migrate: ItemMigration = composeMigrations(migrateSdkItems, (item, idFor) => {
  if (item.PK.startsWith('LIST#') && item.SK === 'META' && 'ownerEmail' in item) {
    const listId = item.PK.slice('LIST#'.length);
    return { ...drop(renameEmailField(item, 'ownerEmail', 'ownerId', idFor), 'ownerName'), GSI1PK: 'LISTS', GSI1SK: listId };
  }
  if (item.PK.startsWith('CLAIMS#') && 'claimerEmail' in item) {
    const claim = drop(renameEmailField(item, 'claimerEmail', 'claimerId', idFor), 'claimerName');
    return { ...claim, GSI1PK: `CLAIMER#${(claim as Item & { claimerId: string }).claimerId}` };
  }
  return undefined;
});
