/** Every item in an app's single table carries its keys alongside its attributes. */
export interface Item {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  [attr: string]: unknown;
}

/**
 * The single-table access surface apps use. Domain code talks to this interface only, so tests
 * and the in-browser demo can swap in {@link MemoryStore}.
 */
export interface Store {
  get<T extends Item>(pk: string, sk: string): Promise<T | undefined>;
  /** Put an item. With `ifNotExists`, fails with {@link ConditionFailedError} when the key exists. */
  put(item: Item, opts?: { ifNotExists?: boolean }): Promise<void>;
  delete(pk: string, sk: string): Promise<void>;
  /** All items under a partition, optionally filtered by sort-key prefix, ascending by SK. */
  query<T extends Item>(pk: string, skPrefix?: string): Promise<T[]>;
  /** All items in a GSI1 partition, ascending by GSI1SK (or descending with `descending`). */
  queryGsi1<T extends Item>(gsi1pk: string, opts?: { descending?: boolean }): Promise<T[]>;
}

export class ConditionFailedError extends Error {}

/** In-memory {@link Store} with the same ordering semantics as DynamoDB. */
export class MemoryStore implements Store {
  readonly items = new Map<string, Item>();

  constructor(initial: Iterable<Item> = []) {
    for (const item of initial) this.items.set(this.key(item.PK, item.SK), structuredClone(item));
  }

  private key(pk: string, sk: string) {
    return `${pk}\u0000${sk}`;
  }

  async get<T extends Item>(pk: string, sk: string): Promise<T | undefined> {
    const item = this.items.get(this.key(pk, sk));
    return item ? (structuredClone(item) as T) : undefined;
  }

  async put(item: Item, opts: { ifNotExists?: boolean } = {}): Promise<void> {
    const key = this.key(item.PK, item.SK);
    if (opts.ifNotExists && this.items.has(key)) throw new ConditionFailedError(`Item ${item.PK}/${item.SK} already exists`);
    const clean = Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)) as Item;
    this.items.set(key, structuredClone(clean));
  }

  async delete(pk: string, sk: string): Promise<void> {
    this.items.delete(this.key(pk, sk));
  }

  async query<T extends Item>(pk: string, skPrefix = ''): Promise<T[]> {
    return [...this.items.values()]
      .filter((i) => i.PK === pk && i.SK.startsWith(skPrefix))
      .sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0))
      .map((i) => structuredClone(i) as T);
  }

  async queryGsi1<T extends Item>(gsi1pk: string, opts: { descending?: boolean } = {}): Promise<T[]> {
    const sorted = [...this.items.values()]
      .filter((i) => i.GSI1PK === gsi1pk && i.GSI1SK !== undefined)
      .sort((a, b) => (a.GSI1SK! < b.GSI1SK! ? -1 : a.GSI1SK! > b.GSI1SK! ? 1 : 0));
    if (opts.descending) sorted.reverse();
    return sorted.map((i) => structuredClone(i) as T);
  }
}

/** Drop the table keys from an item. */
export function strip<T extends object>(item: Item & T): T {
  const { PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g2, ...rest } = item;
  return rest as unknown as T;
}
