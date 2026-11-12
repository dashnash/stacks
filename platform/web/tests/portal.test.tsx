import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('shows a new person their pending requests', async () => {
    const api = renderPortal();
    await signInAs('Sam Ortiz');
    await waitFor(() => expect(screen.getAllByText('Requested').length).toBe(2));
    expect((await api.catalog()).apps.find((a) => a.slug === 'hello')!.access).toBe(null);
  });

  it('opens the app from anywhere on the card, with a preview, Details and favorite on top', async () => {
    renderPortal();
    await signInAs('Priya Rao');
    const card = (await screen.findByRole('heading', { name: 'Potluck' })).closest('li')!;
    const open = within(card).getByRole('link', { name: 'Potluck' });
    expect(open).toHaveAttribute('href', expect.stringMatching(/potluck\..*\/$/));
    expect(open).toHaveClass('app-card-open'); // stretched over the card in CSS
    expect(card.querySelector('.app-preview img')).toHaveAttribute('src', expect.stringMatching(/potluck\..*\/preview\.png$/));
    expect(within(card).getByRole('link', { name: 'Details about Potluck' })).toHaveAttribute('href', '#/app/potluck');
    expect(within(card).getByRole('button', { name: 'Add Potluck to favorites' })).toBeInTheDocument();
  });

  it('falls back to the initial when an app has no preview yet', async () => {
    renderPortal();
    const card = (await screen.findByRole('heading', { name: 'Potluck' })).closest('li')!;
    fireEvent.error(card.querySelector('.app-preview img')!);
    expect(within(card).getByText('P')).toBeInTheDocument();
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
        users: [{ id: 'u_x', email: 'x@y.z', name: 'Lee, Jo', pictureUrl: null }],
        grants: [{ app: 'a', userId: 'u_x', role: 'M', requestedAt: null, grantedAt: null }],
      },
      [{ slug: 'a', name: 'A', status: 'live', topRole: 'O', defaultRole: 'M', roles: [], canManageApprovers: true }],
    );
    expect(csv).toBe('name,email,a\n"Lee, Jo",x@y.z,M');
  });
});

describe('branding', () => {
  it('calls the portal DashyHQ in the header, with its mark', async () => {
    renderPortal();
    const brand = await screen.findByRole('link', { name: 'DashyHQ' });
    expect(brand.querySelector('img')?.getAttribute('src')).toMatch(/favicon\.svg$/);
  });
});

describe('footer', () => {
  it('ends every page with the build (shared <BuildVersion />)', async () => {
    renderPortal();
    const footer = await screen.findByRole('contentinfo');
    expect(footer).toHaveTextContent(`© ${new Date().getFullYear()} DashyHQ`);
    expect(footer.querySelector('[data-stacks-build]')).not.toBeNull();
  });
});

describe('Settings › Sign-in methods', () => {
  it("offers to merge another person's account, shows what happens, and merges it", async () => {
    renderPortal('#/profile');
    await signInAs('Sam Ortiz');
    window.location.hash = '#/profile';
    const methods = await screen.findByRole('list', { name: 'Sign-in methods' });
    expect(await within(methods).findByText(/sam@demo\.stacks/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Link Priya Rao's account/ }));
    const offer = await screen.findByRole('region', { name: 'Merge accounts' });
    expect(offer).toHaveTextContent("can't be undone");
    expect(within(offer).getByRole('row', { name: /MOFO Book Klub/ })).toHaveTextContent('Admin'); // Priya's role beats Sam's request

    await userEvent.click(within(offer).getByRole('button', { name: 'Merge accounts' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Merged');
    expect(await within(methods).findByText(/priya@demo\.stacks/)).toBeInTheDocument();
  });

  it("won't merge a platform admin's account from Settings", async () => {
    renderPortal('#/profile');
    await signInAs('Sam Ortiz');
    window.location.hash = '#/profile';
    await userEvent.click(await screen.findByRole('button', { name: /Link Dash Nash's account/ }));
    const offer = await screen.findByRole('region', { name: 'Merge accounts' });
    expect(offer).toHaveTextContent('Platform admin accounts can only be merged by a platform admin.');
    expect(within(offer).getByRole('button', { name: 'Merge accounts' })).toBeDisabled();
  });
});
