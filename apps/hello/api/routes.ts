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

/** The Live panel: the server publishes the shared counter here; only it may. */
export const COUNTER_CHANNEL = 'counter/main';
/** The Live panel's lobby: members wave to each other here (client publishes). */
export const LOBBY_CHANNEL = 'lobby/main';
export interface CounterEvent {
  n: number;
}
/** What a wave carries. Sent by browsers, so the UI checks it before showing it. */
export interface Wave {
  name: string;
}

interface CounterItem extends Item {
  n: number;
}

async function counter(deps: AppDeps): Promise<number> {
  return (await deps.store.get<CounterItem>('COUNTER', 'main'))?.n ?? 0;
}

async function latest(deps: AppDeps, limit: number): Promise<Greeting[]> {
  // SK is "<iso time>#<id>", so the partition reads oldest first.
  const items = await deps.store.query<GreetingItem>(PK);
  return items.reverse().slice(0, limit).map((i) => strip(i));
}

/** Hello Board's API. The same routes run in Lambda, in tests and in the browser demo. */
export function routes(api: AppRoutes<AppDeps>) {
  // Realtime channels: every member may listen; only the server publishes the counter, and any
  // member may wave in the lobby. (`room/*` belongs to the gameServer module: Live dots.) Anything else is refused when a browser asks for a token.
  api.realtime
    .channel('counter/*', { subscribe: (v) => !!v.role, publish: false })
    .channel('lobby/*', { subscribe: (v) => !!v.role, publish: (v) => !!v.role });

  api
    .member('GET', '/counter', async (_req, v) => ({ body: { n: await counter(v.deps) } }))
    // Read-then-write: two clicks in the same instant can count once. Fine for a shared toy counter.
    .member('POST', '/counter', async (_req, v) => {
      const n = (await counter(v.deps)) + 1;
      await v.deps.store.put({ PK: 'COUNTER', SK: 'main', n });
      // A hint to every open tab; they refetch on reconnect, so a missed event is no harm.
      await v.deps.realtime.publish(COUNTER_CHANNEL, { n } satisfies CounterEvent).catch((err) => console.error('Hello: counter publish failed', err));
      return { body: { n } };
    })
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
