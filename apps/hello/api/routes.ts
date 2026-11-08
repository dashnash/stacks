import { notFound, requireString, strip, type AppDeps, type AppRoutes, type Item } from '@stacks/api';

export interface Greeting {
  id: string;
  text: string;
  authorEmail: string;
  authorName: string;
  createdAt: string;
}
type GreetingItem = Item & Greeting;

export const MAX_GREETING = 280;
const PK = 'GREETINGS';

async function latest(deps: AppDeps, limit: number): Promise<Greeting[]> {
  // SK is "<iso time>#<id>", so the partition reads oldest first.
  const items = await deps.store.query<GreetingItem>(PK);
  return items.reverse().slice(0, limit).map((i) => strip(i));
}

/** Hello Board's API. The same routes run in Lambda, in tests and in the browser demo. */
export function routes(api: AppRoutes<AppDeps>) {
  api
    // Public footprint: the latest greetings, first names only, no emails.
    .public('GET', '/public/greetings', async (_req, ctx) => ({
      body: { greetings: (await latest(ctx.deps, 10)).map(({ id, text, authorName, createdAt }) => ({ id, text, authorName, createdAt })) },
    }))
    .member('GET', '/greetings', async (_req, v) => ({ body: { greetings: await latest(v.deps, 100), canDelete: v.canManageAccess } }))
    .member(
      'POST',
      '/greetings',
      async (req, v) => {
        const text = requireString(req.body, 'text', MAX_GREETING);
        const now = v.deps.now().toISOString();
        const greeting: Greeting = { id: v.deps.newId(), text, authorEmail: v.user.email, authorName: v.user.name, createdAt: now };
        await v.deps.store.put({ PK, SK: `${now}#${greeting.id}`, ...greeting });
        return { status: 201, body: { greeting }, audit: { label: text.slice(0, 40) } };
      },
      { audit: 'greeting.post' },
    )
    .approver(
      'DELETE',
      '/greetings/:id',
      async (req, v) => {
        const found = (await v.deps.store.query<GreetingItem>(PK)).find((g) => g.id === req.params.id);
        if (!found) throw notFound('That greeting is gone');
        await v.deps.store.delete(found.PK, found.SK);
        return { body: { ok: true }, audit: { label: found.text.slice(0, 40), author: found.authorEmail } };
      },
      { audit: 'greeting.delete' },
    );
}
