import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDemo, DemoApp } from '@stacks/demo';
import { personas, seed } from '../api/demo-data';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';
import { App } from '../web/src/App';

beforeEach(() => localStorage.clear());

const renderDemo = () => {
  const demo = createDemo({ manifest, routes, personas, seed, storageKey: false });
  render(
    <DemoApp demo={demo}>
      <App />
    </DemoApp>,
  );
  return demo;
};

// STARTER TESTS: they run the real UI on the in-browser demo backend. Replace with the app's own.
describe(`${manifest.name} UI (on the demo backend)`, () => {
  it('shows the landing page signed out, then lets the first persona add a note', async () => {
    renderDemo();
    expect(await screen.findByText(manifest.tagline)).toBeInTheDocument();
    // The account menu's Sign in (the landing page has its own button too).
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const box = await screen.findByLabelText(`Hi ${personas[0]!.name}, add a note`);
    await userEvent.type(box, 'Hello from a test');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Hello from a test')).toBeInTheDocument();
  });

  it('has one demo persona per role', () => {
    expect(personas.map((p) => p.role).sort()).toEqual(manifest.roles.map((r) => r.id).sort());
  });
});
