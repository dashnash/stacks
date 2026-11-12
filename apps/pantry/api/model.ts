import { appMembers, badRequest, isUser, notFound, strip, type AppDeps, type Item, type StacksUser } from '@stacks/api';

/** Limits (BRIEF.md "What it tracks"). */
export const MAX_NAME = 80;
export const MAX_QUANTITY = 20;
export const MAX_LIST_NAME = 60;
export const MAX_ITEMS_PER_ADD = 20;
export const MAX_RESTORE = 200;
export const MAX_SUGGESTIONS = 8;
/** At most one notification per (list, subscriber) in this window. */
export const NOTIFY_THROTTLE_MS = 10 * 60_000;

export interface ListMeta {
  id: string;
  name: string;
  /** Bumped by every write to the list or its items; `GET /lists/:id?since=` compares it. */
  version: number;
  open: number;
  done: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroceryItem {
  id: string;
  name: string;
  quantity?: string;
  done: boolean;
  /** When it was last checked off (done items sort by it, newest first). */
  doneAt?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  /** The lower-cased, space-collapsed name: one entry per key. */
  key: string;
  name: string;
  count: number;
  lastQuantity?: string;
  lastUsedAt: string;
}

/** What a list's channel carries: a hint, never the data. */
export type ListChange = { version: number } | { deleted: true };

export const LISTS_CHANNEL = 'lists';
export const listChannel = (id: string) => `list/${id}`;

export const keys = {
  meta: (id: string) => ({ PK: `LIST#${id}`, SK: 'META' }),
  item: (listId: string, itemId: string) => ({ PK: `LIST#${listId}`, SK: `ITEM#${itemId}` }),
  hist: (listId: string, key: string) => ({ PK: `LIST#${listId}`, SK: `HIST#${key}` }),
  mute: (listId: string, userId: string) => ({ PK: `LIST#${listId}`, SK: `MUTE#${userId}` }),
  notified: (listId: string, userId: string) => ({ PK: `LIST#${listId}`, SK: `NOTIFIED#${userId}` }),
};

// ---------------------------------------------------------------- validation

const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');

/** The history key for a name: "  Oat  Milk " and "oat milk" share one entry. */
export const nameKey = (name: string) => collapse(name).toLowerCase();

export function itemName(value: unknown, field = 'name'): string {
  if (typeof value !== 'string') throw badRequest(`"${field}" is required`);
  const name = collapse(value);
  if (!name) throw badRequest(`"${field}" is required`);
  if (name.length > MAX_NAME) throw badRequest(`"${field}" must be at most ${MAX_NAME} characters`);
  return name;
}

/** Undefined for "no quantity" (absent, null or blank). */
export function itemQuantity(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest('"quantity" must be text');
  const q = collapse(value);
  if (q.length > MAX_QUANTITY) throw badRequest(`"quantity" must be at most ${MAX_QUANTITY} characters`);
  return q || undefined;
}

export function listName(value: unknown): string {
  if (typeof value !== 'string' || !collapse(value)) throw badRequest('"name" is required');
  const name = collapse(value);
  if (name.length > MAX_LIST_NAME) throw badRequest(`"name" must be at most ${MAX_LIST_NAME} characters`);
  return name;
}

export function body(req: { body: unknown }): Record<string, unknown> {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw badRequest('Send a JSON object');
  return b as Record<string, unknown>;
}

// ---------------------------------------------------------------- reads

export async function getList(deps: AppDeps, id: string): Promise<ListMeta> {
  const k = keys.meta(id);
  const meta = await deps.store.get<Item & ListMeta>(k.PK, k.SK);
  if (!meta) throw notFound('That list is gone');
  return strip(meta) as ListMeta;
}

export async function listItems(deps: AppDeps, listId: string): Promise<GroceryItem[]> {
  const rows = await deps.store.query<Item & GroceryItem>(`LIST#${listId}`, 'ITEM#');
  return sortItems(rows.map((r) => strip(r) as GroceryItem));
}

/** Open items in the order they were added, then done items, most recently checked first. */
export function sortItems(items: GroceryItem[]): GroceryItem[] {
  const open = items.filter((i) => !i.done).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const done = items.filter((i) => i.done).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '') || a.id.localeCompare(b.id));
  return [...open, ...done];
}

// ---------------------------------------------------------------- writes

/**
 * After a write: recount the list, bump its version, save it, and send the hints. Returns the new
 * meta and the list's items. `indexChanged` forces a hint on `lists` (e.g. a rename).
 */
