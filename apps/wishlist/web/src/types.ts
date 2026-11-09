import type { WishItem } from '../../api/model';

export interface ListSummary {
  listId: string;
  ownerName: string;
  mine: boolean;
  items: number;
  available: number | null;
}
export interface ListInfo {
  listId: string;
  ownerName: string;
  note: string;
  mine: boolean;
}
export type OtherItem = WishItem & { status: 'available' | 'mine' | 'taken'; bought?: boolean };
export interface ListPage {
  list: ListInfo;
  items: (WishItem | OtherItem)[];
  canModerate: boolean;
}
export interface ClaimGroup {
  listId: string;
  ownerName: string;
  items: (WishItem & { bought: boolean })[];
}
export const money = (n: number | null) => (n === null ? '' : `$${n}`);
