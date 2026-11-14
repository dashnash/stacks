import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Demo } from '@stacks/demo';
import { createDemo, DemoApp } from '@stacks/demo';
import { personas, seed } from '../api/demo-data';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';
import { App } from '../web/src/App';

const demos: Demo[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const d of demos.splice(0)) d.realtime?.close();
});

const renderDemo = () => {
  const demo = createDemo({ manifest, routes, personas, seed });
  demos.push(demo);
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

  it('keeps the Live panel in step between two personas: the counter and waves', async () => {
    // Two demo tabs side by side, one persona each (the demo bus links them like the real Event API).
    const tab = (as: string) => {
      const demo = createDemo({ manifest, routes, personas, seed });
      demos.push(demo);
      const { container } = render(
        <div>
          <DemoApp demo={demo} startAs={as}>
            <App />
          </DemoApp>
        </div>,
      );
      return within(container.firstElementChild as HTMLElement);
    };
    const olive = tab('olive@demo.stacks');
    const max = tab('max@demo.stacks');
    expect(await olive.findByText('Live')).toBeInTheDocument();
    expect(await max.findByText('Live')).toBeInTheDocument();
    expect(max.getByLabelText('Shared counter')).toHaveTextContent('0');

    // +1 is disabled until its POST returns, and a click doesn't wait for that: let each one finish.
    await userEvent.click(olive.getByText('+1'));
    await expect.poll(() => (olive.getByText('+1') as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(olive.getByText('+1'));
    await expect.poll(() => olive.getByLabelText('Shared counter').textContent).toBe('2');
    await expect.poll(() => max.getByLabelText('Shared counter').textContent).toBe('2');

    await userEvent.click(max.getByText('Wave 👋'));
    expect(await max.findByText('You waved 👋')).toBeInTheDocument();
    expect(await olive.findByText('Max waved 👋')).toBeInTheDocument();
    expect(max.queryByText('Max waved 👋')).not.toBeInTheDocument();
  });
});
