import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { buildThread, Thread } from '../../web/src/components/Discussion';
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
