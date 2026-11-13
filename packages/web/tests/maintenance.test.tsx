import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createClient, StacksProvider } from '../src/index';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('maintenance', () => {
  it('replaces the app with a notice while the API answers 503 MAINTENANCE, and comes back on retry', async () => {
    let down = true;
    const fetch = vi.fn(async () =>
      down ? json(503, { error: 'DashyHQ is being upgraded. Back in a few minutes.', code: 'MAINTENANCE' }) : json(200, { user: { id: 'u_a', email: 'a@x.dev', name: 'A' }, role: 'MEMBER', canManageAccess: false }),
    );
    render(
      <StacksProvider client={createClient({ fetch: fetch as unknown as typeof globalThis.fetch })} silentSignIn={false}>
        <p>The app</p>
      </StacksProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Back in a few minutes' })).toBeInTheDocument();
    expect(screen.queryByText('The app')).not.toBeInTheDocument();
    down = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('The app')).toBeInTheDocument();
  });
});
