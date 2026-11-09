import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardView } from '../../web/src/views/DashboardView';
import { admin, books, fakeApi, lineupOf, meeting, member, renderWithApi } from './fakes';

describe('DashboardView', () => {
  it('shows the hero, The Lineup and the history shelf', async () => {
    const api = fakeApi({
      nextMeeting: vi.fn().mockResolvedValue({ meeting: meeting() }),
      lineup: vi.fn().mockResolvedValue(lineupOf(books)),
    });
    renderWithApi(<DashboardView user={member} />, api);

    expect(await screen.findByText(/Next meeting · October/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The lineup' })).toBeInTheDocument();
    expect(await screen.findAllByRole('img', { name: /Cover of/ })).toHaveLength(3);
    expect(screen.getByRole('heading', { name: 'Past headliners' })).toBeInTheDocument();
    // The ticker lists every nomination for screen readers.
    expect(within(screen.getByRole('region', { name: 'On The Lineup' })).getByText(/Dune, nominated by Marcus/)).toBeInTheDocument();
    // Members don't see the admin button or fetch pending users.
    expect(screen.queryByRole('button', { name: /Admin/ })).not.toBeInTheDocument();
    expect(api.access).not.toHaveBeenCalled();
  });

  it('lets the handed-off leader schedule the next meeting', async () => {
    const api = fakeApi({
      nextMeeting: vi.fn().mockResolvedValue({ meeting: null, nextLeader: { email: member.email, name: member.name }, canCreateNext: true }),
    });
    renderWithApi(<DashboardView user={member} />, api);
    expect(await screen.findByRole('heading', { name: /You're up!/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Schedule & open nominations/ })).toBeInTheDocument();
    // Non-admins don't get a leader picker.
    expect(screen.queryByLabelText('Leader')).not.toBeInTheDocument();
  });

  it('shows admins the pending-approval badge', async () => {
    const api = fakeApi({
      access: vi.fn().mockResolvedValue({
        members: [],
        pending: [{ email: 'new@x.test', name: 'Newbie', role: 'PENDING', requestedAt: '2026-01-01T00:00:00Z' }],
      }),
    });
    renderWithApi(<DashboardView user={admin} />, api);
    const adminButton = await screen.findByRole('button', { name: /Admin/ });
    expect(await screen.findByText('1')).toBeInTheDocument();
    // The Admin button opens the admin page, with people waiting for approval first.
    fireEvent.click(adminButton);
    expect(window.location.hash).toBe('#/admin');
    expect(await screen.findByText('Newbie')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Members · 1 waiting/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('closes the page with a critic quote, and has no separate easter egg button', async () => {
    const api = fakeApi({
      randomEasterEgg: vi.fn().mockResolvedValue({ id: 'e', quote: 'Hamlet, but he finally decides.', imageUrl: null }),
    });
    renderWithApi(<DashboardView user={member} />, api);
    expect(await screen.findByRole('region', { name: 'From our literary critics' })).toHaveTextContent(/Hamlet, but he finally decides\./);
    expect(screen.queryByRole('button', { name: /easter egg/i })).not.toBeInTheDocument();
  });
});

describe('who gets the header meeting controls', () => {
  const upcoming = (leaderEmail: string) =>
    fakeApi({
      nextMeeting: vi.fn().mockResolvedValue({
        meeting: meeting({ leaderEmail, leader: { email: leaderEmail, name: 'Lead' }, canManage: true }),
      }),
    });

  it('shows the strip to the leader', async () => {
    renderWithApi(<DashboardView user={member} />, upcoming(member.email));
    expect(await screen.findByRole('region', { name: "You're leading" })).toBeInTheDocument();
  });

  it('keeps it out of the header for admins who are not leading; they use the admin page', async () => {
    const api = upcoming('someone@club.test');
    renderWithApi(<DashboardView user={admin} />, api);
    await screen.findByRole('button', { name: /Admin/ });
    await screen.findAllByText(/Lead/);
    expect(screen.queryByRole('region', { name: 'Admin controls' })).not.toBeInTheDocument();

    window.location.hash = '#/admin/meeting';
    const panel = await screen.findByRole('region', { name: 'October' });
    expect(within(panel).getByRole('button', { name: 'Choose the book' })).toBeInTheDocument();
    expect(within(panel).getByText(/led by Lead/)).toBeInTheDocument();
  });
});
