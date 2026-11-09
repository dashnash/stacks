import { badRequest, sha256Hex, type Item } from '@stacks/api';

/**
 * One partition per person's list (meta + items). Claims live apart, in CLAIMS#<listId>, so reading
 * your own list never touches them: the surprise rule holds by construction.
 */
export const PRIORITIES = ['love', 'like', 'idea'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = { love: 'Love it', like: 'Like it', idea: 'Just an idea' };

export interface ListMeta {
  listId: string;
  ownerName: string;
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
  claimerEmail: string;
  claimerName: string;
  bought: boolean;
  claimedAt: string;
}

/** A stable, email-free id for someone's list. */
export const listIdFor = async (email: string) => (await sha256Hex(`wishlist:${email.toLowerCase()}`)).slice(0, 16);

export const keys = {
  meta: (listId: string) => ({ PK: `LIST#${listId}`, SK: 'META' }),
  directory: (ownerName: string, listId: string) => ({ GSI1PK: 'LISTS', GSI1SK: `${ownerName.toLowerCase()}#${listId}` }),
  item: (listId: string, id: string) => ({ PK: `LIST#${listId}`, SK: `ITEM#${id}` }),
  claim: (listId: string, itemId: string) => ({ PK: `CLAIMS#${listId}`, SK: itemId }),
  byClaimer: (email: string, claimedAt: string) => ({ GSI1PK: `CLAIMER#${email}`, GSI1SK: claimedAt }),
};

export type MetaItem = Item & ListMeta & { ownerEmail: string };
export type ItemRecord = Item & WishItem;
export type ClaimItem = Item & Claim;

export function parsePriority(raw: unknown, fallback: Priority = 'like'): Priority {
  if (raw === undefined) return fallback;
  if (!PRIORITIES.includes(raw as Priority)) throw badRequest(`"priority" must be one of ${PRIORITIES.join(', ')}`);
  return raw as Priority;
}
