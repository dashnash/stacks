import { badRequest, forbidden, getPeople, isUser, notFound, renameEmailField, strip, type AppDeps, type AppRoutes, type Item, type ItemMigration, type Person, type Store, type Viewer } from '@stacks/api';

/**
 * Threaded comments on anything an app has (the `comments` module), generalized from Book Club.
 * Storage: one partition per thread, `THREAD#<KIND>#<id>`, with `COMMENT#<id>` items and a `COUNT`
 * item, so lists can show counts without loading every comment.
 */

export interface ThreadTarget {
  /** Lower-case kind as used in the URL, e.g. "book". */
  kind: string;
  id: string;
}

export interface Comment {
  id: string;
  parentId?: string;
  /** The author's platform user id. */
  authorId: string;
  body: string;
  createdAt: string;
  editedAt?: string;
  deleted?: boolean;
}

export interface CommentView {
  id: string;
  parentId: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  body: string;
  author: Person | null;
  canEdit: boolean;
  canDelete: boolean;
}

/** For each kind: does this target exist? Return its canonical id and a label for the activity log, or null. */
export type TargetResolver<D extends AppDeps> = (id: string, deps: D) => Promise<{ id: string; label: string } | null>;

export interface CommentOptions<D extends AppDeps> {
  targets: Record<string, TargetResolver<D>>;
  /** Default 2,000 characters. */
  maxLength?: number;
  /** Who may delete anyone's comment. Default: roles that manage access. */
  canModerate?: (viewer: Viewer<D>) => boolean;
}

type CommentItem = Item & Comment;
const threadKey = (t: ThreadTarget) => `THREAD#${t.kind.toUpperCase()}#${t.id}`;
const commentKey = (t: ThreadTarget, id: string) => ({ PK: threadKey(t), SK: `COMMENT#${id}` });
const countKey = (t: ThreadTarget) => ({ PK: threadKey(t), SK: 'COUNT' });

/** All comments in a thread, oldest first (deleted ones included, so replies keep their place). */
export async function listComments(store: Store, target: ThreadTarget): Promise<Comment[]> {
  const items = await store.query<CommentItem>(threadKey(target), 'COMMENT#');
  return items.map((i) => strip(i) as Comment).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Recount a thread's visible comments (recounted, not incremented, so concurrent posts can't skew it). */
async function recount(store: Store, target: ThreadTarget): Promise<number> {
  const count = (await listComments(store, target)).filter((c) => !c.deleted).length;
  await store.put({ ...countKey(target), count });
  return count;
}

/** Visible comment counts for several threads. */
export async function commentCounts(store: Store, targets: ThreadTarget[]): Promise<number[]> {
  return Promise.all(
    targets.map(async (t) => {
      const { PK, SK } = countKey(t);
      const stored = await store.get<Item & { count: number }>(PK, SK);
      return stored ? stored.count : recount(store, t);
    }),
  );
}

/**
 * Add the thread routes: `GET|POST /threads/:kind/:id`, `PATCH|DELETE /threads/:kind/:id/comments/:commentId`.
 * Posting, editing and deleting are logged as `comment.post`, `comment.edit`, `comment.delete`.
 */
