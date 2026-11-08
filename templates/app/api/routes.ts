import { notFound, requireString, strip, type AppDeps, type AppRoutes, type Item } from '@stacks/api';

/**
 * STARTER FEATURE: a shared list of notes, so the app works end to end from the first commit
 * (public route, member routes, an approver-only route, audit events, tests, demo data).
 * Replace it with the features in BRIEF.md, keeping the same shape: one route file per feature,
 * a test for every route, sample data in demo-data.ts.
 */
export interface Note {
  id: string;
  text: string;
  authorEmail: string;
  authorName: string;
  createdAt: string;
}
type NoteItem = Item & Note;

export const MAX_NOTE = 500;
const PK = 'NOTES';

async function latest(deps: AppDeps, limit: number): Promise<Note[]> {
  // SK is "<iso time>#<id>", so the partition reads oldest first.
  const items = await deps.store.query<NoteItem>(PK);
  return items.reverse().slice(0, limit).map((i) => strip(i));
}

/** The app's API. The same routes run in Lambda, in tests and in the browser demo. */
export function routes(api: AppRoutes<AppDeps>) {
  api
    // Public footprint: what signed-out visitors may see (here, just a count).
    .public('GET', '/public/stats', async (_req, ctx) => ({ body: { notes: (await ctx.deps.store.query(PK)).length } }))
    .member('GET', '/notes', async (_req, v) => ({ body: { notes: await latest(v.deps, 100), canDelete: v.canManageAccess } }))
    .member(
      'POST',
      '/notes',
      async (req, v) => {
        const text = requireString(req.body, 'text', MAX_NOTE);
        const now = v.deps.now().toISOString();
        const note: Note = { id: v.deps.newId(), text, authorEmail: v.user.email, authorName: v.user.name, createdAt: now };
        await v.deps.store.put({ PK, SK: `${now}#${note.id}`, ...note });
        return { status: 201, body: { note }, audit: { label: text.slice(0, 40) } };
      },
      { audit: 'note.post' },
    )
    .approver(
      'DELETE',
      '/notes/:id',
      async (req, v) => {
        const found = (await v.deps.store.query<NoteItem>(PK)).find((n) => n.id === req.params.id);
        if (!found) throw notFound('That note is gone');
        await v.deps.store.delete(found.PK, found.SK);
        return { body: { ok: true }, audit: { label: found.text.slice(0, 40), author: found.authorEmail } };
      },
      { audit: 'note.delete' },
    );
}
