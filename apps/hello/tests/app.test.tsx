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
  const demo = createDemo({ manifest, routes, personas, seed });
  render(
    <DemoApp demo={demo}>
      <App />
    </DemoApp>,
  );
  return demo;
};

describe('Hello Board UI (on the demo backend)', () => {
  it('shows the public greetings signed out, then lets a member post', async () => {
    renderDemo();
    expect(await screen.findByText('Welcome to the Hello Board.')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Sign in to say hello'));
    expect(await screen.findByLabelText('Hi Olive, say hello')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Hi Olive, say hello'), 'Hello from a test');
    await userEvent.click(screen.getByText('Post'));
    expect(await screen.findByText('Hello from a test')).toBeInTheDocument();
  });

  it('shows delete buttons only to owners', async () => {
    const demo = renderDemo();
    await demo.signInAs('max@demo.stacks');
    expect(await screen.findByLabelText('Hi Max, say hello')).toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    await demo.signInAs('olive@demo.stacks');
    expect((await screen.findAllByText('Delete')).length).toBe(2);
  });
});
