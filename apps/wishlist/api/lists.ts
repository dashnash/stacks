import { forbidden, notFound, optionalInt, optionalString, optionalUrl, requireString, strip, type AppDeps, type AppRoutes, type Viewer } from '@stacks/api';
import { keys, listIdFor, parsePriority, type ClaimItem, type ItemRecord, type ListMeta, type MetaItem, type WishItem } from './model';

async function loadList(deps: AppDeps, listId: string) {
  const rows = await deps.store.query<MetaItem | ItemRecord>(`LIST#${listId}`);
  const meta = rows.find((r) => r.SK === 'META') as MetaItem | undefined;
  const items = rows.filter((r) => r.SK.startsWith('ITEM#')).map((r) => strip(r as ItemRecord) as WishItem);
  return { meta, items };
}

/** Make sure the caller's list exists (created on first write), with their current name. */
async function ensureMyList(v: Viewer<AppDeps>, patch: Partial<ListMeta> = {}): Promise<ListMeta> {
  const listId = await listIdFor(v.user.email);
  const current = await v.deps.store.get<MetaItem>(keys.meta(listId).PK, keys.meta(listId).SK);
  const meta: ListMeta = { listId, ownerName: v.user.name, note: current?.note ?? '', updatedAt: v.deps.now().toISOString(), ...patch };
  await v.deps.store.put({ ...keys.meta(listId), ...keys.directory(meta.ownerName, listId), ...meta, ownerEmail: v.user.email });
  return meta;
}

function itemFields(body: Record<string, unknown>, current?: WishItem) {
  const keep = <T,>(field: string, read: () => T, old: T | undefined) => (current && body[field] === undefined ? (old as T) : read());
  return {
    title: keep('title', () => requireString(body, 'title', 80), current?.title),
    link: keep('link', () => optionalUrl(body, 'link') ?? null, current?.link),
    price: keep('price', () => optionalInt(body, 'price', 0, 100_000) ?? null, current?.price),
    priority: keep('priority', () => parsePriority(body.priority), current?.priority),
    notes: keep('notes', () => optionalString(body, 'notes', 300) ?? '', current?.notes),
  };
}

/** Removing an item also drops its claim; the claimer (never the owner) hears about it. */
async function removeItem(deps: AppDeps, listId: string, item: WishItem, ownerName: string) {
  await deps.store.delete(keys.item(listId, item.id).PK, keys.item(listId, item.id).SK);
  const claim = await deps.store.get<ClaimItem>(keys.claim(listId, item.id).PK, keys.claim(listId, item.id).SK);
  if (claim) {
    await deps.store.delete(claim.PK, claim.SK);
    await deps.platform.notify(claim.claimerEmail, `${ownerName} took "${item.title}" off their list, so your claim was released.`, `${deps.config.appOrigin}/#/l/${listId}`).catch(() => undefined);
  }
}

export function listRoutes(api: AppRoutes<AppDeps>) {
  api
    // Everyone's lists, A-Z, with how much is still available on other people's lists.
    .member('GET', '/lists', async (_req, v) => {
      const mine = await listIdFor(v.user.email);
      const metas = await v.deps.store.queryGsi1<MetaItem>('LISTS');
      const lists = await Promise.all(
        metas.map(async (m) => {
          const { items } = await loadList(v.deps, m.listId);
          const isMine = m.listId === mine;
          const claimed = isMine ? null : (await v.deps.store.query<ClaimItem>(`CLAIMS#${m.listId}`)).length;
          return { listId: m.listId, ownerName: m.ownerName, mine: isMine, items: items.length, available: claimed === null ? null : items.length - claimed };
        }),
      );
      return { body: { lists, myListId: mine } };
    })
    .member('GET', '/lists/:listId', async (req, v) => {
      const listId = req.params.listId!;
      const { meta, items } = await loadList(v.deps, listId);
      const mine = listId === (await listIdFor(v.user.email));
      if (!meta && !mine) throw notFound('That list is gone');
      const list = { listId, ownerName: meta?.ownerName ?? v.user.name, note: meta?.note ?? '', mine };
      // Your own list: items only. Claims are not read, so nothing can leak.
      if (mine) return { body: { list, items, canModerate: v.canManageAccess } };
      const claims = new Map((await v.deps.store.query<ClaimItem>(`CLAIMS#${listId}`)).map((c) => [c.itemId, c]));
      return {
        body: {
          list,
          canModerate: v.canManageAccess,
          items: items.map((i) => {
            const c = claims.get(i.id);
            return { ...i, status: !c ? 'available' : c.claimerEmail === v.user.email ? 'mine' : 'taken', bought: c?.claimerEmail === v.user.email ? c.bought : undefined };
          }),
        },
      };
    })
    .member(
      'PUT',
      '/me/note',
      async (req, v) => {
        const meta = await ensureMyList(v, { note: optionalString(req.body, 'note', 300) ?? '' });
        return { body: { list: meta }, audit: { label: 'note' } };
      },
      { audit: 'list.note' },
    )
    .member(
      'POST',
      '/me/items',
      async (req, v) => {
        const meta = await ensureMyList(v);
        const item: WishItem = { id: v.deps.newId(), listId: meta.listId, ...itemFields(req.body), addedAt: v.deps.now().toISOString() };
        await v.deps.store.put({ ...keys.item(meta.listId, item.id), ...item });
        return { status: 201, body: { item }, audit: { label: item.title } };
      },
      { audit: 'item.add' },
    )
    .member(
      'PATCH',
      '/me/items/:id',
      async (req, v) => {
        const listId = await listIdFor(v.user.email);
        const k = keys.item(listId, req.params.id!);
        const found = await v.deps.store.get<ItemRecord>(k.PK, k.SK);
        if (!found) throw notFound('That item is gone');
        const current = strip(found) as WishItem;
        const item: WishItem = { ...current, ...itemFields(req.body, current) };
        await v.deps.store.put({ ...k, ...item });
        return { body: { item }, audit: { label: item.title } };
      },
      { audit: 'item.update' },
    )
    .member(
      'DELETE',
      '/me/items/:id',
      async (req, v) => {
        const listId = await listIdFor(v.user.email);
        const k = keys.item(listId, req.params.id!);
        const found = await v.deps.store.get<ItemRecord>(k.PK, k.SK);
        if (!found) throw notFound('That item is gone');
        await removeItem(v.deps, listId, strip(found) as WishItem, v.user.name);
        // Same answer whether or not it was claimed.
        return { body: { ok: true }, audit: { label: found.title } };
      },
      { audit: 'item.remove' },
    )
    .approver(
      'DELETE',
      '/lists/:listId/items/:id',
      async (req, v) => {
        const { meta, items } = await loadList(v.deps, req.params.listId!);
        const item = items.find((i) => i.id === req.params.id);
        if (!meta || !item) throw notFound('That item is gone');
        if (meta.listId === (await listIdFor(v.user.email))) throw forbidden('Use your own list to remove your items');
        await removeItem(v.deps, meta.listId, item, meta.ownerName);
        return { body: { ok: true }, audit: { label: `${item.title} (${meta.ownerName}'s list)` } };
      },
      { audit: 'item.moderate' },
    );
}

export { loadList };
