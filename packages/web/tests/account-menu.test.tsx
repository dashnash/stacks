import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccountMenu, createClient, StacksProvider, type AccountData, type Navigator } from '../src/index';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const account: AccountData = {
  portalUrl: 'https://auth.x/#/',
  profileUrl: 'https://auth.x/#/profile?from=club',
  inboxUrl: 'https://auth.x/#/notifications?from=club',
  unread: 3,
  app: { slug: 'club', name: 'Book Club', roleLabel: 'Admin' },
  apps: [
    { slug: 'club', name: 'Book Club', url: 'https://club.x/' },
    { slug: 'hello', name: 'Hello Board', url: 'https://hello.x/' },
  ],
  manage: { pending: 2, href: 'https://auth.x/#/admin/access?app=club' },
};

function renderMenu(opts: { signedIn: boolean; props?: Parameters<typeof AccountMenu>[0] }) {
  const fetch = vi.fn(async (url: string) => {
    if (url === '/api/auth/session') return opts.signedIn ? json(200, { user: { email: 'ann@x.dev', name: 'Ann' }, role: 'ADMIN', canManageAccess: true }) : json(401, {});
    if (url === '/api/stacks/account') return json(200, account);
    if (url === '/api/auth/logout') return json(200, { ok: true, platformLogoutUrl: 'https://auth.x/logout' });
    return json(404, {});
  });
  const nav: Navigator & { visited: string[] } = { visited: [], assign: (u) => void nav.visited.push(u), current: () => '/#/lineup' };
  render(
    <StacksProvider client={createClient({ fetch: fetch as unknown as typeof globalThis.fetch })} navigator={nav}>
      <header>
        <AccountMenu {...opts.props} />
      </header>
    </StacksProvider>,
  );
  return nav;
}

describe('AccountMenu', () => {
  it('signed out: a Sign in button that comes back to the same page', async () => {
    const nav = renderMenu({ signedIn: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(nav.visited).toEqual(['/api/auth/login?return=%2F%23%2Flineup']);
    expect(document.querySelector('[data-stacks-account-menu="signedOut"]')).not.toBeNull();
  });

  it('signed in: chip with name and badge; menu with apps, inbox, settings, manage access, app items, sign out', async () => {
    renderMenu({ signedIn: true, props: { items: [{ label: 'Reading reminders', href: '#/settings' }], manageAccessHref: '#/admin' } });
    const chip = await screen.findByRole('button', { name: 'Account menu for Ann, 5 new' });
    await userEvent.click(chip);
    const menu = screen.getByRole('menu', { name: 'Account' });
    expect(menu).toHaveTextContent('Admin · Book Club');
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Hello Board', 'All apps', 'Inbox3', 'Settings', 'Manage access2', 'Reading reminders', 'Sign outall apps']);
    expect(screen.getByRole('menuitem', { name: /Settings/ })).toHaveAttribute('href', 'https://auth.x/#/profile?from=club');
    expect(screen.getByRole('menuitem', { name: /Manage access/ })).toHaveAttribute('href', '#/admin');
    // The first item has focus; arrow keys move, Escape closes and returns focus to the chip.
    expect(screen.getByRole('menuitem', { name: 'Hello Board' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'All apps' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: /Sign out/ })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
  });

  it('signs out of everything', async () => {
    const nav = renderMenu({ signedIn: true });
    await userEvent.click(await screen.findByRole('button', { name: /Account menu for Ann/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Sign out/ }));
    await waitFor(() => expect(nav.visited).toEqual(['https://auth.x/logout']));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows "access requested" when the platform filed a request', async () => {
    window.history.replaceState(null, '', '/?stacks_access=access_pending');
    renderMenu({ signedIn: false });
    expect(await screen.findByRole('button', { name: /Access requested/ })).toBeInTheDocument();
  });
});
