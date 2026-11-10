import { forbidden, getPeople, notFound, optionalInt, optionalString, optionalUrl, requireString, strip, type AppDeps, type AppRoutes, type Viewer } from '@stacks/api';
import { keys, myListId, parsePriority, type ClaimItem, type ItemRecord, type ListMeta, type MetaItem, type WishItem } from './model';

async function loadList(deps: AppDeps, listId: string) {
  const rows = await deps.store.query<MetaItem | ItemRecord>(`LIST#${listId}`);
  const meta = rows.find((r) => r.SK === 'META') as MetaItem | undefined;
  const items = rows.filter((r) => r.SK.startsWith('ITEM#')).map((r) => strip(r as ItemRecord) as WishItem);
  return { meta, items };
}

/** Make sure the caller's list exists (created on first write). */
async function ensureMyList(v: Viewer<AppDeps>, patch: Partial<Pick<ListMeta, 'note'>> = {}): Promise<ListMeta> {
  const listId = await myListId(v.deps, v.user.id);
  const current = await v.deps.store.get<MetaItem>(keys.meta(listId).PK, keys.meta(listId).SK);
  const meta: ListMeta = { listId, ownerId: v.user.id, note: current?.note ?? '', updatedAt: v.deps.now().toISOString(), ...patch };
  await v.deps.store.put({ ...keys.meta(listId), ...keys.directory(listId), ...meta });
  return meta;
}

/** A list owner's current name ("Former member" once they've left). */
async function ownerNameOf(deps: AppDeps, ownerId: string): Promise<string> {
  return (await getPeople(deps, [ownerId])).get(ownerId)?.name ?? 'Former member';
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
    await deps.platform.notify(claim.claimerId, `${ownerName} took "${item.title}" off their list, so your claim was released.`, `${deps.config.appOrigin}/#/l/${listId}`).catch(() => undefined);
  }
}

export function listRoutes(api: AppRoutes<AppDeps>) {
  api
    // Everyone's lists, A-Z, with how much is still available on other people's lists.
    .member('GET', '/lists', async (_req, v) => {
      const mine = await myListId(v.deps, v.user.id);
      const metas = await v.deps.store.queryGsi1<MetaItem>('LISTS');
      const people = await getPeople(v.deps, metas.map((m) => m.ownerId));
      const lists = await Promise.all(
        metas.map(async (m) => {
          const { items } = await loadList(v.deps, m.listId);
          const isMine = m.listId === mine;
          const claimed = isMine ? null : (await v.deps.store.query<ClaimItem>(`CLAIMS#${m.listId}`)).length;
          const ownerName = people.get(m.ownerId)?.name ?? 'Former member';
          return { listId: m.listId, ownerName, mine: isMine, items: items.length, available: claimed === null ? null : items.length - claimed };
        }),
      );
      lists.sort((a, b) => a.ownerName.localeCompare(b.ownerName));
      return { body: { lists, myListId: mine } };
    })
    .member('GET', '/lists/:listId', async (req, v) => {
      const listId = req.params.listId!;
      const { meta, items } = await loadList(v.deps, listId);
      const mine = listId === (await myListId(v.deps, v.user.id));
      if (!meta && !mine) throw notFound('That list is gone');
      const list = { listId, ownerName: mine || !meta ? v.user.name : await ownerNameOf(v.deps, meta.ownerId), note: meta?.note ?? '', mine };
      // Your own list: items only. Claims are not read, so nothing can leak.
      if (mine) return { body: { list, items, canModerate: v.canManageAccess } };
      const claims = new Map((await v.deps.store.query<ClaimItem>(`CLAIMS#${listId}`)).map((c) => [c.itemId, c]));
      return {
        body: {
          list,
          canModerate: v.canManageAccess,
          items: items.map((i) => {
            const c = claims.get(i.id);
            return { ...i, status: !c ? 'available' : c.claimerId === v.user.id ? 'mine' : 'taken', bought: c?.claimerId === v.user.id ? c.bought : undefined };
          }),
        },
      };
    })
    .member(
      'PUT',
      '/me/note',
      async (req, v) => {
        const meta = await ensureMyList(v, { note: optionalString(req.body, 'note', 300) ?? '' });
        return { body: { list: { ...meta, ownerName: v.user.name } }, audit: { label: 'note' } };
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
        const listId = await myListId(v.deps, v.user.id);
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
        const listId = await myListId(v.deps, v.user.id);
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
        if (meta.listId === (await myListId(v.deps, v.user.id))) throw forbidden('Use your own list to remove your items');
        const ownerName = await ownerNameOf(v.deps, meta.ownerId);
        await removeItem(v.deps, meta.listId, item, ownerName);
        return { body: { ok: true }, audit: { label: `${item.title} (${ownerName}'s list)` } };
      },
      { audit: 'item.moderate' },
    );
}

export { loadList };
