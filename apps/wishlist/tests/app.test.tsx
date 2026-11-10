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

describe('Wishlist UI (on the demo backend)', () => {
  it('signed out: says what it is, shows no names or lists', async () => {
    renderDemo();
    expect(await screen.findByText(manifest.tagline)).toBeInTheDocument();
    expect(screen.queryByText(/Nana/)).not.toBeInTheDocument();
  });

  it("a member claims from someone's list and finds it in My claims", async () => {
    const demo = renderDemo();
    await demo.signInAs('max@demo.stacks');
    await userEvent.click(await screen.findByRole('link', { name: /Nana June/ }));
    const shears = (await screen.findByText('Pruning shears')).closest('li')!;
    expect(within(shears).getByText("Someone's got it")).toBeInTheDocument();
    const feeder = screen.getByText('Bird feeder').closest('li')!;
    await userEvent.click(within(feeder).getByRole('button', { name: 'Claim Bird feeder' }));
    await waitFor(() => expect(within(screen.getByText('Bird feeder').closest('li')!).getByText("You're getting this")).toBeInTheDocument());

    await userEvent.click(screen.getByRole('link', { name: 'My claims' }));
    expect(await screen.findByRole('link', { name: 'For Nana June' })).toBeInTheDocument();
    expect(screen.getByText('Bird feeder')).toBeInTheDocument();
  });

  it('on your own list: add items, and no hint of what is claimed', async () => {
    const demo = renderDemo();
    await demo.signInAs('olive@demo.stacks');
    await userEvent.click(await screen.findByRole('link', { name: /Your list/ }));
    expect(await screen.findByText(/No peeking/)).toBeInTheDocument();
    expect(screen.getByText('Cast-iron skillet, 10"')).toBeInTheDocument(); // claimed by Max in the demo…
    expect(screen.queryByText(/got it|getting this/i)).not.toBeInTheDocument(); // …but nothing says so
    expect(screen.queryByRole('checkbox', { name: 'Bought' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '+ Add something' }));
    await userEvent.type(screen.getByLabelText('What is it?'), 'Gardening gloves');
    await userEvent.click(screen.getByRole('button', { name: 'Add to my list' }));
    expect(await screen.findByText('Gardening gloves')).toBeInTheDocument();
  });

  it('has a demo persona for every role, top role first', () => {
    expect([...new Set(personas.map((p) => p.role))].sort()).toEqual(manifest.roles.map((r) => r.id).sort());
    expect(personas[0]!.role).toBe('ORGANIZER');
  });
});
