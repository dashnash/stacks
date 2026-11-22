import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installFakeNative, NativeError } from '@stacks/native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildThread, HIGHLIGHT_MS, Thread } from '../../web/src/components/Discussion';
import { LineupPanel } from '../../web/src/components/LineupPanel';
import { NextMeetingHero } from '../../web/src/components/NextMeetingHero';
import type { CommentView } from '../../web/src/lib/types';
import { books, fakeApi, lineupOf, meeting, renderWithApi } from './fakes';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
function comment(id: string, overrides: Partial<CommentView> = {}): CommentView {
  return {
    id,
    parentId: null,
    createdAt: at(30),
    editedAt: null,
    deleted: false,
    body: `Comment ${id}`,
    author: { id: `${id}@x`, name: `Author ${id}` },
    canEdit: false,
    canDelete: false,
    ...overrides,
  };
}

describe('buildThread', () => {
  it('nests replies under their parents and drops deleted comments nobody replied to', () => {
    const tree = buildThread([
      comment('a'),
      comment('b', { parentId: 'a' }),
      comment('c', { parentId: 'b' }),
      comment('d', { deleted: true, body: '', author: null }),
      comment('e', { deleted: true, body: '', author: null }),
      comment('f', { parentId: 'e' }),
    ]);
    expect(tree.map((n) => n.comment.id)).toEqual(['a', 'e']);
    expect(tree[0]!.replies[0]!.comment.id).toBe('b');
    expect(tree[0]!.replies[0]!.replies[0]!.comment.id).toBe('c');
    expect(tree[1]!.replies.map((n) => n.comment.id)).toEqual(['f']);
  });
});

