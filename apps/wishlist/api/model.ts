import { badRequest, sha256Hex, type AppDeps, type Item } from '@stacks/api';

/**
 * One partition per person's list (meta + items). Claims live apart, in CLAIMS#<listId>, so reading
 * your own list never touches them: the surprise rule holds by construction. People are stored by
 * user id (`v.user.id`); names come from `getPeople` when a page is read.
 */
export const PRIORITIES = ['love', 'like', 'idea'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = { love: 'Love it', like: 'Like it', idea: 'Just an idea' };

export interface ListMeta {
  listId: string;
  ownerId: string;
  note: string;
  updatedAt: string;
}

export interface WishItem {
  id: string;
  listId: string;
  title: string;
  link: string | null;
  price: number | null;
  priority: Priority;
  notes: string;
  addedAt: string;
}

export interface Claim {
  itemId: string;
  listId: string;
  claimerId: string;
  bought: boolean;
  claimedAt: string;
}

/** The id a new list gets from its owner's user id. */
export const listIdFor = async (userId: string) => (await sha256Hex(`wishlist:${userId}`)).slice(0, 16);

/**
 * The id of someone's list, via their `OWNER#<userId>` pointer. Lists made before user ids keep
 * their old id (a hash of the owner's email, so shared links still work): the first time, the
 * pointer is filled in from the directory by `ownerId`.
 */
export async function myListId(deps: AppDeps, userId: string): Promise<string> {
  const k = keys.owner(userId);
  const pointer = await deps.store.get<Item & { listId: string }>(k.PK, k.SK);
  if (pointer) return pointer.listId;
  const existing = (await deps.store.queryGsi1<MetaItem>('LISTS')).find((m) => m.ownerId === userId);
  const listId = existing?.listId ?? (await listIdFor(userId));
  await deps.store.put({ ...k, listId });
  return listId;
}

export const keys = {
  meta: (listId: string) => ({ PK: `LIST#${listId}`, SK: 'META' }),
  directory: (listId: string) => ({ GSI1PK: 'LISTS', GSI1SK: listId }),
  owner: (userId: string) => ({ PK: `OWNER#${userId}`, SK: 'LIST' }),
  item: (listId: string, id: string) => ({ PK: `LIST#${listId}`, SK: `ITEM#${id}` }),
  claim: (listId: string, itemId: string) => ({ PK: `CLAIMS#${listId}`, SK: itemId }),
  byClaimer: (userId: string, claimedAt: string) => ({ GSI1PK: `CLAIMER#${userId}`, GSI1SK: claimedAt }),
};

export type MetaItem = Item & ListMeta;
export type ItemRecord = Item & WishItem;
export type ClaimItem = Item & Claim;

export function parsePriority(raw: unknown, fallback: Priority = 'like'): Priority {
  if (raw === undefined) return fallback;
  if (!PRIORITIES.includes(raw as Priority)) throw badRequest(`"priority" must be one of ${PRIORITIES.join(', ')}`);
  return raw as Priority;
}
