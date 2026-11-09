import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDemo, DemoApp } from '@stacks/demo';
import { personas, seed } from '../api/demo-data';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';
import { App } from '../web/src/App';

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
});

const renderDemo = () => {
  const demo = createDemo({ manifest, routes, personas, seed, storageKey: false });
  render(
    <DemoApp demo={demo}>
      <App />
    </DemoApp>,
  );
  return demo;
};

const signIn = async () => userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));

describe(`${manifest.name} UI (on the demo backend)`, () => {
  it('lets a signed-out visitor flip the table and asks them to sign in to save', async () => {
    renderDemo();
    await userEvent.click(await screen.findByRole('button', { name: 'Flip the table' }));
    const report = await screen.findByRole('region', { name: 'Damage report' }, { timeout: 9000 });
    expect(within(report).getByRole('button', { name: 'Sign in for save you score!!' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set the table again' })).toBeInTheDocument();
  }, 15_000);

  it('saves a signed-in flip and adds the coinz to their stats', async () => {
    renderDemo();
    await signIn();
    const stats = await screen.findByRole('region', { name: 'Your stats' });
    expect(stats).toHaveTextContent('Flips: 3');
    await userEvent.click(screen.getByRole('button', { name: 'Flip the table' }));
    expect(await screen.findByText(/Saved! \+₽\$/, undefined, { timeout: 9000 })).toBeInTheDocument();
    expect(await screen.findByText(/Flips:/)).toHaveTextContent('Flips: 4');
  }, 15_000);

  it('shows the leaderboard with first names, and lets the owner remove a cheater', async () => {
    window.location.hash = '#/top';
    renderDemo();
    expect(await screen.findByText('xX_Flipper_Xx')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    await signIn();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove xX_Flipper_Xx from the board' }));
    expect(await screen.findByText(/removed from Top/)).toBeInTheDocument();
    expect(screen.queryByText('xX_Flipper_Xx')).not.toBeInTheDocument();
  });

  it('lets a player pick a tool they have unlocked in the shop', async () => {
    window.location.hash = '#/shop';
    renderDemo();
    expect(await screen.findByRole('button', { name: 'Sign in for unlock tools' })).toBeInTheDocument();
    await signIn();
    await userEvent.click(await screen.findByRole('button', { name: 'Use Crowbar (лом)' }));
    expect(screen.getByText('✔ Using')).toBeInTheDocument();
    expect(screen.getAllByText(/need ₽\$/)).toHaveLength(2);
    window.location.hash = '#/';
    await screen.findByRole('button', { name: 'Flip the table' });
    expect(screen.getByText(/Crowbar \(лом\)/)).toBeInTheDocument();
  });

  it('has one demo persona per role', () => {
    expect(personas.map((p) => p.role).sort()).toEqual(manifest.roles.map((r) => r.id).sort());
  });
});
