import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AdminPanel } from '../../web/src/components/AdminPanel';
import { Thread } from '../../web/src/components/Discussion';
import { fakeApi, renderWithApi } from './fakes';

const people = [
  { email: 'admin@club.test', name: 'Admin', role: 'ADMIN' },
  { email: 'bob@club.test', name: 'Bob Smith', role: 'MEMBER' },
];

describe('AdminPanel members', () => {
  it('removes a member after confirming, and never offers to remove yourself', async () => {
    const api = fakeApi({ access: vi.fn().mockResolvedValue({ members: people, pending: [] }) });
    const onChanged = vi.fn();
    renderWithApi(<AdminPanel me="admin@club.test" onChanged={onChanged} />, api);
    const user = userEvent.setup();

    const list = await screen.findByRole('list', { name: 'Members' });
    await within(list).findByText('Bob Smith');
    expect(within(list).queryByRole('button', { name: 'Remove Admin' })).not.toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'Remove Bob Smith' }));
    expect(api.setAccess).not.toHaveBeenCalled();
    expect(screen.getByText('Remove Bob Smith?')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Remove' }));
    expect(api.setAccess).toHaveBeenCalledWith('bob@club.test', null);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});

describe('moderating comments', () => {
  it("lets an admin delete someone else's comment", async () => {
    const api = fakeApi({
      thread: vi.fn().mockResolvedValue({
        comments: [
          {
            id: 'c1',
            parentId: null,
            createdAt: new Date().toISOString(),
            editedAt: null,
            deleted: false,
            body: 'Spam spam spam',
            author: { email: 'bob@club.test', name: 'Bob Smith' },
            // What the server sends an admin for anyone's comment: delete, but not edit.
            canEdit: false,
            canDelete: true,
          },
        ],
      }),
    });
    renderWithApi(<Thread thread={{ kind: 'book', id: '9780593135204', label: 'The book' }} />, api);
    const user = userEvent.setup();
    const comment = await screen.findByRole('article', { name: 'Comment by Bob Smith' });
    expect(within(comment).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    await user.click(within(comment).getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(api.deleteComment).toHaveBeenCalledWith('book', '9780593135204', 'c1');
  });
});