describe('Thread', () => {
  it('shows nested comments and posts replies to the right parent', async () => {
    const api = fakeApi({
      thread: vi.fn().mockResolvedValue({
        comments: [comment('a', { createdAt: at(120) }), comment('b', { parentId: 'a', editedAt: at(1) })],
      }),
    });
    renderWithApi(<Thread thread={{ kind: 'book', id: '9780593135204', label: 'The book' }} />, api);
    const user = userEvent.setup();

    const top = await screen.findByRole('article', { name: 'Comment by Author a' });
    expect(top).toHaveTextContent('2h ago');
    const reply = screen.getByRole('article', { name: 'Comment by Author b' });
    expect(reply).toHaveTextContent('edited');
    // The reply sits inside the parent's list item.
    expect(top.closest('li')!.contains(reply)).toBe(true);

    await user.click(within(top).getByRole('button', { name: 'Reply' }));
    await user.type(screen.getByLabelText('Reply to Author a'), 'Same here');
    const submit = within(top)
      .getAllByRole('button', { name: 'Reply' })
      .find((b) => b.getAttribute('type') === 'submit')!;
    await user.click(submit);
    expect(api.postComment).toHaveBeenCalledWith('book', '9780593135204', 'Same here', 'a');
  });

  it('lets authors edit and asks before deleting', async () => {
    const api = fakeApi({
      thread: vi.fn().mockResolvedValue({ comments: [comment('mine', { canEdit: true, canDelete: true })] }),
    });
    renderWithApi(<Thread thread={{ kind: 'meeting', id: 'm1', label: 'The meeting' }} />, api);
    const user = userEvent.setup();
    const mine = await screen.findByRole('article', { name: 'Comment by Author mine' });

    await user.click(within(mine).getByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Edit your comment');
    await user.clear(box);
    await user.type(box, 'Better wording');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.editComment).toHaveBeenCalledWith('meeting', 'm1', 'mine', 'Better wording');

    await user.click(
      within(await screen.findByRole('article', { name: 'Comment by Author mine' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    expect(api.deleteComment).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this comment?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(api.deleteComment).toHaveBeenCalledWith('meeting', 'm1', 'mine');
  });

  it('posts new top-level comments and has an empty state', async () => {
    const api = fakeApi();
    renderWithApi(<Thread thread={{ kind: 'book', id: '9780441172719', label: 'The book' }} />, api);
    const user = userEvent.setup();
    expect(await screen.findByText(/No comments yet/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('What did you think of the book?'), 'Spice must flow');
    await user.click(screen.getByRole('button', { name: 'Post' }));
    expect(api.postComment).toHaveBeenCalledWith('book', '9780441172719', 'Spice must flow');
  });
});

describe('voting and discussing on The Lineup', () => {
  it('toggles your vote and shows counts', async () => {
    const lineup = lineupOf(books.slice(0, 2));
    lineup.nominations[0] = { ...lineup.nominations[0]!, votes: 3, myVote: true, commentCount: 2 };
    const api = fakeApi();
    const onChanged = vi.fn();
    renderWithApi(<LineupPanel lineup={lineup} onChanged={onChanged} />, api);
    const user = userEvent.setup();

    const mine = screen.getByRole('button', { name: /Remove your vote for Project Hail Mary \(3 votes\)/ });
    expect(mine).toHaveAttribute('aria-pressed', 'true');
    await user.click(mine);
    expect(api.unvote).toHaveBeenCalledWith('n0');

    const theirs = screen.getByRole('button', { name: /^Vote for Dune \(0 votes\)/ });
    expect(theirs).toHaveAttribute('aria-pressed', 'false');
    await user.click(theirs);
    expect(api.vote).toHaveBeenCalledWith('n1');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));

    // The cover and the title open the book's page.
    expect(screen.getByRole('link', { name: 'Project Hail Mary' })).toHaveAttribute('href', '#/book/9780593135204');
    expect(screen.getByRole('link', { name: 'Cover of Project Hail Mary' })).toHaveAttribute('href', '#/book/9780593135204');

    await user.click(screen.getByRole('button', { name: 'Discuss (2 comments)' }));
    expect(await screen.findByRole('dialog', { name: 'Project Hail Mary' })).toBeInTheDocument();
    expect(api.thread).toHaveBeenCalledWith('book', '9780593135204');
  });
});

describe('poster discussions', () => {
  it('opens the book and meeting threads as tabs', async () => {
    const api = fakeApi();
    const m = meeting({
      phase: 'SELECTED',
      book: books[0],
      bookIsbn: books[0]!.isbn,
      commentCount: 4,
      bookCommentCount: 1,
    });
    renderWithApi(<NextMeetingHero meeting={m} />, api);
    const user = userEvent.setup();
    expect(screen.getByRole('link', { name: 'Project Hail Mary' })).toHaveAttribute('href', '#/book/9780593135204');

    await user.click(screen.getByRole('button', { name: /Meeting chat · 4 comments/ }));
    const dialog = await screen.findByRole('dialog', { name: 'October' });
    const tabs = within(dialog).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['The meeting', 'The book']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(api.thread).toHaveBeenLastCalledWith('meeting', 'm1');
    await user.click(tabs[1]!);
    expect(api.thread).toHaveBeenLastCalledWith('book', '9780593135204');
    expect(screen.getByRole('button', { name: /Talk about the book · 1 comment$/ })).toBeInTheDocument();
  });
});

describe('sharing a comment', () => {
  const links = { href: (id: string) => `#/book/9780593135204/comment/${id}`, title: 'Project Hail Mary' };
  const book = { kind: 'book' as const, id: '9780593135204', label: 'The book' };
  let remove: (() => void) | undefined;
  afterEach(() => {
    remove?.();
    remove = undefined;
    vi.useRealTimers();
  });

  it('shares a link to the comment from the app', async () => {
    const shared: unknown[] = [];
    remove = installFakeNative({ share: (args) => (shared.push(args), { completed: true }) }).remove;
    const api = fakeApi({ thread: vi.fn().mockResolvedValue({ comments: [comment('c1')] }) });
    renderWithApi(<Thread thread={book} links={links} />, api);
    const c1 = await screen.findByRole('article', { name: 'Comment by Author c1' });
    await userEvent.setup().click(within(c1).getByRole('button', { name: 'Share' }));
    expect(shared).toEqual([
      { url: `${window.location.origin}/#/book/9780593135204/comment/c1`, title: 'Author c1 on Project Hail Mary', text: undefined },
    ]);
  });

  it('says so when sharing fails, and nothing when the person backs out', async () => {
    let fail = false;
    remove = installFakeNative({
      share: () => {
        throw fail ? new NativeError('failed', 'Sheet broke') : new NativeError('cancelled', 'Share was cancelled');
      },
    }).remove;
    const api = fakeApi({ thread: vi.fn().mockResolvedValue({ comments: [comment('c1')] }) });
    renderWithApi(<Thread thread={book} links={links} />, api);
    const user = userEvent.setup();
    const c1 = await screen.findByRole('article', { name: 'Comment by Author c1' });
    await user.click(within(c1).getByRole('button', { name: 'Share' }));
    expect(within(c1).queryByText(/Sheet broke/)).not.toBeInTheDocument();
    fail = true;
    await user.click(within(c1).getByRole('button', { name: 'Share' }));
    expect(await within(c1).findByText(/Sheet broke/)).toBeInTheDocument();
  });

  it('has no Share button without a share sheet (most desktops) or without links (meeting threads)', async () => {
    const api = fakeApi({ thread: vi.fn().mockResolvedValue({ comments: [comment('c1')] }) });
    const { unmount } = renderWithApi(<Thread thread={book} links={links} />, api);
    const c1 = await screen.findByRole('article', { name: 'Comment by Author c1' });
    expect(within(c1).queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
    unmount();
    remove = installFakeNative({ share: () => ({ completed: true }) }).remove;
    renderWithApi(<Thread thread={{ kind: 'meeting', id: 'm1', label: 'The meeting' }} />, api);
    const again = await screen.findByRole('article', { name: 'Comment by Author c1' });
    expect(within(again).queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
  });

  it('scrolls to a linked comment and highlights it for a moment', async () => {
    const scrolled: string[] = [];
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
    const before = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.id);
    };
    try {
      const api = fakeApi({ thread: vi.fn().mockResolvedValue({ comments: [comment('a'), comment('b', { parentId: 'a' })] }) });
      renderWithApi(<Thread thread={book} links={links} focus="b" />, api);
      const b = await screen.findByRole('article', { name: 'Comment by Author b' });
      await waitFor(() => expect(b).toHaveAttribute('data-highlighted', 'true'));
      expect(scrolled).toEqual(['comment-b']);
      expect(screen.getByRole('article', { name: 'Comment by Author a' })).not.toHaveAttribute('data-highlighted');
      await waitFor(() => expect(b).not.toHaveAttribute('data-highlighted'), { timeout: HIGHLIGHT_MS + 1000 });
      expect(screen.queryByText('That comment is no longer here.')).not.toBeInTheDocument();
    } finally {
      proto.scrollIntoView = before;
    }
  });

  it('says when a linked comment is gone', async () => {
    const api = fakeApi({
      thread: vi.fn().mockResolvedValue({ comments: [comment('a'), comment('gone', { deleted: true, body: '', author: null }), comment('r', { parentId: 'gone' })] }),
    });
    renderWithApi(<Thread thread={book} links={links} focus="gone" />, api);
    expect(await screen.findByText('That comment is no longer here.')).toBeInTheDocument();
  });

  it('says when a linked comment never existed', async () => {
    const api = fakeApi({ thread: vi.fn().mockResolvedValue({ comments: [comment('a')] }) });
    renderWithApi(<Thread thread={book} links={links} focus="nope" />, api);
    expect(await screen.findByText('That comment is no longer here.')).toBeInTheDocument();
  });
});

