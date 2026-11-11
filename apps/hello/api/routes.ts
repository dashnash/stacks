import { appMembers, notFound, requireString, strip, type AppDeps, type AppRoutes, type Item } from '@stacks/api';

export interface Greeting {
  id: string;
  text: string;
  /** The author's platform user id. */
  authorId: string;
  authorName: string;
  createdAt: string;
}
type GreetingItem = Item & Greeting;

export const MAX_GREETING = 280;
const PK = 'GREETINGS';

/** At most this many people hear about one greeting (the board is open to everyone). */
export const MAX_NOTIFIED = 50;

/**
 * Tell every member someone said hi, the author too (so posting from the web is an easy way to see
 * a notification on your own phone): their platform inbox and, with the iOS app, their phones.
 * People who find it noisy mute Hello in Settings › Notifications. Best-effort: a greeting is
 * never lost because a notification failed.
 */
async function tellEveryone(deps: AppDeps, greeting: Greeting): Promise<void> {
  try {
    const members = await appMembers(deps);
    // The author first, so they always hear about their own post even on a busy board.
    const everyone = [...members.filter((m) => m.id === greeting.authorId), ...members.filter((m) => m.id !== greeting.authorId)].slice(0, MAX_NOTIFIED);
    const text = `${greeting.authorName}: ${greeting.text}`.slice(0, 120);
    const results = await Promise.allSettled(everyone.map((m) => deps.platform.notify(m.id, text)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) console.error(`Hello: ${failed} of ${everyone.length} notifications failed`);
  } catch (err) {
    console.error('Hello: could not notify members', err);
  }
}

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
        const greeting: Greeting = { id: v.deps.newId(), text, authorId: v.user.id, authorName: v.user.name, createdAt: now };
        await v.deps.store.put({ PK, SK: `${now}#${greeting.id}`, ...greeting });
        await tellEveryone(v.deps, greeting);
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
        return { body: { ok: true }, audit: { label: found.text.slice(0, 40), author: found.authorId } };
      },
      { audit: 'greeting.delete' },
    );
}
