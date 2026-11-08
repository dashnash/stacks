import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClient, StacksProvider } from '../src/index';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const fetchFor = (signedIn: boolean) =>
  (async (url: string) => {
    if (url === '/api/auth/session') return signedIn ? json(200, { user: { email: 'a@b.c', name: 'Ann' }, role: 'MEMBER', canManageAccess: false }) : json(401, {});
    if (url === '/api/stacks/bar') return json(200, { portalUrl: 'https://auth.x/#/', unread: 3, apps: [{ slug: 'club', name: 'Book Club', url: 'https://club.x/' }] });
    return json(404, {});
  }) as unknown as typeof fetch;

beforeEach(() => localStorage.clear());

describe('PortalBar', () => {
  it('shows a minimized pill with the unread count, and opens to the user\'s apps', async () => {
    render(<StacksProvider client={createClient({ fetch: fetchFor(true) })}>app</StacksProvider>);
    expect(await screen.findByLabelText('3 unread notifications')).toBeInTheDocument();
    expect(screen.queryByText('Book Club')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show the apps menu' }));
    expect(screen.getByRole('link', { name: 'Book Club' })).toHaveAttribute('href', 'https://club.x/');
    expect(screen.getByRole('link', { name: 'All apps · 3 new' })).toHaveAttribute('href', 'https://auth.x/#/');
    expect(localStorage.getItem('stacks.portalBar.open')).toBe('1');
  });

  it('is absent when signed out or turned off', async () => {
    const { unmount } = render(<StacksProvider client={createClient({ fetch: fetchFor(false) })}>app</StacksProvider>);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Apps')).not.toBeInTheDocument();
    unmount();
    render(
      <StacksProvider client={createClient({ fetch: fetchFor(true) })} portalBar="off">
        app
      </StacksProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Apps')).not.toBeInTheDocument();
  });
});
