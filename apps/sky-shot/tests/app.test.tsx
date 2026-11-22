import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemo, DemoApp, type Demo } from '@stacks/demo';
import { fakeCamera, fakeGameKit, fakeMotion, installFakeNative, screenRays } from '@stacks/native';
import { codeSpots } from '../game/snap';
import { useHashRoute } from '@stacks/web';
import { personas } from '../api/demo-data';
import { manifest } from '../api/manifest';
import { encodeQr } from '../web/src/qr';
import { gunLink } from '../web/src/Screen';
import { toCsv } from '../web/src/Telemetry';
import { App, demoOptions } from '../web/src/demo/setup';
import { Gun } from '../web/src/Gun';
import { changedKnobs, TrainingResult } from '../web/src/Training';
import { DEFAULT_TUNING } from '../game/tuning';
import type { FitReport } from '../game/fit';

const MAX = 'max@demo.stacks';
const OLIVE = 'olive@demo.stacks';
const demos: Demo[] = [];
let fake: { remove(): void } | null = null;
let motion: ReturnType<typeof fakeMotion>;
const flick = { on: false };

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
  motion = fakeMotion();
  fake = installFakeNative({ ...motion.handlers, ...fakeGameKit() });
  // jsdom has no canvas: the game draws nothing, everything else runs.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  for (const d of demos.splice(0)) d.close();
  fake?.remove();
  vi.restoreAllMocks();
});

/** The demo page: the app, and while a room is open, the pretend phone (as the same persona). */
function Page() {
  const { segments } = useHashRoute();
  return (
    <>
      <App />
      {segments[0] === 'play' && segments[1] && (
        <div data-testid="phone">
          <Gun roomId={segments[1]} autoEnable extraAccel={() => (flick.on ? [0, 3, 0] : null)} />
        </div>
      )}
    </>
  );
}

async function renderDemo(as?: string, withPhone = false) {
  const demo = createDemo({ ...demoOptions(), storageKey: false, gameStartDelayMs: 30 });
  demos.push(demo);
  if (as) await demo.signInAs(as);
  render(<DemoApp demo={demo}>{withPhone ? <Page /> : <App />}</DemoApp>);
  return demo;
}

const T = { timeout: 8000 };

/** The phone's connect-time calibration, skipped (the calibration tests walk it). */
async function skipCalibration(phone: HTMLElement) {
  await userEvent.click(await within(phone).findByRole('button', { name: 'Skip' }, T));
}
/** Pick a game on the phone's menu (the controller runs the game). */
async function pickGame(phone: HTMLElement, name: 'Rounds' | 'Range' | 'Training') {
  await userEvent.click(await within(phone).findByRole('radio', { name: new RegExp(`^${name}`) }, T));
}
/** Play, pair the pretend phone, skip its calibration, and pick a game. */
async function playOn(name: 'Rounds' | 'Range' | 'Training' = 'Rounds') {
  await userEvent.click(await screen.findByRole('button', { name: 'Play' }, T));
  const phone = await screen.findByTestId('phone');
  await skipCalibration(phone);
  if (name !== 'Rounds') await pickGame(phone, name);
  return phone;
}

