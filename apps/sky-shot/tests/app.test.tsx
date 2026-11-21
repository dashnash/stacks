import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemo, DemoApp, type Demo } from '@stacks/demo';
import { fakeGameKit, fakeMotion, installFakeNative } from '@stacks/native';
import { useHashRoute } from '@stacks/web';
import { personas } from '../api/demo-data';
import { manifest } from '../api/manifest';
import { encodeQr } from '../web/src/qr';
import { gunLink } from '../web/src/Screen';
import { toCsv } from '../web/src/Telemetry';
import { App, demoOptions } from '../web/src/demo/setup';
import { Gun } from '../web/src/Gun';

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

describe('Sky Shot: title and leaderboard', () => {
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

describe('Sky Shot: playing', () => {
  it('Play starts a room and shows the QR code and code to pair the phone', async () => {
    await renderDemo(MAX);
    await userEvent.click(await screen.findByRole('button', { name: 'Play' }));
    expect(await screen.findByText('Pair your phone', {}, T)).toBeInTheDocument();
    const id = window.location.hash.split('/')[2]!;
    const qr = screen.getByRole('img', { name: 'QR code to open the gun on your phone' });
    expect(qr.closest('a')).toHaveAttribute('href', gunLink(id));
    expect(screen.getByText(/^[A-HJKMNP-Z2-9]{4}$/)).toHaveClass('code');
  });

  it('pairs the phone as a second seat, calibrates, starts, and a tap fires a shot the server judges', async () => {
    await renderDemo(MAX, true);
    await userEvent.click(await screen.findByRole('button', { name: 'Play' }));
    // The phone (same person, device "gun") joins: the screen goes to Calibrate.
    const phone = await screen.findByTestId('phone');
    await waitFor(() => expect(within(phone).getByText(/^Live/)).toBeInTheDocument(), T);
    expect(await screen.findByText('Point your phone at the dot and tap Calibrate', {}, T)).toBeInTheDocument();
    await userEvent.click(within(phone).getByRole('button', { name: 'Calibrate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start Round 1' }));
    await waitFor(() => expect(screen.getByLabelText('3 shots left')).toBeInTheDocument(), T);

    await userEvent.pointer({ keys: '[MouseLeft>]', target: within(phone).getByRole('button', { name: 'Fire' }) });
    await waitFor(() => expect(screen.queryByLabelText('3 shots left')).toBeNull(), T);
    expect(screen.getByLabelText(/^[0-2] shots left$/)).toBeInTheDocument();
  }, 20_000);

  it('the tuning panel sends changes live: flick mode turns the trigger off and a jolt fires', async () => {
    await renderDemo(MAX, true);
    await userEvent.click(await screen.findByRole('button', { name: 'Range' }));
    const phone = await screen.findByTestId('phone');
    await userEvent.click(await screen.findByRole('button', { name: 'Start the Range' }, T));
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
    await userEvent.click(await screen.findByRole('button', { name: 'Use mouse instead' }, T));
    expect(await screen.findByRole('button', { name: 'Start Round 1' }, T)).toBeInTheDocument();
    expect(screen.getByText('● mouse')).toBeInTheDocument();
  }, 15_000);
});

describe('Sky Shot: the look', () => {
  it('the title screen offers the looks, Dusk by default, signed in and out', async () => {
    await renderDemo();
    const looks = await screen.findByRole('radiogroup', { name: 'Look' });
    expect(within(looks).getByRole('radio', { name: 'Dusk' })).toHaveAttribute('aria-checked', 'true');
  });

  it('the screen and the phone wear the look; the tuning panel can change it and show hitboxes', async () => {
    await renderDemo(MAX, true);
    await userEvent.click(await screen.findByRole('button', { name: 'Range' }));
    const phone = await screen.findByTestId('phone');
    await userEvent.click(await screen.findByRole('button', { name: 'Start the Range' }, T));
    const play = screen.getByLabelText('Sky Shot play area').closest('.screen') as HTMLElement;
    expect(play).toHaveAttribute('data-theme', 'dusk');
    expect(play.style.getPropertyValue('--hud-accent')).toBe('#ffd23f');
    await waitFor(() => expect(phone.querySelector('.gun')).toHaveAttribute('data-theme', 'dusk'), T);
    expect(within(phone).getByRole('button', { name: 'Fire' })).toHaveTextContent('FIRE');
    await userEvent.click(screen.getByRole('button', { name: 'Tuning (T)' }));
    const panel = screen.getByRole('complementary', { name: 'Tuning' });
    expect(within(panel).getByLabelText('Look (L)')).toHaveValue('dusk/dusk');
    await userEvent.click(within(panel).getByLabelText('Show hitboxes'));
    expect(within(panel).getByLabelText('Show hitboxes')).toBeChecked();
  }, 20_000);

  it('ignores a look in this browser that does not exist', async () => {
    localStorage.setItem('sky-shot:theme', JSON.stringify({ id: 'gone', palette: 'x' }));
    await renderDemo();
    const looks = await screen.findByRole('radiogroup', { name: 'Look' });
    expect(within(looks).getByRole('radio', { name: 'Dusk' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Sky Shot: 5-point calibration', () => {
  it('walks five dots with the phone, applies the fit and saves it; the next room starts with it', async () => {
    await renderDemo(MAX, true);
    await userEvent.click(await screen.findByRole('button', { name: 'Play' }));
    const phone = await screen.findByTestId('phone');
    await waitFor(() => expect(within(phone).getByText(/^Live/)).toBeInTheDocument(), T);
    await userEvent.click(await screen.findByRole('button', { name: 'Calibrate (5 dots)' }, T));
    expect(await screen.findByRole('dialog', { name: 'Calibrating' }, T)).toHaveTextContent('Dot 1 of 5');
    const dots: [number, number][] = [
      [0.5, 0.5],
      [0.15, 0.2],
      [0.85, 0.2],
      [0.85, 0.8],
      [0.15, 0.8],
    ];
    for (const [k, [x, y]] of dots.entries()) {
      // Point at the dot (gain 1.5 widths/rad), hold a moment, tap.
      act(() => motion.set({ roll: 0, pitch: -(y - 0.5) / (1.5 * 1.6), yaw: -(x - 0.5) / 1.5 }));
      await new Promise((r) => setTimeout(r, 350));
      await userEvent.pointer({ keys: '[MouseLeft>]', target: await within(phone).findByRole('button', { name: `On the dot (${k + 1} of 5)` }, T) });
      await userEvent.pointer({ keys: '[/MouseLeft]' });
    }
    expect(await screen.findByText(/^Calibrated: .* Saved as your default\.$/, {}, T)).toBeInTheDocument();
    // The saved default carries to a new room.
    act(() => void (window.location.hash = '#/'));
    await userEvent.click(await screen.findByRole('button', { name: 'Range' }, T));
    await userEvent.click(await screen.findByRole('button', { name: 'Start the Range' }, T));
    await userEvent.click(screen.getByRole('button', { name: 'Tuning (T)' }));
    const panel = screen.getByRole('complementary', { name: 'Tuning' });
    await waitFor(() => expect(within(panel).getByRole('slider', { name: /^Turn gain/ })).not.toHaveValue('1.6'), T);
  }, 30_000);
});

describe('Sky Shot: telemetry', () => {
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
