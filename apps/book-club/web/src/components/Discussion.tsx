import { useState, type FormEvent } from 'react';
import { useApi } from '../lib/auth';
import { timeAgo } from '../lib/format';
import type { CommentView, ThreadKind } from '../lib/types';
import { useAsync } from '../lib/useAsync';
import { Avatar, ErrorNote, Modal, Spinner } from './ui';

export interface ThreadRef {
  kind: ThreadKind;
  id: string;
  /** Tab label, e.g. "The book". */
  label: string;
}

/** Replies are indented this many levels deep; deeper replies line up with the last level. */
const MAX_INDENT = 3;

interface Node {
  comment: CommentView;
  replies: Node[];
}

/** Build the reply tree. Deleted comments are kept only when someone replied to them. */
export function buildThread(comments: CommentView[]): Node[] {
  const nodes = new Map(comments.map((c) => [c.id, { comment: c, replies: [] as Node[] }]));
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.comment.parentId ? nodes.get(node.comment.parentId) : undefined;
    (parent ? parent.replies : roots).push(node);
  }
  const prune = (list: Node[]): Node[] =>
    list
      .map((n) => ({ ...n, replies: prune(n.replies) }))
      .filter((n) => !n.comment.deleted || n.replies.length > 0);
  return prune(roots);
}

