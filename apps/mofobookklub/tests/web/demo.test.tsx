import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDemo, DemoApp } from '@stacks/demo';
import { zipSync } from 'fflate';
import { manifest } from '../../api/manifest';
import { routes } from '../../api/routes';
import type { Deps } from '../../api/utils/deps';
import App from '../../web/src/App';
import { DemoBooks, DemoFaces, PERSONAS, seed } from '../../web/src/demo/server';

beforeEach(() => localStorage.clear());

function renderDemo() {
  const demo = createDemo<Deps>({
    manifest,
    routes,
    extend: (base) => ({ ...base, books: new DemoBooks(), signImageUrl: async (k) => k, faces: new DemoFaces(), random: () => 0 }),
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
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'The lineup' }, { timeout: 3000 })).toBeInTheDocument();
  });

  it('credits seeded people by name (their seed ids match the personas)', async () => {
    const demo = renderDemo();
    await demo.signInAs(PERSONAS[0]!.email);
    expect(await screen.findByRole('heading', { name: 'The lineup' }, { timeout: 3000 })).toBeInTheDocument();
    expect((await screen.findAllByText(/Jane/, {}, { timeout: 3000 })).length).toBeGreaterThan(0); // this month's leader
    expect(screen.queryByText(/Former member/)).not.toBeInTheDocument();
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

  it('lets an admin add face photos from a zip, which then show on the quotes, and delete them', async () => {
    const demo = renderDemo();
    await demo.signInAs(PERSONAS[0]!.email);
    window.location.hash = '#/admin/critics';
    const user = userEvent.setup();
    expect(await screen.findByText(/No faces yet/, {}, { timeout: 3000 })).toBeInTheDocument();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(16).fill(1)]);
    await user.upload(screen.getByLabelText('Zip of face photos'), new File([zipSync({ 'jo.jpg': jpeg }) as BlobPart], 'faces.zip'));
    await user.click(await screen.findByRole('button', { name: 'Add 1 photo' }));
    expect(await screen.findByText('Added 1 photo.')).toBeInTheDocument();
    const grid = screen.getByRole('list', { name: 'Face photos' });
    expect(await within(grid).findAllByRole('img')).toHaveLength(1);

    await user.click(within(grid).getByRole('button', { name: /^Delete / }));
    await user.click(within(grid).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/No faces yet/)).toBeInTheDocument();
  });
});
