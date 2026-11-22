import { StrictMode, useEffect, useRef, useState, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createDemo, DemoApp } from '@stacks/demo';
import { fakeCamera, fakeGameKit, fakeMotion, installFakeNative, screenRays } from '@stacks/native';
import { useApi, useHashRoute, useStacks } from '@stacks/web';
import type { Vec3 } from '../../game/protocol';
import { codeSpots } from '../../game/snap';
import { isThemeChoice, THEME_PALETTES, type ThemeChoice } from '../../game/themes';
import { App, demoOptions } from './demo/setup';
import { Gun } from './Gun';
import { STORAGE_KEY } from './Look';
import './styles.css';

/**
 * The demo is one page: the screen on the left and a pretend iPhone on the right, as the same
 * persona (two seats: `screen` and `gun`). The phone's CoreMotion is `fakeMotion`: arrow keys or
 * drag on the pad aim it, Space or FIRE shoots, and "Flick" injects an acceleration spike. It sways
 * on its own when left alone, so screenshots move.
 */
const motion = fakeMotion({ wobble: true });
// The pretend camera sees the screen straight ahead, 30° wide, with the codes where the screen draws them.
const camera = fakeCamera({
  locate: async ({ codes }) => {
    await new Promise((r) => setTimeout(r, 800));
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const spots = codeSpots(aspect);
    return screenRays(
      { yaw: 0, pitch: 0, widthRad: Math.PI / 6, aspect },
      codes.map((code, i) => ({ code, x: spots[i]?.[0] ?? 0.5, y: spots[i]?.[1] ?? 0.5 })),
      { roll: 0, pitch: Math.PI / 2, yaw: 0 },
    );
  },
});
installFakeNative({ ...motion.handlers, ...camera.handlers, ...fakeGameKit() });
const pose = { roll: 0, pitch: 0, yaw: 0 };
const aim = (change: Partial<typeof pose>) => {
  Object.assign(pose, change);
  pose.yaw = Math.max(-0.6, Math.min(0.6, pose.yaw));
  pose.pitch = Math.max(-0.5, Math.min(0.5, pose.pitch));
  motion.set({ ...pose });
};

/**
 * `#/autoplay/look/<theme>[/<palette>]` (also after `#/autoplay/tuning`): start in that look, for a
 * screenshot per theme. Written to this browser's saved look before the app reads it.
 */
function lookFromHash(hash: string): ThemeChoice | null {
  const seg = hash.replace(/^#\/?/, '').split('/');
  const i = seg.indexOf('look');
  if (seg[0] !== 'autoplay' || i < 0) return null;
  const id = seg[i + 1] ?? '';
  const c = { id, palette: seg[i + 2] ?? (Object.hasOwn(THEME_PALETTES, id) ? THEME_PALETTES[id as keyof typeof THEME_PALETTES][0] : '') };
  return isThemeChoice(c) ? c : null;
}
const startLook = lookFromHash(window.location.hash);
if (startLook)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(startLook));
  } catch {
    // Storage blocked: the demo starts in the saved or default look.
  }

function DemoPhone({ roomId }: { roomId: string }) {
  const flickUntil = useRef(0);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = 0.025;
      if (e.key === 'ArrowLeft') aim({ yaw: pose.yaw + step });
      else if (e.key === 'ArrowRight') aim({ yaw: pose.yaw - step });
      else if (e.key === 'ArrowUp') aim({ pitch: pose.pitch + step });
      else if (e.key === 'ArrowDown') aim({ pitch: pose.pitch - step });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const extraAccel = (): Vec3 | null => (performance.now() < flickUntil.current ? [0, 2.6, 0.4] : null);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, yaw: pose.yaw, pitch: pose.pitch };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) aim({ yaw: d.yaw - (e.clientX - d.x) / 400, pitch: d.pitch - (e.clientY - d.y) / 400 });
  };
  return (
    <aside className="demo-phone" aria-label="Pretend phone">
      <div className="phone-frame">
        <Gun roomId={roomId} extraAccel={extraAccel} keyboard autoEnable />
      </div>
      <div className="pad" onPointerDown={down} onPointerMove={move} onPointerUp={() => (drag.current = null)} role="presentation">
        Drag here (or use the arrow keys) to aim
      </div>
      <button type="button" onClick={() => (flickUntil.current = performance.now() + 40)}>
        Flick
      </button>
      <p className="muted small">Space fires (tap mode). Flick fires in flick mode (Tuning › Trigger).</p>
    </aside>
  );
}

/** `#/autoplay` (`/tuning`, `/training`): start a room, pair the pretend phone and play, for screenshots. */
function Autoplay({ kind }: { kind: string | undefined }) {
  const api = useApi();
  const { status } = useStacks();
  useEffect(() => {
    if (status !== 'signedIn') return;
    let cancelled = false;
    void api.post<{ room: { id: string } }>('/rooms', { name: 'Demo' }).then(({ room }) => {
      const mode = kind === 'tuning' ? 'range' : kind === 'training' ? 'training' : 'rounds';
      if (!cancelled) window.location.hash = `#/play/${room.id}/${mode}/auto${kind === 'tuning' ? '/tuning' : ''}`;
    });
    return () => {
      cancelled = true;
    };
  }, [api, status, kind]);
  return null;
}

function DemoPage() {
  const { segments } = useHashRoute();
  const [wide, setWide] = useState(() => window.matchMedia?.('(min-width: 760px)').matches ?? true);
  useEffect(() => {
    const mq = window.matchMedia?.('(min-width: 760px)');
    const on = () => setWide(mq.matches);
    mq?.addEventListener('change', on);
    return () => mq?.removeEventListener('change', on);
  }, []);
  const playing = segments[0] === 'play' && segments[1];
  return (
    <div className={`demo-split${playing && wide ? ' with-phone' : ''}`}>
      {segments[0] === 'autoplay' && <Autoplay kind={segments[1]} />}
      <div className="demo-screen">
        <App />
      </div>
      {playing && wide && <DemoPhone key={segments[1]} roomId={segments[1]!} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DemoApp demo={createDemo(demoOptions())}>
      <DemoPage />
    </DemoApp>
  </StrictMode>,
);
