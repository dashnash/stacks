import { badRequest, notFound, strip, type AppDeps, type AppRoutes, type Item } from '@stacks/api';
import {
  addedText,
  body,
  editedText,
  getList,
  itemName,
  itemQuantity,
  keys,
  listItems,
  listName,
  LISTS_CHANNEL,
  MAX_ITEMS_PER_ADD,
  MAX_RESTORE,
  nameKey,
  notifyListChange,
  publishListChange,
  rankSuggestions,
  recordHistory,
  touchList,
  type GroceryItem,
  type HistoryEntry,
  type ListMeta,
} from './model';

export * from './model';

/** One list in the index, with the caller's mute state. */
export interface ListSummary extends ListMeta {
  muted: boolean;
}

/** `GET /lists/:id` */
export type ListResponse = { unchanged: true; version: number } | { unchanged?: false; list: ListMeta; items: GroceryItem[]; muted: boolean };

const ID = /^[A-Za-z0-9-]{1,64}$/;
const ISO = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

function itemId(v: unknown): string {
  if (typeof v !== 'string' || !ID.test(v)) throw badRequest('Bad item id');
  return v;
}

async function isMuted(deps: AppDeps, listId: string, userId: string): Promise<boolean> {
  const k = keys.mute(listId, userId);
  return !!(await deps.store.get(k.PK, k.SK));
}

async function getItem(deps: AppDeps, listId: string, id: string): Promise<GroceryItem> {
  const k = keys.item(listId, id);
  const row = await deps.store.get<Item & GroceryItem>(k.PK, k.SK);
  if (!row) throw notFound('That item is gone');
  return strip(row) as GroceryItem;
}

const putItem = (deps: AppDeps, listId: string, item: GroceryItem) => deps.store.put({ ...keys.item(listId, item.id), ...item });