/** Text box + submit, used for new comments, replies and edits. */
function Composer({
  id,
  initial = '',
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  id: string;
  initial?: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(body);
      setBody('');
    } catch (err) {
      setError(err as Error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor={id} className="sr-only">
        {placeholder}
      </label>
      <textarea
        id={id}
        className="input min-h-[4.5rem] resize-y"
        value={body}
        maxLength={2000}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setBody(e.target.value)}
      />
      <ErrorNote error={error} />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" className="btn-ghost !px-4 !py-1.5" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary !px-4 !py-1.5" disabled={saving || !body.trim()}>
          {saving ? 'Posting…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function CommentNode({
  node,
  depth,
  thread,
  onChanged,
}: {
  node: Node;
  depth: number;
  thread: ThreadRef;
  onChanged: () => Promise<void>;
}) {
  const api = useApi();
  const { comment } = node;
  const [mode, setMode] = useState<'view' | 'reply' | 'edit' | 'confirm-delete'>('view');
  const [error, setError] = useState<Error | null>(null);

  async function remove() {
    setError(null);
    try {
      await api.deleteComment(thread.kind, thread.id, comment.id);
      await onChanged();
    } catch (err) {
      setError(err as Error);
      setMode('view');
    }
  }

  return (
    <li className={depth > 0 && depth <= MAX_INDENT ? 'ml-4 border-l-2 border-ink/15 pl-4 sm:ml-6' : ''}>
      <article className="py-3" aria-label={comment.deleted ? 'Deleted comment' : `Comment by ${comment.author?.name}`}>
        {comment.deleted ? (
          <p className="voice text-base text-ink/50">Comment deleted</p>
        ) : (
          <>
            <header className="flex items-center gap-2 text-sm">
              <Avatar person={comment.author ?? undefined} size={24} />
              <span className="font-semibold">{comment.author?.name}</span>
              <span className="text-ink/50">
                {timeAgo(comment.createdAt)}
                {comment.editedAt ? ' · edited' : ''}
              </span>
            </header>
            {mode === 'edit' ? (
              <div className="mt-2">
                <Composer
                  id={`edit-${comment.id}`}
                  initial={comment.body}
                  placeholder="Edit your comment"
                  submitLabel="Save"
                  autoFocus
                  onCancel={() => setMode('view')}
                  onSubmit={async (body) => {
                    await api.editComment(thread.kind, thread.id, comment.id, body);
                    setMode('view');
                    await onChanged();
                  }}
                />
              </div>
            ) : (
              <p className="mt-1.5 whitespace-pre-wrap text-[0.95rem] leading-relaxed [overflow-wrap:anywhere]">{comment.body}</p>
            )}
            {mode !== 'edit' && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-semibold">
                <button type="button" className="kicker hover:text-coral" onClick={() => setMode(mode === 'reply' ? 'view' : 'reply')}>
                  Reply
                </button>
                {comment.canEdit && (
                  <button type="button" className="kicker hover:text-coral" onClick={() => setMode('edit')}>
                    Edit
                  </button>
                )}
                {comment.canDelete &&
                  (mode === 'confirm-delete' ? (
                    <span className="flex items-center gap-2">
                      <span className="text-ink/70">Delete this comment?</span>
                      <button type="button" className="kicker text-coral underline" onClick={remove}>
                        Delete
                      </button>
                      <button type="button" className="kicker" onClick={() => setMode('view')}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="kicker hover:text-coral" onClick={() => setMode('confirm-delete')}>
                      Delete
                    </button>
                  ))}
              </div>
            )}
            <ErrorNote error={error} />
          </>
        )}
        {mode === 'reply' && (
          <div className="mt-3">
            <Composer
              id={`reply-${comment.id}`}
              placeholder={`Reply to ${comment.author?.name ?? 'this comment'}`}
              submitLabel="Reply"
              autoFocus
              onCancel={() => setMode('view')}
              onSubmit={async (body) => {
                await api.postComment(thread.kind, thread.id, body, comment.id);
                setMode('view');
                await onChanged();
              }}
            />
          </div>
        )}
      </article>
      {node.replies.length > 0 && (
        <ul>
          {node.replies.map((child) => (
            <CommentNode key={child.comment.id} node={child} depth={depth + 1} thread={thread} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One thread: a composer and the comments with their replies. */
export function Thread({ thread, onChanged }: { thread: ThreadRef; onChanged?: () => void }) {
  const api = useApi();
  const comments = useAsync(() => api.thread(thread.kind, thread.id), [thread.kind, thread.id]);
  const tree = comments.data ? buildThread(comments.data.comments) : [];

  const refresh = async () => {
    await comments.reload();
    onChanged?.();
  };

  return (
    <div className="space-y-4">
      <Composer
        id={`new-${thread.kind}-${thread.id}`}
        placeholder={thread.kind === 'book' ? 'What did you think of the book?' : 'Say something about the meeting'}
        submitLabel="Post"
        onSubmit={async (body) => {
          await api.postComment(thread.kind, thread.id, body);
          await refresh();
        }}
      />
      <ErrorNote error={comments.error} />
      {comments.loading && !comments.data && <Spinner />}
      {comments.data && tree.length === 0 && (
        <p className="voice text-xl text-ink/70">No comments yet. Start the conversation.</p>
      )}
      {tree.length > 0 && (
        <ul aria-label="Comments" className="divide-y divide-ink/10 border-t-2 border-ink">
          {tree.map((node) => (
            <CommentNode key={node.comment.id} node={node} depth={0} thread={thread} onChanged={refresh} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A popup with one or more threads (e.g. a book and its meeting) as tabs. */
export function DiscussionModal({
  open,
  onClose,
  title,
  threads,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  threads: ThreadRef[];
  onChanged?: () => void;
}) {
  const [active, setActive] = useState(0);
  const current = threads[Math.min(active, threads.length - 1)];
  return (
    <Modal open={open} onClose={onClose} title={title}>
      {threads.length > 1 && (
        <div role="tablist" aria-label="Threads" className="mb-5 flex gap-2">
          {threads.map((t, i) => (
            <button
              key={`${t.kind}-${t.id}`}
              type="button"
              role="tab"
              aria-selected={i === active}
              className={i === active ? 'btn-primary !px-4 !py-1.5' : 'btn-ghost !px-4 !py-1.5'}
              onClick={() => setActive(i)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {current && <Thread key={`${current.kind}-${current.id}`} thread={current} onChanged={onChanged} />}
    </Modal>
  );
}

/** "💬 3": opens a discussion. */
export function DiscussButton({
  count,
  label,
  onClick,
  className = 'btn-ghost !px-3 !py-1',
}: {
  count: number;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button type="button" className={className} onClick={onClick} aria-label={`${label} (${count} ${count === 1 ? 'comment' : 'comments'})`}>
      <span aria-hidden>💬</span> {count > 0 ? count : label}
    </button>
  );
}
