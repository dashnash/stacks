import { ConditionFailedError, conflict, forbidden, getPeople, notFound, strip, type AppDeps, type AppRoutes } from '@stacks/api';
import { loadList } from './lists';
import { keys, myListId, type Claim, type ClaimItem } from './model';

export function claimRoutes(api: AppRoutes<AppDeps>) {
  api
    .member(
      'POST',
      '/lists/:listId/items/:id/claim',
      async (req, v) => {
        const listId = req.params.listId!;
        if (listId === (await myListId(v.deps, v.user.id))) throw forbidden("You can't claim from your own list");
        const { meta, items } = await loadList(v.deps, listId);
        const item = items.find((i) => i.id === req.params.id);
        if (!meta || !item) throw notFound('That item is gone');
        const claimedAt = v.deps.now().toISOString();
        const claim: Claim = { itemId: item.id, listId, claimerId: v.user.id, bought: false, claimedAt };
        try {
          await v.deps.store.put({ ...keys.claim(listId, item.id), ...keys.byClaimer(v.user.id, claimedAt), ...claim }, { ifNotExists: true });
        } catch (err) {
          if (err instanceof ConditionFailedError) throw conflict('Someone already claimed that');
          throw err;
        }
        return { status: 201, body: { claim }, audit: { label: `${item.title} for ${(await getPeople(v.deps, [meta.ownerId])).get(meta.ownerId)?.name ?? 'Former member'}` } };
      },
      { audit: 'claim.add' },
    )
    .member(
      'PATCH',
      '/lists/:listId/items/:id/claim',
      async (req, v) => {
        const k = keys.claim(req.params.listId!, req.params.id!);
        const found = await v.deps.store.get<ClaimItem>(k.PK, k.SK);
        if (!found || found.claimerId !== v.user.id) throw notFound("You haven't claimed that");
        const claim = { ...(strip(found) as Claim), bought: req.body.bought === true };
        await v.deps.store.put({ ...k, ...keys.byClaimer(claim.claimerId, claim.claimedAt), ...claim });
        return { body: { claim }, audit: { label: claim.itemId, bought: claim.bought } };
      },
      { audit: 'claim.bought' },
    )
    .member(
      'DELETE',
      '/lists/:listId/items/:id/claim',
      async (req, v) => {
        const k = keys.claim(req.params.listId!, req.params.id!);
        const found = await v.deps.store.get<ClaimItem>(k.PK, k.SK);
        if (!found || found.claimerId !== v.user.id) throw notFound("You haven't claimed that");
        await v.deps.store.delete(k.PK, k.SK);
        return { body: { ok: true }, audit: { label: found.itemId } };
      },
      { audit: 'claim.remove' },
    )
    // Your shopping list: everything you've claimed, grouped by whose list it's on.
    .member('GET', '/me/claims', async (_req, v) => {
      const claims = await v.deps.store.queryGsi1<ClaimItem>(keys.byClaimer(v.user.id, '').GSI1PK);
      const byList = new Map<string, { listId: string; ownerId: string; items: unknown[] }>();
      for (const c of claims) {
        const { meta, items } = await loadList(v.deps, c.listId);
        const item = items.find((i) => i.id === c.itemId);
        if (!meta || !item) continue;
        const group = byList.get(c.listId) ?? { listId: c.listId, ownerId: meta.ownerId, items: [] };
        group.items.push({ ...item, bought: c.bought });
        byList.set(c.listId, group);
      }
      const people = await getPeople(v.deps, [...byList.values()].map((g) => g.ownerId));
      const groups = [...byList.values()].map(({ ownerId, ...g }) => ({ ...g, ownerName: people.get(ownerId)?.name ?? 'Former member' }));
      return { body: { groups: groups.sort((a, b) => a.ownerName.localeCompare(b.ownerName)) } };
    });
}
