import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { createDemoPortal, DEMO_PEOPLE } from '../src/demo/backend';
import { parseHash, PortalProvider, safeNext } from '../src/portal';
import { toCsv } from '../src/views/AccessGrid';

function renderPortal(hash = '#/') {
  window.location.hash = hash;
  const { api } = createDemoPortal();
  render(
    <PortalProvider api={api} signInMethod={{ kind: 'personas', personas: DEMO_PEOPLE }}>
      <App />
    </PortalProvider>,
  );
  return api;
}

async function signInAs(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`Continue as ${name}`) }));
  await screen.findByRole('button', { name: new RegExp(`Account menu for ${name.split(' ')[0]}`) });
}

beforeEach(() => {
  window.location.hash = '#/';
});

describe('catalog', () => {
  it('shows every app to signed-out visitors with a way in', async () => {
    renderPortal();
    expect(await screen.findByText('Potluck')).toBeInTheDocument();
    expect(screen.getByText('MOFO Book Klub')).toBeInTheDocument();
    expect(screen.getAllByText('Private').length).toBe(2);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows the viewer\'s access and files requests for private apps', async () => {
    renderPortal();
    await signInAs('Priya Rao');
    const card = (name: string) => screen.getByRole('heading', { name }).closest('li')!;
    await waitFor(() => expect(within(card('MOFO Book Klub')).getByText('Admin')).toBeInTheDocument());
    expect(within(card('Potluck')).getByText('Host')).toBeInTheDocument();
    // Priya can manage apps, so she sees the access grid link; Sam's requests are waiting on her.
    expect(screen.getByRole('link', { name: /Access/ })).toBeInTheDocument();
  });

  it('lets a new person request access', async () => {
    const api = renderPortal();
    await signInAs('Sam Ortiz');
    await screen.findAllByText('Waiting for approval');
    expect(screen.getAllByText('Requested').length).toBe(2);
    expect((await api.catalog()).apps.find((a) => a.slug === 'hello')!.access).toBe(null);
  });
});

describe('account menu', () => {
  it('offers your apps, inbox, settings, access and sign out from the top right', async () => {
    renderPortal();
    await signInAs('Priya Rao');
    await userEvent.click(screen.getByRole('button', { name: /Account menu for Priya/ }));
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(expect.arrayContaining(['MOFO Book Klub', 'Potluck', 'All apps', 'Settings', 'Activity']));
    expect(items.some((t) => t?.startsWith('Manage access'))).toBe(true);
    expect(items.at(-1)).toMatch(/^Sign out/);
    await userEvent.click(screen.getByRole('menuitem', { name: /Sign out/ }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('links back to the app you came from on the profile page', async () => {
    renderPortal();
    await signInAs('Priya Rao');
    window.location.hash = '#/profile?from=potluck';
    expect(await screen.findByRole('link', { name: '← Back to Potluck' })).toHaveAttribute('href', 'https://potluck.demo.stacks/');
  });
});

describe('sign-in', () => {
  it('continues to the app handshake after signing in', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hash: '#/signin?next=%2Fauthorize%3Fapp%3Dhello', assign } as Location);
    renderPortal('#/signin?next=%2Fauthorize%3Fapp%3Dhello');
    await userEvent.click(await screen.findByRole('button', { name: /Continue as Sam Ortiz/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/authorize?app=hello'));
    vi.restoreAllMocks();
  });

  it('only continues to /authorize', () => {
    expect(safeNext('/authorize?app=x')).toBe('/authorize?app=x');
    expect(safeNext('https://evil.example')).toBeNull();
    expect(safeNext('//evil.example/authorize?')).toBeNull();
    expect(parseHash('#/admin/access?app=club')).toEqual({ path: '/admin/access', query: { app: 'club' } });
  });
});

describe('access grid', () => {
  it('approves a request from the grid', async () => {
    renderPortal();
    await signInAs('Dash Nash');
    await userEvent.click(screen.getByRole('link', { name: /Access/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Approve sam@demo.stacks for MOFO Book Klub' }));
    await waitFor(() => expect(screen.getByLabelText('sam@demo.stacks in MOFO Book Klub')).toHaveValue('MEMBER'));
  });

  it('blocks a requester from the grid, and shows blocked people as Blocked', async () => {
    renderPortal();
    await signInAs('Dash Nash');
    await userEvent.click(screen.getByRole('link', { name: /Access/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Block sam@demo.stacks from MOFO Book Klub' }));
    await waitFor(() => expect(screen.getByLabelText('sam@demo.stacks in MOFO Book Klub')).toHaveValue('BLOCKED'));
    expect(screen.getByLabelText('troll@demo.stacks in Hello Board')).toHaveValue('BLOCKED');
  });

  it('does not let admins hand out approver roles', async () => {
    renderPortal();
    await signInAs('Priya Rao');
    await userEvent.click(screen.getByRole('link', { name: /Access/ }));
    const select = await screen.findByLabelText('kyle@demo.stacks in MOFO Book Klub');
    expect(within(select).getByRole('option', { name: 'Admin' })).toBeDisabled();
    expect(within(select).getByRole('option', { name: 'Member' })).not.toBeDisabled();
    // Her own Admin cell is locked: only owners change approvers.
    expect(screen.getByLabelText('priya@demo.stacks in MOFO Book Klub')).toBeDisabled();
  });

  it('exports the visible grid as CSV', () => {
    const csv = toCsv(
      {
        isPlatformAdmin: true,
        apps: [{ slug: 'a', name: 'A', status: 'live', topRole: 'O', defaultRole: 'M', roles: [], canManageApprovers: true }],
        users: [{ email: 'x@y.z', name: 'Lee, Jo', pictureUrl: null }],
        grants: [{ app: 'a', email: 'x@y.z', role: 'M', requestedAt: null, grantedAt: null }],
      },
      [{ slug: 'a', name: 'A', status: 'live', topRole: 'O', defaultRole: 'M', roles: [], canManageApprovers: true }],
    );
    expect(csv).toBe('name,email,a\n"Lee, Jo",x@y.z,M');
  });
});