/** Pantry's API: lists, items, autocomplete history, mutes. Every route is for members only. */
export function routes(api: AppRoutes<AppDeps>) {
  // Server-publish-only hints (see model.ts publishListChange). Every member sees every list.
  api.realtime
    .channel(LISTS_CHANNEL, { subscribe: (v) => !!v.role, publish: false })
    .channel('list/*', { subscribe: (v, _listId) => !!v.role, publish: false });

  // ------------------------------------------------------------ lists
  api
    .member('GET', '/lists', async (_req, v) => {
      const rows = await v.deps.store.queryGsi1<Item & ListMeta>('LISTS');
      const lists: ListSummary[] = await Promise.all(rows.map(async (r) => ({ ...(strip(r) as ListMeta), muted: await isMuted(v.deps, r.id, v.user.id) })));
      return { body: { lists } };
    })
    .member(
      'POST',
      '/lists',
      async (req, v) => {
        const name = listName(body(req).name);
        const now = v.deps.now().toISOString();
        const list: ListMeta = { id: v.deps.newId(), name, version: 1, open: 0, done: 0, createdBy: v.user.id, createdAt: now, updatedAt: now };
        await v.deps.store.put({ ...keys.meta(list.id), GSI1PK: 'LISTS', GSI1SK: now, ...list }, { ifNotExists: true });
        await publishListChange(v.deps, list.id, { version: list.version }, true);
        return { status: 201, body: { list }, audit: { label: name } };
      },
      { audit: 'list.create' },
    )
    .member(
      'PATCH',
      '/lists/:id',
      async (req, v) => {
        const name = listName(body(req).name);
        const meta = await getList(v.deps, req.params.id!);
        const { meta: list } = await touchList(v.deps, { ...meta, name }, { indexChanged: true });
        return { body: { list }, audit: { label: name } };
      },
      { audit: 'list.rename' },
    )
    .member(
      'DELETE',
      '/lists/:id',
      async (req, v) => {
        const meta = await getList(v.deps, req.params.id!);
        // Items, history, mutes, throttle records and the list itself.
        const rows = await v.deps.store.query(`LIST#${meta.id}`);
        for (const r of rows) await v.deps.store.delete(r.PK, r.SK);
        await publishListChange(v.deps, meta.id, { deleted: true }, true);
        return { body: { ok: true }, audit: { label: meta.name } };
      },
      { audit: 'list.delete' },
    )
    .member('GET', '/lists/:id', async (req, v) => {
      const list = await getList(v.deps, req.params.id!);
      const since = req.query.since === undefined ? NaN : Number(req.query.since);
      if (since === list.version) return { body: { unchanged: true, version: list.version } satisfies ListResponse };
      const [items, muted] = await Promise.all([listItems(v.deps, list.id), isMuted(v.deps, list.id, v.user.id)]);
      return { body: { list, items, muted } satisfies ListResponse };
    })
    .member('PUT', '/lists/:id/mute', async (req, v) => {
      const muted = body(req).muted;
      if (typeof muted !== 'boolean') throw badRequest('"muted" must be true or false');
      const list = await getList(v.deps, req.params.id!);
      const k = keys.mute(list.id, v.user.id);
      if (muted) await v.deps.store.put({ ...k, userId: v.user.id, at: v.deps.now().toISOString() });
      else await v.deps.store.delete(k.PK, k.SK);
      return { body: { muted } };
    });

  // ------------------------------------------------------------ items
  api
    .member(
      'POST',
      '/lists/:id/items',
      async (req, v) => {
        const raw = body(req).items;
        if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ITEMS_PER_ADD) throw badRequest(`Send 1 to ${MAX_ITEMS_PER_ADD} items`);
        const input = raw.map((r) => {
          if (!r || typeof r !== 'object') throw badRequest('Each item needs a name');
          const o = r as Record<string, unknown>;
          return { name: itemName(o.name), quantity: itemQuantity(o.quantity) };
        });
        const meta = await getList(v.deps, req.params.id!);
        const added: GroceryItem[] = [];
        for (const { name, quantity } of input) {
          const now = v.deps.now().toISOString();
          const item: GroceryItem = { id: v.deps.newId(), name, ...(quantity ? { quantity } : {}), done: false, createdBy: v.user.id, updatedBy: v.user.id, createdAt: now, updatedAt: now };
          await putItem(v.deps, meta.id, item);
          await recordHistory(v.deps, meta.id, name, quantity);
          added.push(item);
        }
        const { meta: list, items } = await touchList(v.deps, meta);
        await notifyListChange(v.deps, v.user, list, addedText(v.user.name, added.map((i) => i.name), list.name));
        return { status: 201, body: { list, items, added }, audit: { label: added.map((i) => i.name).join(', ').slice(0, 60), count: added.length } };
      },
      { audit: 'item.add' },
    )
    .member(
      'PATCH',
      '/lists/:id/items/:itemId',
      async (req, v) => {
        const b = body(req);
        const meta = await getList(v.deps, req.params.id!);
        const before = await getItem(v.deps, meta.id, req.params.itemId!);
        const name = b.name === undefined ? before.name : itemName(b.name);
        const quantity = b.quantity === undefined ? before.quantity : itemQuantity(b.quantity);
        if (b.done !== undefined && typeof b.done !== 'boolean') throw badRequest('"done" must be true or false');
        const done = (b.done as boolean | undefined) ?? before.done;
        const now = v.deps.now().toISOString();
        const { quantity: _q, doneAt: _d, ...rest } = before;
        const item: GroceryItem = {
          ...rest,
          name,
          ...(quantity ? { quantity } : {}),
          done,
          // Idempotent: setting done again keeps when it was first checked off.
          ...(done ? { doneAt: before.done ? before.doneAt : now } : {}),
          updatedBy: v.user.id,
          updatedAt: now,
        };
        await putItem(v.deps, meta.id, item);
        const renamed = name !== before.name;
        const requantified = quantity !== before.quantity;
        if (renamed || requantified) await recordHistory(v.deps, meta.id, name, quantity, nameKey(name) !== nameKey(before.name));
        const { meta: list, items } = await touchList(v.deps, meta);
        // Edits notify; check-offs don't.
        if (renamed || requantified) await notifyListChange(v.deps, v.user, list, editedText(v.user.name, name, list.name));
        return { body: { list, items, item }, audit: { label: name, ...(b.done !== undefined ? { done } : {}) } };
      },
      { audit: 'item.update' },
    )
    .member(
      'DELETE',
      '/lists/:id/items/:itemId',
      async (req, v) => {
        const meta = await getList(v.deps, req.params.id!);
        const item = await getItem(v.deps, meta.id, req.params.itemId!);
        const k = keys.item(meta.id, item.id);
        await v.deps.store.delete(k.PK, k.SK);
        const { meta: list, items } = await touchList(v.deps, meta);
        return { body: { list, items, removed: item }, audit: { label: item.name } };
      },
      { audit: 'item.remove' },
    )
    .member(
      'POST',
      '/lists/:id/clear-complete',
      async (req, v) => {
        const meta = await getList(v.deps, req.params.id!);
        const removed = (await listItems(v.deps, meta.id)).filter((i) => i.done);
        for (const i of removed) {
          const k = keys.item(meta.id, i.id);
          await v.deps.store.delete(k.PK, k.SK);
        }
        const { meta: list, items } = await touchList(v.deps, meta);
        return { body: { list, items, removed }, audit: { label: `${removed.length} done`, count: removed.length } };
      },
      { audit: 'item.clear' },
    )
    // Undo: put back the exact items (same ids, names, done state and times) as they were.
    .member(
      'POST',
      '/lists/:id/items/restore',
      async (req, v) => {
        const raw = body(req).items;
        if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RESTORE) throw badRequest(`Send 1 to ${MAX_RESTORE} items`);
        const restored = raw.map((r): GroceryItem => {
          if (!r || typeof r !== 'object') throw badRequest('Bad item');
          const o = r as Record<string, unknown>;
          const quantity = itemQuantity(o.quantity);
          if (typeof o.done !== 'boolean' || !ISO(o.createdAt) || !ISO(o.updatedAt) || (o.doneAt !== undefined && !ISO(o.doneAt))) throw badRequest('Bad item');
          if (typeof o.createdBy !== 'string' || o.createdBy.length > 100) throw badRequest('Bad item');
          return {
            id: itemId(o.id),
            name: itemName(o.name),
            ...(quantity ? { quantity } : {}),
            done: o.done,
            ...(o.done && o.doneAt ? { doneAt: o.doneAt as string } : {}),
            createdBy: o.createdBy,
            updatedBy: v.user.id,
            createdAt: o.createdAt,
            updatedAt: o.updatedAt,
          };
        });
        const meta = await getList(v.deps, req.params.id!);
        for (const item of restored) await putItem(v.deps, meta.id, item);
        const { meta: list, items } = await touchList(v.deps, meta);
        return { body: { list, items }, audit: { label: restored.map((i) => i.name).join(', ').slice(0, 60), count: restored.length } };
      },
      { audit: 'item.restore' },
    );

  // ------------------------------------------------------------ autocomplete history
  api
    .member('GET', '/lists/:id/suggestions', async (req, v) => {
      const list = await getList(v.deps, req.params.id!);
      const q = String(req.query.q ?? '').slice(0, 80);
      const entries = (await v.deps.store.query<Item & HistoryEntry>(`LIST#${list.id}`, 'HIST#')).map((e) => strip(e) as HistoryEntry);
      return { body: { suggestions: rankSuggestions(entries, q) } };
    })
    .member(
      'DELETE',
      '/lists/:id/suggestions/:key',
      async (req, v) => {
        const list = await getList(v.deps, req.params.id!);
        const key = nameKey(req.params.key ?? '');
        if (!key) throw badRequest('Bad suggestion');
        const k = keys.hist(list.id, key);
        if (!(await v.deps.store.get(k.PK, k.SK))) throw notFound('That suggestion is gone');
        await v.deps.store.delete(k.PK, k.SK);
        return { body: { ok: true }, audit: { label: key } };
      },
      { audit: 'suggestion.remove' },
    );
}
