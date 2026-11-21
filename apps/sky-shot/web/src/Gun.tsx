/**
 * The phone: a light gun. Asks for motion, joins the room as device `gun`, and streams raw motion
 * (attitude as a quaternion, rotation rate, acceleration) about 60 times a second, always with the
 * latest 8 samples so a lost packet loses nothing. The server maps it to a crosshair. Most of the
 * screen is the trigger (tap mode); in flick mode a jerk of the wrist fires.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useGameRoom } from '@stacks/web';
import { native, type MotionSample } from '@stacks/native';
import { fromEuler } from '../../game/aim';
import { DEVICE, MAX_SAMPLES_PER_INPUT, sig4, type GunInput, type ServerEvent, type Snapshot, type Vec3, type WireSample } from '../../game/protocol';
import { DEFAULT_THEME, isThemeChoice, type ThemeChoice } from '../../game/themes';
import { DEFAULT_TUNING, type Tuning } from '../../game/tuning';
import { lookStyle, themeOf } from './themes';

/** How often the phone sends its latest samples. */
export const SEND_MS = 16;
export const MOTION_HZ = 100;

export interface GunProps {
  roomId: string;
  /** The demo's fake phone adds a jolt here when its Flick button is pressed. */
  extraAccel?: () => Vec3 | null;
  /** The demo's phone: Space fires. */
  keyboard?: boolean;
  /** Skip the "Enable motion" tap when nothing asks for it (the demo). */
  autoEnable?: boolean;
}

/** A CoreMotion-style sample as sent: attitude as a quaternion, four significant digits. */
export function toWire(s: MotionSample, extra: Vec3 | null): WireSample | null {
  if (!s.attitude) return null;
  const q = fromEuler(s.attitude.roll, s.attitude.pitch, s.attitude.yaw);
  const r = s.rotationRate ?? { x: 0, y: 0, z: 0 };
  const a = s.userAcceleration ?? { x: 0, y: 0, z: 0 };
  return {
    t: Math.round(s.t * 10_000) / 10_000,
    q: q.map(sig4) as WireSample['q'],
    r: [sig4(r.x), sig4(r.y), sig4(r.z)],
    a: [sig4(a.x + (extra?.[0] ?? 0)), sig4(a.y + (extra?.[1] ?? 0)), sig4(a.z + (extra?.[2] ?? 0))],
  };
}

const buzz = (fn: () => Promise<unknown>) => void fn().catch(() => undefined);

