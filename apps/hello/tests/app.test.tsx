import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Demo } from '@stacks/demo';
import { createDemo, DemoApp } from '@stacks/demo';
import { personas, seed } from '../api/demo-data';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';
import game from '../game/server';
import { App } from '../web/src/App';

const demos: Demo[] = [];
beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
});
afterEach(() => {
  for (const d of demos.splice(0)) d.close();
});

const renderDemo = () => {
  const demo = createDemo({ manifest, routes, personas, seed, game, gameStartDelayMs: 150 });
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
      const demo = createDemo({ manifest, routes, personas, seed, game, gameStartDelayMs: 150 });
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

  it('plays Live dots with two personas in one room: lobby, both dots, RTT, a bump, leaving', async () => {
    // Two demo tabs side by side, as above. They share the page's address here, so both follow the room link.
    const tab = (as: string) => {
      const demo = createDemo({ manifest, routes, personas, seed, game, gameStartDelayMs: 150 });
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
    expect(await olive.findByText('Play: Live dots')).toBeInTheDocument();
    expect(await max.findByLabelText('Join with code')).toBeInTheDocument();

    // Olive starts a room: her tab shows the lobby while "the server starts", with the code to share.
    await userEvent.click(olive.getByText('New room'));
    expect(await olive.findByText('Starting the game server… (up to a minute)')).toBeInTheDocument();
    const code = (await olive.findByText(/^[A-HJKMNP-Z2-9]{4}$/)).textContent!;
    expect(olive.getByText('Copy link')).toBeInTheDocument();
    expect(window.location.hash).toMatch(/^#\/play\//);

    // Both end up on the board, each seeing both dots, their own marked.
    const board = (who: typeof olive) => who.findByRole('application', {}, { timeout: 5000 });
    const oliveBoard = await board(olive);
    const maxBoard = await board(max);
    await expect.poll(() => [...oliveBoard.querySelectorAll('.dot')].map((d) => d.textContent).sort(), { timeout: 5000 }).toEqual(['Max', 'Olive (you)']);
    await expect.poll(() => [...maxBoard.querySelectorAll('.dot')].map((d) => d.textContent).sort()).toEqual(['Max (you)', 'Olive']);
    expect(max.getByText(code)).toBeInTheDocument();
    await expect.poll(() => olive.getByLabelText('Players').textContent).toBe('Olive, Max');

    // The round trip to the server is shown in milliseconds.
    await expect.poll(() => max.getByLabelText('Round trip to the game server').textContent, { timeout: 5000 }).toMatch(/^\d+ ms$/);

    // Max points at the far corner: the server moves his dot there, and Olive sees it.
    const left = (el: HTMLElement, name: string) => parseFloat((el.querySelector(`[data-player="${name}"]`) as HTMLElement).style.left);
    const before = left(oliveBoard, 'Max');
    maxBoard.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
    // (jsdom has no PointerEvent; a mouse event of that type carries the coordinates.)
    fireEvent(maxBoard, new MouseEvent('pointerdown', { clientX: 380, clientY: 285, bubbles: true }));
    await expect.poll(() => left(oliveBoard, 'Max'), { timeout: 5000 }).toBeGreaterThan(90);
    expect(before).toBeLessThan(90);
    await expect.poll(() => left(maxBoard, 'Max')).toBeGreaterThan(90);
    // Olive's dot stayed where the server put it.
    expect(left(maxBoard, 'Olive')).toBeLessThan(50);

    // A bump shakes both screens.
    await userEvent.click(olive.getByText('Bump'));
    expect(await max.findByText('Olive bumped the board!')).toBeInTheDocument();
    expect(await olive.findByText('Olive bumped the board!')).toBeInTheDocument();
    await expect.poll(() => maxBoard.className).toContain('shake');

    // Max leaves: he is back at the lobby and his seat is free. (The two tabs share this page's
    // address in the test, so Olive's follows him out; her seat is kept by the server meanwhile.)
    await userEvent.click(max.getByText('Leave'));
    expect(await max.findByText('New room')).toBeInTheDocument();
    await expect
      .poll(async () => (await demos.at(-1)!.client.get<{ rooms: { players: number }[] }>('/rooms')).rooms.map((r) => r.players), { timeout: 5000 })
      .toEqual([1]);
  }, 30_000);

  it('says so when a code matches no game', async () => {
    const demo = renderDemo();
    await demo.signInAs('max@demo.stacks');
    await userEvent.type(await screen.findByLabelText('Join with code'), 'zzzz');
    await userEvent.click(screen.getByText('Join'));
    expect(await screen.findByText('No game with that code. Check it and try again.')).toBeInTheDocument();
  });
});
