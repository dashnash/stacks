import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AdminPanel } from '../../web/src/components/AdminPanel';
import { AuditLog, describeEvent } from '../../web/src/components/AuditLog';
import type { AuditEvent } from '../../web/src/lib/types';
import { fakeApi, renderWithApi } from './fakes';

const ev = (action: string, more: Partial<AuditEvent> = {}): AuditEvent => ({
  id: `${action}-${Math.random()}`,
  at: new Date().toISOString(),
  actorEmail: 'alice@club.test',
  actorName: 'Alice',
  action,
  ...more,
});

describe('describeEvent', () => {
  it('turns events into sentences', () => {
    expect(describeEvent(ev('auth.login', { details: { role: 'PENDING' } }))).toBe('signed in (waiting for approval)');
    expect(describeEvent(ev('comment.post', { label: 'Dune', details: { input: { body: 'Spice!' } } }))).toBe(
      'commented on Dune: “Spice!”',
    );
    expect(
      describeEvent(ev('comment.delete', { label: 'Dune', details: { byAdmin: true, author: 'bob@x', text: 'spam' } })),
    ).toBe("deleted bob@x's comment on Dune: “spam”");
    expect(
      describeEvent(
        ev('book.edit', { label: 'Dune', details: { changes: { pageCount: { from: null, to: 412 }, coverUrl: {} } } }),
      ),
    ).toBe('edited Dune: pages, cover');
    expect(
      describeEvent(ev('member.approve', { label: 'Bob', details: { fromRole: 'MEMBER', toRole: 'ADMIN' } })),
    ).toBe('made Bob an admin');
  });
});

describe('AuditLog', () => {
  it('lists events, filters by person and kind, loads older, and shows details', async () => {
    const first = [
      ev('book.edit', {
        label: 'Dune',
        details: { changes: { publisher: { from: null, to: 'Ace' } } },
      }),
    ];
    const older = [ev('vote.add', { label: 'Dune', at: '2026-01-02T12:00:00Z' })];
    const auditLog = vi.fn(async (opts: { before?: string }) =>
      opts.before ? { events: older, nextBefore: null } : { events: first, nextBefore: first[0]!.at },
    );
    const api = fakeApi({ auditLog });
    renderWithApi(<AuditLog people={[{ email: 'bob@club.test', name: 'Bob' }]} />, api);
    const user = userEvent.setup();

    const list = await screen.findByRole('list', { name: 'Activity' });
    expect(await within(list).findByText(/edited Dune: publisher/)).toBeInTheDocument();
    expect(within(list).getByText('Today')).toBeInTheDocument();

    // Expand for the before → after.
    await user.click(within(list).getByText(/edited Dune: publisher/));
    expect(within(list).getByRole('cell', { name: 'Ace' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await within(list).findByText(/voted for Dune/)).toBeInTheDocument();
    expect(auditLog).toHaveBeenLastCalledWith(expect.objectContaining({ before: first[0]!.at }));

    await user.selectOptions(screen.getByLabelText('Person'), 'bob@club.test');
    await user.selectOptions(screen.getByLabelText('What'), 'comment');
    await waitFor(() =>
      expect(auditLog).toHaveBeenLastCalledWith(expect.objectContaining({ actor: 'bob@club.test', action: 'comment' })),
    );
  });
});

describe('AdminPanel roles', () => {
  it('lets the owner make a member an admin (and never offers it for yourself)', async () => {
    const api = fakeApi({
      access: vi.fn().mockResolvedValue({ members: [
          { email: 'admin@club.test', name: 'Admin', role: 'ADMIN' },
          { email: 'bob@club.test', name: 'Bob', role: 'MEMBER' },
        ], pending: [] }),
    });
    renderWithApi(<AdminPanel me="admin@club.test" myRole="OWNER" onChanged={() => {}} />, api);
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Members' });
    await within(list).findByText('Bob');
    expect(within(list).getAllByRole('button', { name: 'Make admin' })).toHaveLength(1);
    await user.click(within(list).getByRole('button', { name: 'Make admin' }));
    expect(api.setAccess).toHaveBeenCalledWith('bob@club.test', 'ADMIN');
  });

  it('gives plain admins no admin controls: no making admins, no removing admins or the owner', async () => {
    const api = fakeApi({
      access: vi.fn().mockResolvedValue({ members: [
          { email: 'owner@club.test', name: 'Olive', role: 'OWNER' },
          { email: 'admin@club.test', name: 'Me', role: 'ADMIN' },
          { email: 'ada@club.test', name: 'Ada', role: 'ADMIN' },
          { email: 'bob@club.test', name: 'Bob', role: 'MEMBER' },
        ], pending: [] }),
    });
    renderWithApi(<AdminPanel me="admin@club.test" myRole="ADMIN" onChanged={() => {}} />, api);
    const list = await screen.findByRole('list', { name: 'Members' });
    await within(list).findByText('Bob');
    expect(within(list).getByText('Owner')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /Make (admin|member)/ })).not.toBeInTheDocument();
    // Only Bob (a member) can be removed by a plain admin.
    expect(
      within(list)
        .getAllByRole('button', { name: /^Remove / })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Remove Bob']);
    expect(screen.getByText(/Only owners can make people admins/)).toBeInTheDocument();
  });
});