describe('Whee: pre-warming', () => {
  // jsdom has no matchMedia: a desktop has a fine pointer, a phone doesn't.
  const pointer = (fine: boolean) =>
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: (q: string) => ({ matches: fine && q === '(pointer: fine)', media: q }) as MediaQueryList });
  afterEach(() => Reflect.deleteProperty(window, 'matchMedia'));

  it('starts a server on the title screen (desktop), and Play takes it instead of starting another', async () => {
    pointer(true);
    const demo = createDemo({ ...demoOptions(), storageKey: false, gameStartDelayMs: 300 });
    demos.push(demo);
    const start = vi.spyOn(demo.games!, 'start');
    await demo.signInAs(MAX);
    render(<DemoApp demo={demo}><App /></DemoApp>);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1), T);
    const warmId = start.mock.calls[0]![0];
    // Play waits for the server, showing how it's going.
    expect(await screen.findByRole('status', { name: 'Getting your game ready' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled(), T);
    expect(screen.getByText('Your game is ready')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/play/${warmId}/rounds`), T);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Use the mouse instead', {}, T)).toBeInTheDocument();
    expect(screen.queryByText('Starting the game server…')).toBeNull();
  });

  it("doesn't warm on a phone (it joins by code)", async () => {
    pointer(false);
    const demo = createDemo({ ...demoOptions(), storageKey: false, gameStartDelayMs: 30 });
    demos.push(demo);
    const start = vi.spyOn(demo.games!, 'start');
    await demo.signInAs(MAX);
    render(<DemoApp demo={demo}><App /></DemoApp>);
    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 200));
    expect(start).not.toHaveBeenCalled();
  });
});

describe('Whee: title and leaderboard', () => {
  it('signed out: the title, the leaderboard with first names, and Sign in to play', async () => {
    await renderDemo();
    expect(await screen.findByText(manifest.tagline)).toBeInTheDocument();
    const board = await screen.findByRole('region', { name: 'Leaderboard' });
    expect(await within(board).findByText('Robin')).toBeInTheDocument();
    expect(within(board).getAllByRole('listitem').map((li) => `${li.querySelector('.rank')!.textContent} ${li.querySelector('.name')!.textContent}`)).toEqual(['1 Max', '2 Robin', '3 Olive', '4 Sam']);
    expect(screen.getByRole('button', { name: 'Sign in to play' })).toBeInTheDocument();
    expect(within(board).queryByRole('button', { name: /Remove/ })).toBeNull();
  });

  it('shows your best; the owner can remove a row', async () => {
    await renderDemo(OLIVE);
    expect(await screen.findByText(/Your best:/)).toHaveTextContent('5,100');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Sam from the leaderboard' }));
    await waitFor(() => expect(screen.queryByText('Sam')).toBeNull());
  });

  it('has one demo persona per role', () => {
    expect(personas.map((p) => p.role).sort()).toEqual(manifest.roles.map((r) => r.id).sort());
  });
});

describe('Whee: playing', () => {
  it('Play starts a room and shows the QR code and code to pair the phone', async () => {
    await renderDemo(MAX);
    await userEvent.click(await screen.findByRole('button', { name: 'Play' }));
    expect(await screen.findByText('Pair your controller', {}, T)).toBeInTheDocument();
    const id = window.location.hash.split('/')[2]!;
    const qr = screen.getByRole('img', { name: 'QR code to open the gun on your phone' });
    expect(qr.closest('a')).toHaveAttribute('href', gunLink(id));
    expect(screen.getByText(/^[A-HJKMNP-Z2-9]{4}$/)).toHaveClass('code');
  });

  it('pairs the phone as a second seat, calibrates, starts from the phone, and a tap fires a shot the server judges', async () => {
    await renderDemo(MAX, true);
    await userEvent.click(await screen.findByRole('button', { name: 'Play' }));
    // The phone (same person, device "gun") joins: it calibrates first, step 1 with no crosshair.
    const phone = await screen.findByTestId('phone');
    await waitFor(() => expect(within(phone).getByText(/^Live/)).toBeInTheDocument(), T);
    expect(await screen.findByRole('dialog', { name: 'Calibrating' }, T)).toHaveTextContent('Player 1 · Step 1 of 2 · Initialize · Dot 1 of 5');
    expect(await within(phone).findByText('Step 1 of 2 · Initialize', {}, T)).toBeInTheDocument();
    await skipCalibration(phone);
    // The lobby: the phone has the menu, the screen starts.
    expect(await within(phone).findByText('Rounds · Dusk', {}, T)).toBeInTheDocument();
    expect(await screen.findByText('Pick the game and start it on your phone.', {}, T)).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: 'Ready' })).queryByRole('button', { name: /^Start/ })).toBeNull();
    await userEvent.click(await within(phone).findByRole('button', { name: 'Start Round 1' }, T));
    await waitFor(() => expect(screen.getByLabelText('3 shots left')).toBeInTheDocument(), T);

    await userEvent.pointer({ keys: '[MouseLeft>]', target: await within(phone).findByRole('button', { name: 'Fire' }, T) });
    await waitFor(() => expect(screen.queryByLabelText('3 shots left')).toBeNull(), T);
    expect(screen.getByLabelText(/^[0-2] shots left$/)).toBeInTheDocument();
  }, 20_000);

  it('the tuning panel sends changes live: flick mode turns the trigger off and a jolt fires', async () => {
    await renderDemo(MAX, true);
    const phone = await playOn('Range');
    await userEvent.click(await within(phone).findByRole('button', { name: 'Start the Range' }, T));
    await userEvent.click(screen.getByRole('button', { name: 'Tuning (T)' }));
    const panel = screen.getByRole('complementary', { name: 'Tuning' });
    const before = within(panel).getByText(/^config /).textContent;
    await userEvent.selectOptions(within(panel).getByLabelText('Trigger'), 'flick');
    // The server applies it and tells everyone: a new config id, and the phone switches.
    await waitFor(() => expect(within(panel).getByText(/^config /).textContent).not.toBe(before), T);
    expect(await within(phone).findByRole('button', { name: 'Flick to fire' }, T)).toBeInTheDocument();

    act(() => void (flick.on = true));
    await new Promise((r) => setTimeout(r, 120));
    act(() => void (flick.on = false));
    await waitFor(() => expect(within(panel).getByRole('table')).toHaveTextContent(/1\/1|0\/1/), T);
  }, 20_000);

  it('plays with the mouse when there is no phone', async () => {
    await renderDemo(MAX);
    await userEvent.click(await screen.findByRole('button', { name: 'Play' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use the mouse instead' }, T));
    expect(await screen.findByRole('button', { name: 'Start Round 1 (Enter)' }, T)).toBeInTheDocument();
    expect(screen.getByText('● mouse')).toBeInTheDocument();
    // No phone: the screen has the menu, and Training needs a phone.
    const lobby = screen.getByRole('dialog', { name: 'Ready' });
    expect(within(lobby).getByRole('radio', { name: /^Training/ })).toBeDisabled();
    await userEvent.click(within(lobby).getByRole('radio', { name: /^Range/ }));
    expect(await screen.findByRole('button', { name: 'Start the Range (Enter)' }, T)).toBeInTheDocument();
  }, 15_000);
});

describe('Whee: the look', () => {
  it('the title screen offers the looks, Dusk by default, signed in and out', async () => {
    await renderDemo();
    const looks = await screen.findByRole('radiogroup', { name: 'Look' });
    expect(within(looks).getByRole('radio', { name: 'Dusk' })).toHaveAttribute('aria-checked', 'true');
  });

  it('the screen and the phone wear the look; the tuning panel can change it and show hitboxes', async () => {
    await renderDemo(MAX, true);
    const phone = await playOn('Range');
    await userEvent.click(await within(phone).findByRole('button', { name: 'Start the Range' }, T));
    const play = screen.getByLabelText('Whee play area').closest('.screen') as HTMLElement;
    expect(play).toHaveAttribute('data-theme', 'dusk');
    expect(play.style.getPropertyValue('--hud-accent')).toBe('#ffd23f');
    await waitFor(() => expect(phone.querySelector('.gun')).toHaveAttribute('data-theme', 'dusk'), T);
    expect(await within(phone).findByRole('button', { name: 'Fire' }, T)).toHaveTextContent('FIRE');
    await userEvent.click(screen.getByRole('button', { name: 'Tuning (T)' }));
    const panel = screen.getByRole('complementary', { name: 'Tuning' });
    expect(within(panel).getByLabelText('Look (L)')).toHaveValue('dusk/dusk');
    await userEvent.click(within(panel).getByLabelText('Show hitboxes'));
    expect(within(panel).getByLabelText('Show hitboxes')).toBeChecked();
  }, 20_000);

  it('picking Ink Koi saves it to your account; the screen wears it and the phone says catch', async () => {
    const demo = await renderDemo(MAX, true);
    const looks = await screen.findByRole('radiogroup', { name: 'Look' });
    await userEvent.click(within(looks).getByRole('radio', { name: 'Ink Koi' }));
    expect(within(looks).getByRole('radio', { name: 'Ink Koi' })).toHaveAttribute('aria-checked', 'true');
    // Its palettes, Rice paper first.
    const palettes = screen.getByRole('radiogroup', { name: 'Ink Koi palette' });
    expect(within(palettes).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Rice paper', 'Moon pond']);
    expect(within(palettes).getByRole('radio', { name: 'Rice paper' })).toHaveAttribute('aria-checked', 'true');

    // Saved by PUT /prefs: a fresh page with nothing in this browser comes back in Ink Koi.
    cleanup();
    localStorage.clear();
    render(<DemoApp demo={demo}><Page /></DemoApp>);
    const again = await screen.findByRole('radiogroup', { name: 'Look' });
    await waitFor(() => expect(within(again).getByRole('radio', { name: 'Ink Koi' })).toHaveAttribute('aria-checked', 'true'), T);

    const phone = await playOn('Range');
    await userEvent.click(await within(phone).findByRole('button', { name: 'Start the Range' }, T));
    const play = screen.getByLabelText('Whee play area').closest('.screen') as HTMLElement;
    expect(play).toHaveAttribute('data-theme', 'koi');
    expect(play).toHaveAttribute('data-palette', 'rice');
    expect(play.style.getPropertyValue('--gun-bg')).toBe('#ede4cf');
    // The room's theme event reaches the phone.
    await waitFor(() => expect(phone.querySelector('.gun')).toHaveAttribute('data-theme', 'koi'), T);
    expect(await within(phone).findByRole('button', { name: 'Fire' }, T)).toHaveTextContent('Tap to catch');
  }, 20_000);

  it('ignores a look in this browser that does not exist', async () => {
    localStorage.setItem('sky-shot:theme', JSON.stringify({ id: 'gone', palette: 'x' }));
    await renderDemo();
    const looks = await screen.findByRole('radiogroup', { name: 'Look' });
    expect(within(looks).getByRole('radio', { name: 'Dusk' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Whee: calibration on connect', () => {
  const dots: [number, number][] = [
    [0.5, 0.5],
    [0.15, 0.2],
    [0.85, 0.2],
    [0.85, 0.8],
    [0.15, 0.8],
  ];
  /** Point at each dot (gain 1.5 widths/rad), hold a moment, tap. */
  async function fiveDots(phone: HTMLElement) {
    for (const [k, [x, y]] of dots.entries()) {
      act(() => motion.set({ roll: 0, pitch: -(y - 0.5) / (1.5 * 1.6), yaw: -(x - 0.5) / 1.5 }));
      await new Promise((r) => setTimeout(r, 350));
      await userEvent.pointer({ keys: '[MouseLeft>]', target: await within(phone).findByRole('button', { name: `On the dot (${k + 1} of 5)` }, T) });
      await userEvent.pointer({ keys: '[/MouseLeft]' });
    }
  }

  it('step 1 (no crosshair) then step 2 (live crosshair); the fit is saved and the next room starts with it', async () => {
    await renderDemo(MAX, true);
    await userEvent.click(await screen.findByRole('button', { name: 'Play' }));
    const phone = await screen.findByTestId('phone');
    expect(await screen.findByRole('dialog', { name: 'Calibrating' }, T)).toHaveTextContent('Step 1 of 2 · Initialize');
    expect(screen.getByText('No crosshair yet: this finds where your phone points.')).toBeInTheDocument();
    await fiveDots(phone);
    expect(await within(phone).findByText('Step 2 of 2 · Calibrate', {}, T)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Calibrating' })).toHaveTextContent('Put the crosshair on the dot and tap'), T);
    await fiveDots(phone);
    expect(await screen.findByText(/^Calibrated: .* Saved as your default\.$/, {}, T)).toBeInTheDocument();
    // Re-calibrate from the phone's menu: step 2 only.
    await userEvent.click(await within(phone).findByRole('button', { name: /^Re-calibrate/ }, T));
    expect(await within(phone).findByText('Step 2 of 2 · Calibrate', {}, T)).toBeInTheDocument();
    await skipCalibration(phone);
    // The saved default carries to a new room.
    act(() => void (window.location.hash = '#/'));
    const phone2 = await playOn('Range');
    await userEvent.click(await within(phone2).findByRole('button', { name: 'Start the Range' }, T));
    await userEvent.click(screen.getByRole('button', { name: 'Tuning (T)' }));
    const panel = screen.getByRole('complementary', { name: 'Tuning' });
    await waitFor(() => expect(within(panel).getByRole('slider', { name: /^Turn gain/ })).not.toHaveValue('1.6'), T);
  }, 40_000);
});

describe('Whee: camera calibration', () => {
  it('a phone with a camera snaps the screen (codes at its corners), then one centre tap', async () => {
    fake?.remove();
    const camera = fakeCamera({
      locate: ({ codes }) => {
        const spots = codeSpots(window.innerWidth / window.innerHeight);
        return screenRays(
          { yaw: 0, pitch: 0, widthRad: 0.55, aspect: window.innerWidth / window.innerHeight },
          codes.map((code, i) => ({ code, x: spots[i]![0], y: spots[i]![1] })),
          { roll: 0, pitch: Math.PI / 2, yaw: 0 },
        );
      },
    });
    fake = installFakeNative({ ...motion.handlers, ...camera.handlers, ...fakeGameKit() });
    await renderDemo(MAX, true);
    await userEvent.click(await screen.findByRole('button', { name: 'Play' }));
    const phone = await screen.findByTestId('phone');
    const layer = await screen.findByRole('dialog', { name: 'Calibrating with the camera' }, T);
    expect(within(layer).getAllByRole('img', { name: /^Calibration code \d of 4$/ })).toHaveLength(4);
    expect(within(layer).getByText('Player 1 · Snap the screen')).toBeInTheDocument();
    await userEvent.click(await within(phone).findByRole('button', { name: 'Snap the screen' }, T));
    expect(camera.calls[0]!.codes).toHaveLength(4);
    expect(await within(phone).findByText('2 · Centre tap', {}, T)).toBeInTheDocument();
    await waitFor(() => expect(within(layer).getByText('Player 1 · Centre tap')).toBeInTheDocument(), T);
    // Snap again goes back; then the tap.
    await userEvent.click(within(phone).getByRole('button', { name: 'Snap again' }));
    await userEvent.click(await within(phone).findByRole('button', { name: 'Snap the screen' }, T));
    await new Promise((r) => setTimeout(r, 300));
    await userEvent.pointer({ keys: '[MouseLeft>]', target: await within(phone).findByRole('button', { name: 'On the centre dot' }, T) });
    await userEvent.pointer({ keys: '[/MouseLeft]' });
    expect(await within(phone).findByText('Calibrated.', {}, T)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Calibrating with the camera' })).toBeNull(), T);
    expect(await within(phone).findByRole('button', { name: 'Start Round 1' }, T)).toBeEnabled();
  }, 30_000);

  it('a phone without one goes straight to the dots', async () => {
    await renderDemo(MAX, true);
    await userEvent.click(await screen.findByRole('button', { name: 'Play' }));
    expect(await screen.findByRole('dialog', { name: 'Calibrating' }, T)).toHaveTextContent('Step 1 of 2 · Initialize');
    expect(screen.queryByRole('dialog', { name: 'Calibrating with the camera' })).toBeNull();
  });
});

describe('Whee: the controller', () => {
  it('swaps the look mid-round, pauses into the menu, switches game live, and exits to the title', async () => {
    await renderDemo(MAX, true);
    const phone = await playOn();
    await userEvent.click(await within(phone).findByRole('button', { name: 'Start Round 1' }, T));
    await waitFor(() => expect(screen.getByLabelText('3 shots left')).toBeInTheDocument(), T);
    const play = screen.getByLabelText('Whee play area').closest('.screen') as HTMLElement;
    // The look chip: the next look, live, without pausing (and it's kept as yours).
    await userEvent.click(await within(phone).findByRole('button', { name: 'Look: Dusk. Tap for the next look' }, T));
    await waitFor(() => expect(play).toHaveAttribute('data-theme', 'koi'), T);
    expect(screen.queryByText('Paused')).toBeNull();
    // Pause: the screen says the menu is on the phone.
    await userEvent.click(await within(phone).findByRole('button', { name: 'Pause' }, T));
    expect(await screen.findByText('The menu is on your phone.', {}, T)).toBeInTheDocument();
    // Switching game ends the round and starts the Range.
    await pickGame(phone, 'Range');
    await waitFor(() => expect(screen.getByText(/^Range · /)).toBeInTheDocument(), T);
    expect(screen.queryByText('The menu is on your phone.')).toBeNull();
    // Exit from the phone, confirmed: saved, and the screen goes back to the title.
    await userEvent.click(await within(phone).findByRole('button', { name: 'Pause' }, T));
    await userEvent.click(await within(phone).findByRole('button', { name: '← Exit to menu' }, T));
    await userEvent.click(within(phone).getByRole('button', { name: 'Exit' }));
    await waitFor(() => expect(window.location.hash).toBe('#/'), T);
  }, 30_000);

  it('the screen only exits: Esc asks in a game (a second Esc exits), and exits at once outside one', async () => {
    await renderDemo(MAX, true);
    const phone = await playOn();
    await userEvent.click(await within(phone).findByRole('button', { name: 'Start Round 1' }, T));
    await waitFor(() => expect(screen.getByLabelText('3 shots left')).toBeInTheDocument(), T);
    await userEvent.keyboard('{Escape}');
    const ask = await screen.findByRole('alertdialog', { name: 'Exit to menu?' }, T);
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog', { name: 'Exit to menu?' })).toBeNull();
    // Paused from the phone: no Resume on the screen, only Exit.
    await userEvent.click(await within(phone).findByRole('button', { name: 'Pause' }, T));
    const card = (await screen.findByText('The menu is on your phone.', {}, T)).closest('.overlay') as HTMLElement;
    expect(within(card).queryByRole('button', { name: 'Resume' })).toBeNull();
    await userEvent.click(await within(phone).findByRole('button', { name: 'Resume' }, T));
    await waitFor(() => expect(screen.queryByText('The menu is on your phone.')).toBeNull(), T);
    await userEvent.keyboard('{Escape}');
    await screen.findByRole('alertdialog', { name: 'Exit to menu?' }, T);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(window.location.hash).toBe('#/'), T);
    // Outside a game (the lobby), Esc exits.
    await playOn();
    await screen.findByText('Pick the game and start it on your phone.', {}, T);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(window.location.hash).toBe('#/'), T);
  }, 30_000);
});

describe('Whee: training', () => {
  it('Training explains, calibrates (both passes), then runs the script with the phone told to watch the screen', async () => {
    await renderDemo(MAX, true);
    const phone = await playOn('Training');
    expect(await screen.findByRole('dialog', { name: 'Training' }, T)).toHaveTextContent('When the crosshair vanishes');
    expect(screen.queryByRole('button', { name: 'Start training' })).toBeNull();
    await userEvent.click(await within(phone).findByRole('button', { name: 'Start training' }, T));
    // The game's calibration first, both passes (skipped here), then the script.
    expect(await screen.findByRole('dialog', { name: 'Calibrating' }, T)).toHaveTextContent('Step 1 of 2 · Initialize');
    await skipCalibration(phone);
    expect(await screen.findByText(/^[12] \/ 16$/, {}, T)).toBeInTheDocument();
    expect(await within(phone).findByText(/follow the dot/, {}, T)).toBeInTheDocument();
    expect(within(phone).queryByRole('button', { name: 'Fire' })).toBeNull();
  }, 20_000);

  it('shows the fit next to yours: speed, jump miss, lag and shake, and what changed', async () => {
    const report: FitReport = {
      v: 1,
      base: { ...DEFAULT_TUNING },
      fitted: { ...DEFAULT_TUNING, mode: 'relative', sensitivity: 0.7, accelCurve: 1.45 },
      before: { jumpErr: 0.12, gain: 1.62, jitter: 0.001, lagMs: 140 },
      after: { jumpErr: 0.03, gain: 1.01, jitter: 0.0012, lagMs: 55 },
      usedJumps: 22,
      totalJumps: 24,
      latencyMs: 60,
      jumps: [],
    };
    const on = { compare: vi.fn(), use: vi.fn(), keep: vi.fn(), again: vi.fn() };
    render(<TrainingResult report={report} onCompare={on.compare} onUse={on.use} onKeep={on.keep} onAgain={on.again} />);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('row', { name: /Speed/ })).toHaveTextContent('1.62×1.01×too fast → about right');
    expect(within(table).getByRole('row', { name: /Lag/ })).toHaveTextContent('140 ms55 ms');
    expect(screen.getByText('What changed (3)')).toBeInTheDocument();
    expect(changedKnobs(report.base, report.fitted).map((c) => `${c.label}: ${c.from} → ${c.to}`)).toEqual([
      'Aim mapping: absolute → relative',
      'Sensitivity: 1.2 widths/rad → 0.7 widths/rad',
      'Accel curve: 1.3 → 1.45',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Compare blind (A/B)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Use the fit' }));
    expect([on.compare, on.use].map((f) => f.mock.calls.length)).toEqual([1, 1]);
  });

  it('"Save as my default" sticks: the next room starts with it', async () => {
    await renderDemo(MAX, true);
    const first = await playOn('Range');
    await userEvent.click(await within(first).findByRole('button', { name: 'Start the Range' }, T));
    await userEvent.click(screen.getByRole('button', { name: 'Tuning (T)' }));
    const panel = screen.getByRole('complementary', { name: 'Tuning' });
    await userEvent.selectOptions(within(panel).getByLabelText('Trigger'), 'flick');
    await within(await screen.findByTestId('phone')).findByRole('button', { name: 'Flick to fire' }, T);
    await userEvent.click(within(panel).getByRole('button', { name: 'Save as my default' }));
    expect(await screen.findByText('Saved as your default', {}, T)).toBeInTheDocument();
    // A new room: the screen sends the saved default, and the phone switches to flick.
    act(() => void (window.location.hash = '#/'));
    const phone = await playOn();
    await userEvent.click(await within(phone).findByRole('button', { name: 'Start Round 1' }, T));
    expect(await within(phone).findByRole('button', { name: 'Flick to fire' }, T)).toBeInTheDocument();
  }, 25_000);
});

describe('Whee: telemetry', () => {
  it('shows a shooter only their own shots, and the owner everyone\'s', async () => {
    window.location.hash = '#/telemetry';
    await renderDemo(MAX);
    expect(await screen.findByRole('heading', { name: 'Your shots' })).toBeInTheDocument();
    expect(await screen.findByText(/^18 shots shown/)).toBeInTheDocument();
    for (const d of demos.splice(0)) d.close();
  });

  it('the owner sees everyone\'s, and can filter by config', async () => {
    window.location.hash = '#/telemetry';
    await renderDemo(OLIVE);
    expect(await screen.findByRole('heading', { name: "Everyone's shots" })).toBeInTheDocument();
    expect(await screen.findByText(/^36 shots shown/)).toBeInTheDocument();
    const select = screen.getByLabelText('Config');
    const ids = within(select).getAllByRole('option').map((o) => o.textContent).filter((t) => t !== 'All');
    await userEvent.selectOptions(select, ids[0]!);
    expect(await screen.findByText(/^18 shots shown/)).toBeInTheDocument();
  });

  it('downloads as CSV with one row per shot', () => {
    const csv = toCsv([
      { t: 1, at: '2026-11-20T12:00:00.000Z', shooterId: 'u_1', roomId: 'r', mode: 'range', configId: 'abc', trigger: 'tap', hit: true, missDist: 0, rewindMs: 120, latency: { gunRtt: 40, screenRtt: 30, shotToPixel: 170 }, window: [], cursor: 'x', theme: 'dusk/dusk' },
      { t: 2, at: '2026-11-20T12:00:01.000Z', shooterId: 'u_1', roomId: 'r', mode: 'range', configId: 'abc', trigger: 'tap', hit: false, missDist: 0.1, rewindMs: 120, latency: { gunRtt: 40, screenRtt: 30, shotToPixel: 170 }, window: [], cursor: 'y' },
    ]);
    expect(csv.split('\n')).toEqual([
      'at,shooterId,roomId,mode,configId,trigger,hit,missDist,rewindMs,gunRtt,screenRtt,shotToPixel,windowSamples,theme',
      '2026-11-20T12:00:00.000Z,u_1,r,range,abc,tap,true,0,120,40,30,170,0,dusk/dusk',
      // A shot from before themes: an empty theme.
      '2026-11-20T12:00:01.000Z,u_1,r,range,abc,tap,false,0.1,120,40,30,170,0,',
    ]);
  });
});

describe('the QR encoder', () => {
  it('picks the smallest version that fits, with finder patterns in three corners', () => {
    const qr = encodeQr('https://sky-shot.dashnash.ninja/#/gun/01JD8X2Y3Z4A5B6C7D8E9F0G1H');
    // 65 bytes: version 4 at level M holds 62, version 5 holds 84.
    expect(qr.version).toBe(5);
    expect(qr.size).toBe(37);
    for (const [x, y] of [
      [0, 0],
      [qr.size - 7, 0],
      [0, qr.size - 7],
    ])
      expect([0, 1, 2, 3, 4, 5, 6].map((i) => qr.modules[y!]![x! + i])).toEqual([true, true, true, true, true, true, true]);
    expect(() => encodeQr('x'.repeat(300))).toThrow(/too long/);
  });
});