export function Gun({ roomId, extraAccel, keyboard = false, autoEnable = false }: GunProps) {
  const [enabled, setEnabled] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tuning, setTuning] = useState<Tuning>(DEFAULT_TUNING);
  // The phone wears the screen's look.
  const [look, setLook] = useState<ThemeChoice>(DEFAULT_THEME);
  const [hud, setHud] = useState<{ sl: number; rd: number; mode: string; ph: string; cal: string | null } | null>(null);
  const [flash, setFlash] = useState<'hit' | 'miss' | null>(null);
  const latest = useRef<Snapshot | null>(null);
  const recent = useRef<WireSample[]>([]);
  const clock = useRef<{ t: number; at: number } | null>(null);
  const seq = useRef(0);
  const extra = useRef(extraAccel);
  extra.current = extraAccel;
  const you = useRef<string | null>(null);

  const onEvent = useCallback((e: ServerEvent) => {
    const mine = (seat: string) => seat === you.current;
    if ('tuning' in e) setTuning(e.tuning.tuning);
    else if ('theme' in e && isThemeChoice(e.theme)) setLook(e.theme);
    else if ('hit' in e && mine(e.hit.seat)) {
      buzz(() => native.haptics.notification('success'));
      setFlash('hit');
    } else if ('miss' in e && mine(e.miss.seat)) setFlash('miss');
    else if ('empty' in e && mine(e.empty.seat)) buzz(() => native.haptics.notification('warning'));
    else if ('roundEnd' in e)
      buzz(() =>
        native.haptics.pattern([
          { t: 0, intensity: 1, sharpness: 0.6 },
          { t: 0.12, intensity: 0.7, sharpness: 0.4 },
          { t: 0.24, intensity: 1, sharpness: 0.8, duration: 0.2 },
        ]),
      );
  }, []);

  const room = useGameRoom<Snapshot, GunInput, unknown>(enabled ? roomId : null, {
    device: DEVICE.gun,
    onState: (s) => (latest.current = s),
    onEvent: (e) => onEvent(e as ServerEvent),
  });
  you.current = room.you?.id ?? null;
  const live = room.status === 'live';
  const rtt = useRef(0);
  rtt.current = room.rttMs ?? 0;
  const { sendInput, sendEvent } = room;

  const enable = useCallback(async () => {
    setProblem(null);
    const answer = await native.motion.requestPermission();
    if (answer === 'granted') setEnabled(true);
    else setProblem(answer === 'denied' ? 'Motion access was turned down. In Safari: aA › Website Settings › Motion & Orientation Access, then reload.' : 'This device has no motion sensors.');
  }, []);
  useEffect(() => {
    if (autoEnable && !enabled) void enable();
  }, [autoEnable, enabled, enable]);

  // Motion in, at 100 Hz (Safari ~60 Hz).
  useEffect(() => {
    if (!enabled) return;
    const stop = native.motion.start({ hz: MOTION_HZ, onError: (e) => setProblem(`Motion stopped: ${e.code}`) }, ({ samples }) => {
      const now = performance.now();
      for (const s of samples) {
        const w = toWire(s, extra.current?.() ?? null);
        if (!w) continue;
        recent.current.push(w);
        clock.current = { t: w.t, at: now };
      }
      if (recent.current.length > MAX_SAMPLES_PER_INPUT) recent.current.splice(0, recent.current.length - MAX_SAMPLES_PER_INPUT);
    });
    stop.ready.catch((e: { code?: string }) => setProblem(e.code === 'forbidden' ? "DashyHQ didn't let Sky Shot use motion." : 'Motion is not available here.'));
    return () => stop();
  }, [enabled]);

  // ...and out, ~60 times a second, the latest 8 samples each time.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      const c = clock.current;
      if (!c || !recent.current.length) return;
      sendInput({ seq: ++seq.current, t: c.t, rtt: rtt.current, samples: recent.current.slice(-MAX_SAMPLES_PER_INPUT) });
    }, SEND_MS);
    return () => clearInterval(id);
  }, [live, sendInput]);

  // Hold-it-like-a-gun mode: full screen, awake, locked.
  useEffect(() => {
    if (!live) return;
    buzz(() => native.screen.immersive(true));
    buzz(() => native.screen.keepAwake(true));
    buzz(() => native.screen.lockOrientation(tuning.orientation));
    return () => {
      buzz(() => native.screen.immersive(false));
      buzz(() => native.screen.keepAwake(false));
      buzz(() => native.screen.lockOrientation('any'));
    };
  }, [live, tuning.orientation]);

  useEffect(() => {
    const id = setInterval(() => {
      const s = latest.current;
      if (s) setHud({ sl: s.sl, rd: s.rd, mode: s.m, ph: s.ph, cal: s.cal ? `${s.cal.i + 1} of ${s.cal.pts.length}` : null });
    }, 150);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 250);
    return () => clearTimeout(id);
  }, [flash]);

  /** Now, on the motion clock (the server maps it to its own). */
  const motionNow = () => {
    const c = clock.current;
    return c ? c.t + (performance.now() - c.at) / 1000 : 0;
  };
  const fire = useCallback(() => {
    if (!live || tuning.trigger !== 'tap') return;
    sendEvent({ shot: { t: motionNow() } });
    buzz(() => native.haptics.impact('rigid'));
  }, [live, tuning.trigger, sendEvent]);
  const calibrate = () => {
    sendEvent({ calibrate: { t: motionNow() } });
    buzz(() => native.haptics.impact('light'));
  };
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        fire();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keyboard, fire]);

  const { theme } = themeOf(look);
  const dressed = { 'data-theme': look.id, 'data-palette': look.palette, style: lookStyle(look) };
  if (!enabled)
    return (
      <div className="gun gun-setup" {...dressed}>
        <h2>Sky Shot gun</h2>
        <p>Hold your phone like a light gun: top edge at the screen.</p>
        <button type="button" className="primary big" onClick={() => void enable()}>
          Enable motion
        </button>
        {problem && (
          <p className="error" role="alert">
            {problem}
          </p>
        )}
      </div>
    );

  const flick = tuning.trigger === 'flick';
  if (hud?.cal)
    // 5-point calibration: the whole screen marks "I'm on the dot" (in flick mode too).
    return (
      <div className="gun" {...dressed}>
        <div className="gun-top">
          <span className={`chip ${live ? 'ok' : ''}`}>{live ? `Live · ${room.rttMs ?? '-'} ms` : 'Connecting…'}</span>
        </div>
        <button type="button" className="trigger" onPointerDown={calibrate} disabled={!live} aria-label={`On the dot (${hud.cal})`}>
          Tap when on the dot
          <small>{hud.cal}</small>
        </button>
      </div>
    );
  return (
    <div className={`gun${flash ? ` gun-${flash}` : ''}`} {...dressed}>
      <div className="gun-top">
        <span className={`chip ${live ? 'ok' : ''}`}>{live ? `Live · ${room.rttMs ?? '-'} ms` : room.status === 'offline' ? `Offline${room.error ? ` (${room.error})` : ''}` : 'Connecting…'}</span>
        {hud && hud.mode === 'rounds' && hud.ph === 'playing' && (
          <span className="chip" aria-label={`Round ${hud.rd}, ${hud.sl} shots left`}>
            R{hud.rd} · {theme.shells[0].repeat(Math.max(0, hud.sl))}
            {theme.shells[1].repeat(Math.max(0, 3 - hud.sl))}
          </span>
        )}
        <button type="button" className="calibrate-btn" onClick={calibrate} disabled={!live}>
          Calibrate
        </button>
      </div>
      <button type="button" className="trigger" onPointerDown={flick ? undefined : fire} disabled={!live} aria-label={flick ? 'Flick to fire' : 'Fire'}>
        {flick ? theme.verb.flick : theme.verb.tap}
      </button>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
