import { fixtureUserId, type AppDeps } from '@stacks/api';
import type { Persona } from '@stacks/demo';
import { keys, nameKey, type GroceryItem, type HistoryEntry, type ListMeta } from './model';

/** One persona per role (top role first, so "Sign in" in the demo shows every control). Fictional. */
export const personas: Persona[] = [
  { email: 'sam@demo.stacks', name: 'Sam', role: 'OWNER', blurb: 'Owner (lets people in)' },
  { email: 'alex@demo.stacks', name: 'Alex', role: 'MEMBER', blurb: 'Member' },
];

const SAM = fixtureUserId('sam@demo.stacks');
const ALEX = fixtureUserId('alex@demo.stacks');

/** Fixed ids so pages can be linked (`#/l/weekly-shop`). */
export const WEEKLY = 'weekly-shop';
export const COSTCO = 'costco-run';

type Seed = [name: string, quantity: string | undefined, by: string, done?: boolean];

const weekly: Seed[] = [
  ['Milk', '2', SAM],
  ['Sourdough bread', undefined, ALEX],
  ['Bananas', '6', SAM],
  ['Greek yogurt', '1 tub', ALEX],
  ['Spinach', '1 bag', SAM],
  ['Coffee beans', undefined, ALEX],
  ['Eggs', '12', SAM, true],
  ['Lemons', '3', ALEX, true],
];
const costco: Seed[] = [
  ['Paper towels', '1 pack', SAM],
  ['Olive oil', '2 L', ALEX],
  ['Frozen berries', 'a few bags', SAM],
  ['Dishwasher tablets', undefined, ALEX],
];
/** Earlier buys, so autocomplete has something to show straight away: [name, quantity, uses]. */
const pastWeekly: [string, string | undefined, number][] = [
  ['Mushrooms', '250 g', 3],
  ['Mustard', undefined, 1],
  ['Almond milk', '1', 4],
  ['Oat milk', '2', 2],
  ['Butter', '1', 5],
  ['Tomatoes', '4', 3],
  ['Cheddar', 'a block', 2],
];

async function seedList(deps: AppDeps, id: string, name: string, items: Seed[], past: [string, string | undefined, number][], start: Date, createdAt: Date) {
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000).toISOString();
  let open = 0;
  let done = 0;
  for (const [i, [itemName, quantity, by, isDone]] of items.entries()) {
    const item: GroceryItem = {
      id: `${id}-${i + 1}`,
      name: itemName,
      ...(quantity ? { quantity } : {}),
      done: !!isDone,
      ...(isDone ? { doneAt: at(60 + i) } : {}),
      createdBy: by,
      updatedBy: by,
      createdAt: at(i),
      updatedAt: at(isDone ? 60 + i : i),
    };
    await deps.store.put({ ...keys.item(id, item.id), ...item });
    if (isDone) done++;
    else open++;
  }
  const history: HistoryEntry[] = [
    ...items.map(([n, q], i) => ({ key: nameKey(n), name: n, count: 2 + (i % 3), ...(q ? { lastQuantity: q } : {}), lastUsedAt: at(i) })),
    ...past.map(([n, q, count], i) => ({ key: nameKey(n), name: n, count, ...(q ? { lastQuantity: q } : {}), lastUsedAt: at(-60 * 24 * (i + 1)) })),
  ];
  for (const h of history) await deps.store.put({ ...keys.hist(id, h.key), ...h });
  const meta: ListMeta = { id, name, version: 1, open, done, createdBy: SAM, createdAt: createdAt.toISOString(), updatedAt: at(items.length) };
  await deps.store.put({ ...keys.meta(id), GSI1PK: 'LISTS', GSI1SK: meta.createdAt, ...meta });
}

/** Sample data for the demo: written on first load and after a reset. */
export async function seed(deps: AppDeps): Promise<void> {
  const morning = deps.now();
  morning.setHours(9, 0, 0, 0);
  await seedList(deps, WEEKLY, 'Weekly shop', weekly, pastWeekly, morning, new Date(morning.getTime() - 30 * 86_400_000));
  const earlier = new Date(morning.getTime() - 2 * 86_400_000);
  await seedList(deps, COSTCO, 'Costco run', costco, [['Coffee beans', '2 kg', 2], ['Toilet paper', '1 pack', 3]], earlier, new Date(morning.getTime() - 20 * 86_400_000));
  // Alex muted the Costco run: Sam does that shop.
  await deps.store.put({ ...keys.mute(COSTCO, ALEX), userId: ALEX, at: morning.toISOString() });
}