export async function touchList(deps: AppDeps, meta: ListMeta, opts: { indexChanged?: boolean } = {}): Promise<{ meta: ListMeta; items: GroceryItem[] }> {
  const items = await listItems(deps, meta.id);
  const open = items.filter((i) => !i.done).length;
  const done = items.length - open;
  const next: ListMeta = { ...meta, version: meta.version + 1, open, done, updatedAt: deps.now().toISOString() };
  await deps.store.put({ ...keys.meta(meta.id), GSI1PK: 'LISTS', GSI1SK: meta.createdAt, ...next });
  await publishListChange(deps, meta.id, { version: next.version }, opts.indexChanged || open !== meta.open || done !== meta.done);
  return { meta: next, items };
}

/**
 * The one place hints are published: `{ version }` (or `{ deleted }`) on `list/<id>`, and `{}` on
 * `lists` when the index changed. Best effort: a failed publish is logged, never fails the write
 * (clients also refetch on every reconnect and on focus).
 */
export async function publishListChange(deps: AppDeps, listId: string, change: ListChange, indexChanged = false): Promise<void> {
  try {
    await deps.realtime.publish(listChannel(listId), change);
  } catch (err) {
    console.error('Pantry: list publish failed', err);
  }
  if (!indexChanged) return;
  try {
    await deps.realtime.publish(LISTS_CHANNEL, {});
  } catch (err) {
    console.error('Pantry: lists publish failed', err);
  }
}

/** Add to (or refresh) a name's history entry. `use` counts a new use (an add, or a rename to it). */
export async function recordHistory(deps: AppDeps, listId: string, name: string, quantity: string | undefined, use = true): Promise<void> {
  const key = nameKey(name);
  const k = keys.hist(listId, key);
  const prev = await deps.store.get<Item & HistoryEntry>(k.PK, k.SK);
  const lastQuantity = quantity ?? prev?.lastQuantity;
  const entry: HistoryEntry = {
    key,
    name,
    count: (prev?.count ?? 0) + (use ? 1 : 0) || 1,
    ...(lastQuantity ? { lastQuantity } : {}),
    lastUsedAt: deps.now().toISOString(),
  };
  await deps.store.put({ ...k, ...entry });
}

/** Up to 8 history entries for `q`: prefix matches first, then any-word matches, each by use count. */
export function rankSuggestions(entries: HistoryEntry[], q: string): HistoryEntry[] {
  const needle = nameKey(q);
  if (!needle) return [];
  const byCount = (a: HistoryEntry, b: HistoryEntry) => b.count - a.count || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.key.localeCompare(b.key);
  const prefix = entries.filter((e) => e.key.startsWith(needle)).sort(byCount);
  const word = entries.filter((e) => !e.key.startsWith(needle) && e.key.split(/[\s\-/,]+/).some((w) => w.startsWith(needle))).sort(byCount);
  return [...prefix, ...word].slice(0, MAX_SUGGESTIONS);
}

// ---------------------------------------------------------------- notifications

export const addedText = (who: string, names: string[], list: string) =>
  names.length === 1 ? `${who} added ${names[0]} to ${list}` : `${who} added ${names.length} items to ${list}`;
export const editedText = (who: string, name: string, list: string) => `${who} changed ${name} on ${list}`;

/**
 * Tell every subscribed member about a change, except the person who made it. Everyone is
 * subscribed to every list unless they muted it. At most one notification per (list, subscriber)
 * every 10 minutes: changes within 10 minutes of the last one sent are not sent. Best effort.
 */
export async function notifyListChange(deps: AppDeps, actor: StacksUser, list: ListMeta, text: string): Promise<void> {
  try {
    const members = (await appMembers(deps)).filter((m) => !isUser(actor, m.id));
    const now = deps.now();
    const link = `${deps.config.appOrigin}/#/l/${list.id}`;
    await Promise.all(
      members.map(async (m) => {
        try {
          const mk = keys.mute(list.id, m.id);
          if (await deps.store.get(mk.PK, mk.SK)) return;
          const nk = keys.notified(list.id, m.id);
          const last = await deps.store.get<Item & { lastNotifiedAt: string }>(nk.PK, nk.SK);
          if (last && now.getTime() - Date.parse(last.lastNotifiedAt) <= NOTIFY_THROTTLE_MS) return;
          await deps.platform.notify(m.id, text.slice(0, 160), link);
          await deps.store.put({ ...nk, userId: m.id, lastNotifiedAt: now.toISOString() });
        } catch (err) {
          console.error('Pantry: a notification failed', err);
        }
      }),
    );
  } catch (err) {
    console.error('Pantry: could not notify members', err);
  }
}
