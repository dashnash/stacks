import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDemo, DemoApp } from '@stacks/demo';
import { manifest } from '../../api/manifest';
import { routes } from '../../api/routes';
import type { Deps } from '../../api/utils/deps';
import App from '../../web/src/App';
import { DemoBooks, PERSONAS, seed } from '../../web/src/demo/server';

beforeEach(() => localStorage.clear());

function renderDemo() {
  const demo = createDemo<Deps>({
    manifest,
    routes,
    extend: (base) => ({ ...base, books: new DemoBooks(), signImageUrl: async (k) => k, listFacePhotos: async () => [], random: () => 0 }),
    personas: PERSONAS.filter((p) => p.role !== 'PENDING').map((p) => ({ email: p.email, name: p.name, role: p.role })),
    pending: [{ email: 'sam@demo.bookklub', name: 'Sam Whitaker' }],
    seed: (deps) => seed(deps.store),
  });
  render(
    <DemoApp demo={demo}>
      <App />
    </DemoApp>,
  );
  return demo;
}

describe('the Book Club demo on Stacks', () => {
  it('shows the public site, then the club after signing in', async () => {
    renderDemo();
    expect(await screen.findByRole('heading', { name: /Read\. Dish\. Repeat\./ })).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[0]!);
    expect(await screen.findByRole('heading', { name: 'The lineup' }, { timeout: 3000 })).toBeInTheDocument();
  });

  it('shows admins the people waiting for approval, and approving moves them to members', async () => {
    const demo = renderDemo();
    await demo.signInAs(PERSONAS[0]!.email); // the owner
    window.location.hash = '#/admin';
    expect(await screen.findByText('Sam Whitaker', {}, { timeout: 3000 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const members = await screen.findByRole('list', { name: 'Members' });
    expect(await within(members).findByText('Sam Whitaker')).toBeInTheDocument();
  });
});

