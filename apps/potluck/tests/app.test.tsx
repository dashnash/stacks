import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDemo, DemoApp } from '@stacks/demo';
import { personas, seed } from '../api/demo-data';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';
import { App } from '../web/src/App';

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '#/';
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

describe('Potluck UI (on the demo backend)', () => {
  it('signed out: shows what it is and how many potlucks are coming, no details', async () => {
    renderDemo();
    expect(await screen.findByText('2 potlucks coming up.')).toBeInTheDocument();
    expect(screen.queryByText('Fall Harvest Potluck')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in or ask to join' })).toBeInTheDocument();
  });

  it('a guest sees upcoming potlucks, RSVPs and signs up for a dish with tags', async () => {
    const demo = renderDemo();
    await demo.signInAs('max@demo.stacks');
    expect(await screen.findByText('Game Night Snacks')).toBeInTheDocument();
    expect(screen.queryByText('Summer Send-off')).not.toBeInTheDocument(); // over
    expect(screen.queryByRole('link', { name: '+ Host a potluck' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Game Night Snacks'));
    await userEvent.click(await screen.findByRole('button', { name: 'Maybe' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Maybe' })).toHaveAttribute('aria-pressed', 'true'));

    const drinks = screen.getByRole('region', { name: 'Drinks' });
    await userEvent.click(within(drinks).getByRole('button', { name: '+ Bring drink' }));
    await userEvent.type(within(drinks).getByLabelText('What are you bringing?'), 'Ginger lemonade');
    await userEvent.click(within(drinks).getByLabelText('vegan'));
    await userEvent.click(within(drinks).getByRole('button', { name: 'Sign up' }));
    expect(await within(drinks).findByText('Ginger lemonade')).toBeInTheDocument();
    expect(within(drinks).getByText('vegan')).toBeInTheDocument();
    expect(within(drinks).getByRole('button', { name: 'Remove Ginger lemonade' })).toBeInTheDocument();
  });

  it('a host posts a new potluck and lands on its page', async () => {
    const demo = renderDemo();
    await demo.signInAs('olive@demo.stacks');
    await userEvent.click(await screen.findByRole('link', { name: '+ Host a potluck' }));
    await userEvent.type(await screen.findByLabelText('Name'), 'Soup Swap');
    await userEvent.type(screen.getByLabelText('When'), '2030-02-01T18:00');
    await userEvent.type(screen.getByLabelText('Where (only members see this)'), 'Community hall');
    await userEvent.click(screen.getByRole('button', { name: 'Post potluck' }));
    expect(await screen.findByRole('heading', { name: /Soup Swap/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit' })).toBeInTheDocument();
  });

  it('has a demo persona for every role, top role first', () => {
    expect([...new Set(personas.map((p) => p.role))].sort()).toEqual(manifest.roles.map((r) => r.id).sort());
    expect(personas[0]!.role).toBe('HOST');
  });
});
