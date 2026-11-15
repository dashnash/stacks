import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemo, DemoApp } from '@stacks/demo';
import { fakeGameKit, fakeMotion, installFakeNative, NativeError, type FakeHandlers } from '@stacks/native';
import { personas, seed } from '../api/demo-data';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';
import { App } from '../web/src/App';

let removeFake: (() => void) | null = null;
const fakeApp = (extra: FakeHandlers = {}) => {
  const motion = fakeMotion({ wobble: true });
  const fake = installFakeNative({ ...motion.handlers, ...fakeGameKit(), ...extra });
  removeFake = () => {
    motion.stop();
    fake.remove();
  };
  return { motion, fake };
};

beforeEach(() => {
  localStorage.clear();
  location.hash = '#/';
});
afterEach(() => {
  removeFake?.();
  removeFake = null;
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
const go = (hash: string) =>
  act(() => {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });

describe('Lab', () => {
  it("streams the app's motion at the asked rate and measures it", async () => {
    const { fake } = fakeApp();
    renderDemo();
    expect(await screen.findByTestId('source')).toHaveTextContent('Fake · 100 Hz');
    await waitFor(() => expect(Number(screen.getByTestId('measured').textContent)).toBeGreaterThan(50), { timeout: 3000 });
    await userEvent.click(screen.getByRole('button', { name: '30 Hz' }));
    expect(await screen.findByTestId('source')).toHaveTextContent('Fake · 30 Hz');
    expect(fake.log.filter((l) => l.name === 'motion.start').map((l) => (l.args as { hz: number }).hz)).toEqual(expect.arrayContaining([100, 30]));
    expect(fake.log.some((l) => l.name === 'motion.stop')).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Zero' })).toBeEnabled());
  });

  it('says so when the app refuses motion', async () => {
    fakeApp({
      'motion.start': () => {
        throw new NativeError('forbidden', 'not declared');
      },
    });
    renderDemo();
    expect(await screen.findByRole('alert')).toHaveTextContent(/refused/);
  });

  it('has no sensors in a desktop browser without the app, and says what to do', async () => {
    renderDemo();
    expect(await screen.findByTestId('source')).toHaveTextContent('None');
    expect(await screen.findByRole('alert')).toHaveTextContent(/arrow keys/);
  });

  it('works signed in too, and there is one demo persona per role', async () => {
    fakeApp();
    renderDemo();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('source')).toHaveTextContent('Fake');
    expect(personas.map((p) => p.role).sort()).toEqual(manifest.roles.map((r) => r.id).sort());
  });
});

describe('Kit', () => {
  it('tries each control and shows what happened', async () => {
    const { fake } = fakeApp({ 'screen.keepAwake': () => Promise.reject(new NativeError('forbidden', 'no')) });
    renderDemo();
    go('#/kit');
    await userEvent.click(await screen.findByRole('button', { name: 'Impacts: heavy' }));
    expect(screen.getByLabelText('Impacts heavy result')).toHaveTextContent('ok');
    await userEvent.click(screen.getByRole('button', { name: 'Pattern: heartbeat' }));
    expect(screen.getByLabelText('Pattern heartbeat result')).toHaveTextContent('ok');
    await userEvent.click(screen.getByRole('button', { name: 'Orientation lock: landscape' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep awake: on' }));
    expect(screen.getByLabelText('Keep awake on result')).toHaveTextContent('forbidden');
    expect(fake.log.map((l) => l.name)).toEqual(expect.arrayContaining(['haptics.impact', 'haptics.pattern', 'screen.lockOrientation', 'screen.keepAwake']));
  });

  it('in a browser: haptics fall back quietly, immersive is unsupported', async () => {
    renderDemo();
    go('#/kit');
    await userEvent.click(await screen.findByRole('button', { name: 'Notifications: success' }));
    expect(screen.getByLabelText('Notifications success result')).toHaveTextContent('web');
    await userEvent.click(screen.getByRole('button', { name: 'Immersive: on' }));
    expect(screen.getByLabelText('Immersive on result')).toHaveTextContent('unsupported');
  });
});

describe('Maze', () => {
  it('rolls the marble with the arrow keys and starts the clock', async () => {
    renderDemo();
    go('#/maze');
    const ball = await screen.findByTestId('ball');
    const x0 = Number(ball.getAttribute('cx'));
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(Number(screen.getByTestId('ball').getAttribute('cx'))).toBeGreaterThan(x0 + 0.2), { timeout: 3000 });
    fireEvent.keyUp(window, { key: 'ArrowRight' });
    expect(screen.getByTestId('timer').textContent).not.toBe('0.00 s');
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(Number(screen.getByTestId('ball').getAttribute('cx'))).toBeCloseTo(x0);
  });

  it('takes the whole screen in the app while playing, and gives it back', async () => {
    const { fake } = fakeApp();
    renderDemo();
    go('#/maze');
    await screen.findByTestId('ball');
    await waitFor(() => expect(fake.log).toEqual(expect.arrayContaining([{ name: 'screen.immersive', args: { on: true } }, { name: 'screen.lockOrientation', args: { orientation: 'portrait' } }])));
    go('#/');
    await waitFor(() => expect(fake.log).toEqual(expect.arrayContaining([{ name: 'screen.immersive', args: { on: false } }, { name: 'screen.lockOrientation', args: { orientation: 'any' } }])));
  });
});
