import type { AppDeps } from '@stacks/api';
import type { Persona } from '@stacks/demo';
import { keys, listIdFor, type Claim, type ListMeta, type Priority, type WishItem } from './model';

/** One persona per role (top role first, so "Sign in" in the demo shows every control). */
export const personas: Persona[] = [
  { email: "olive@demo.stacks", name: "Olive", role: "ORGANIZER", blurb: "keeps the family organized" },
  { email: "max@demo.stacks", name: "Max", role: "MEMBER", blurb: "shops early" },
];

/**
 * Sample lists for the demo: the organizer's, a member's and two relatives', with claims spread
 * around so every state shows (available, claimed by you, claimed by someone else, bought).
 */
export async function seed(deps: AppDeps): Promise<void> {
  const [org, member] = personas as [Persona, Persona];
  const relatives = [
    { email: 'nana@demo.stacks', name: 'Nana June' },
    { email: 'theo@demo.stacks', name: 'Theo' },
  ];
  const people = [org, member, ...relatives];
  const now = deps.now().toISOString();
  const lists: Record<string, string> = {};
  const notes = ['Medium in tops, 9 in shoes. No more candles, please!', 'Anything for the garden makes me happy.', 'I love books and warm socks.', 'Into climbing and board games lately.'];
  for (const [i, p] of people.entries()) {
    const listId = await listIdFor(p.email);
    lists[p.email] = listId;
    const meta: ListMeta = { listId, ownerName: p.name, note: notes[i]!, updatedAt: now };
    await deps.store.put({ ...keys.meta(listId), ...keys.directory(p.name, listId), ...meta, ownerEmail: p.email });
  }
  const items: [number, string, string | null, number | null, Priority, string][] = [
    [0, 'Cast-iron skillet, 10"', 'https://example.com/skillet', 35, 'love', 'Pre-seasoned if possible'],
    [0, 'Noise-cancelling headphones', null, 180, 'like', 'Over-ear'],
    [0, 'Puzzle (1000 pieces)', null, 20, 'idea', 'Landscapes > cats'],
    [1, 'Running jacket', 'https://example.com/jacket', 90, 'love', 'Size M, bright color'],
    [1, 'Pour-over coffee set', null, 45, 'like', ''],
    [1, 'Plant for the desk', null, 15, 'idea', 'Hard to kill'],
    [2, 'Large-print crossword book', null, 12, 'love', ''],
    [2, 'Pruning shears', 'https://example.com/shears', 28, 'like', 'Left-handed!'],
    [2, 'Bird feeder', null, 30, 'like', ''],
    [3, 'Climbing chalk bag', null, 25, 'love', 'Anything but black'],
    [3, 'Wingspan (board game)', null, 60, 'love', ''],
  ];
  const ids: string[] = [];
  for (const [i, [who, title, link, price, priority, notes2]] of items.entries()) {
    const listId = lists[people[who]!.email]!;
    const item: WishItem = { id: `w${i + 1}`, listId, title, link, price, priority, notes: notes2, addedAt: now };
    ids.push(item.id);
    await deps.store.put({ ...keys.item(listId, item.id), ...item });
  }
  // [item index, claimer, bought]: the member has claimed two; relatives claimed others.
  const claims: [number, number, boolean][] = [
    [0, 1, false], // the member claimed the organizer's skillet
    [6, 1, true], // ...and bought Nana's crossword book
    [3, 2, false], // Nana claimed the member's jacket
    [10, 0, false], // the organizer claimed Theo's board game
    [7, 3, false], // Theo claimed Nana's shears
  ];
  for (const [idx, who, bought] of claims) {
    const [owner] = items[idx]!;
    const listId = lists[people[owner]!.email]!;
    const p = people[who]!;
    const claim: Claim = { itemId: ids[idx]!, listId, claimerEmail: p.email, claimerName: p.name, bought, claimedAt: now };
    await deps.store.put({ ...keys.claim(listId, claim.itemId), ...keys.byClaimer(p.email, now), ...claim });
  }
}