export function commentRoutes<D extends AppDeps>(api: AppRoutes<D>, opts: CommentOptions<D>): void {
  const max = opts.maxLength ?? 2000;
  const canModerate = opts.canModerate ?? ((v: Viewer<D>) => v.canManageAccess);

  async function target(params: Record<string, string>, deps: D): Promise<ThreadTarget & { label: string }> {
    const resolve = opts.targets[params.kind ?? ''];
    if (!resolve) throw notFound(`Threads are for ${Object.keys(opts.targets).join(' and ')}`);
    const found = await resolve(params.id ?? '', deps);
    if (!found) throw notFound(`No such ${params.kind}`);
    return { kind: params.kind!, id: found.id, label: found.label };
  }
  const requireBody = (body: Record<string, unknown>) => {
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text) throw badRequest('Write something first');
    if (text.length > max) throw badRequest(`Comments can be up to ${max} characters`);
    return text;
  };
  async function requireComment(deps: D, t: ThreadTarget, id: string): Promise<Comment> {
    const { PK, SK } = commentKey(t, id);
    const item = await deps.store.get<CommentItem>(PK, SK);
    if (!item || item.deleted) throw notFound('Comment not found');
    return strip(item) as Comment;
  }
  async function view(v: Viewer<D>, comments: Comment[]): Promise<CommentView[]> {
    const people = await getPeople(v.deps, comments.filter((c) => !c.deleted).map((c) => c.authorId));
    return comments.map((c) => ({
      id: c.id,
      parentId: c.parentId ?? null,
      createdAt: c.createdAt,
      editedAt: c.editedAt ?? null,
      deleted: !!c.deleted,
      body: c.deleted ? '' : c.body,
      author: c.deleted ? null : (people.get(c.authorId) ?? null),
      canEdit: !c.deleted && isUser(v.user, c.authorId),
      canDelete: !c.deleted && (isUser(v.user, c.authorId) || canModerate(v)),
    }));
  }

  api
    .member('GET', '/threads/:kind/:id', async (req, v) => {
      const { label: _label, ...t } = await target(req.params, v.deps);
      return { body: { target: t, comments: await view(v, await listComments(v.deps.store, t)) } };
    })
    .member(
      'POST',
      '/threads/:kind/:id',
      async (req, v) => {
        const t = await target(req.params, v.deps);
        const body = requireBody(req.body);
        const parentId = typeof req.body.parentId === 'string' && req.body.parentId ? req.body.parentId : undefined;
        if (parentId) {
          const parent = await v.deps.store.get<CommentItem>(commentKey(t, parentId).PK, commentKey(t, parentId).SK);
          if (!parent) throw notFound('Comment not found');
          if (parent.deleted) throw badRequest("You can't reply to a deleted comment");
        }
        const comment: Comment = { id: v.deps.newId(), ...(parentId ? { parentId } : {}), authorId: v.user.id, body, createdAt: v.deps.now().toISOString() };
        await v.deps.store.put({ ...commentKey(t, comment.id), ...comment });
        await recount(v.deps.store, t);
        const [out] = await view(v, [comment]);
        return { status: 201, body: { comment: out }, audit: { label: t.label } };
      },
      { audit: 'comment.post' },
    )
    .member(
      'PATCH',
      '/threads/:kind/:id/comments/:commentId',
      async (req, v) => {
        const t = await target(req.params, v.deps);
        const comment = await requireComment(v.deps, t, req.params.commentId!);
        if (!isUser(v.user, comment.authorId)) throw forbidden('You can only edit your own comments');
        const updated: Comment = { ...comment, body: requireBody(req.body), editedAt: v.deps.now().toISOString() };
        await v.deps.store.put({ ...commentKey(t, updated.id), ...updated });
        const [out] = await view(v, [updated]);
        return { body: { comment: out }, audit: { label: t.label, before: comment.body } };
      },
      { audit: 'comment.edit' },
    )
    .member(
      'DELETE',
      '/threads/:kind/:id/comments/:commentId',
      async (req, v) => {
        const t = await target(req.params, v.deps);
        const comment = await requireComment(v.deps, t, req.params.commentId!);
        if (!isUser(v.user, comment.authorId) && !canModerate(v)) throw forbidden('You can only delete your own comments');
        // A comment with replies is blanked, not removed, so the conversation under it stays put.
        const hasReplies = (await listComments(v.deps.store, t)).some((c) => c.parentId === comment.id);
        if (hasReplies) await v.deps.store.put({ ...commentKey(t, comment.id), ...comment, body: '', deleted: true });
        else {
          const { PK, SK } = commentKey(t, comment.id);
          await v.deps.store.delete(PK, SK);
        }
        await recount(v.deps.store, t);
        return { body: { ok: true }, audit: { label: t.label, author: comment.authorId, text: comment.body, byModerator: !isUser(v.user, comment.authorId) } };
      },
      { audit: 'comment.delete' },
    );
}

/** The user-id cut-over for comments: `authorEmail` becomes `authorId` (see `tools/migrate-user-ids`). */
export const migrateComments: ItemMigration = (item, idFor) =>
  item.PK.startsWith('THREAD#') && item.SK.startsWith('COMMENT#') && 'authorEmail' in item ? renameEmailField(item, 'authorEmail', 'authorId', idFor) : undefined;
