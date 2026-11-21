/**
 * The phone: the pointer. Asks for motion, joins the room as device `gun`, and streams raw motion
 * (attitude as a quaternion, rotation rate, acceleration) about 60 times a second, always with the
 * latest 8 samples so a lost packet loses nothing. The server maps it to a crosshair. Most of the
 * screen is the trigger (tap mode); in flick mode a jerk of the wrist fires.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi, useGameRoom } from '@stacks/web';
import { native, type MotionSample } from '@stacks/native';
import { fromEuler } from '../../game/aim';
import { DEVICE, MAX_SAMPLES_PER_INPUT, sig4, type CalibrationView, type GunInput, type MenuEvent, type ServerEvent, type Snapshot, type Vec3, type WireSample } from '../../game/protocol';
import { DEFAULT_THEME, isThemeChoice, type ThemeChoice } from '../../game/themes';
import { DEFAULT_TUNING, type Tuning } from '../../game/tuning';
import { gameName, GameMenu, PhoneSettings } from './Menu';
import { lookStyle, nextTheme, themeOf } from './themes';

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
  const [hud, setHud] = useState<{ sl: number; rd: number; mode: Snapshot['m']; ph: string; pz: boolean; cal: CalibrationView | null; ctl: string | null; seats: Snapshot['g'] } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const api = useApi();
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
    else if ('calibrated' in e && (!e.calibrated.seat || mine(e.calibrated.seat))) {
      buzz(() => native.haptics.notification('success'));
      setNote(e.calibrated.poor ? "Done, but the dots didn't line up well: try Re-calibrate." : e.calibrated.stage === 'init' ? 'Got it. Now with the crosshair.' : 'Calibrated.');
    } else if ('calibrationFailed' in e && (!e.calibrationFailed.seat || mine(e.calibrationFailed.seat))) {
      buzz(() => native.haptics.notification('error'));
      setNote(e.calibrationFailed.reason);
    }
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
    stop.ready.catch((e: { code?: string }) => setProblem(e.code === 'forbidden' ? "DashyHQ didn't let Whee use motion." : 'Motion is not available here.'));
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
      if (s) setHud({ sl: s.sl, rd: s.rd, mode: s.m, ph: s.ph, pz: s.pz, cal: s.cal ?? null, ctl: s.ctl ?? null, seats: s.g });
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
  const menu = (m: MenuEvent) => sendEvent({ menu: m });
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(id);
  }, [note]);
  const saveDefault = async () => {
    setSaved(null);
    try {
      await api.put('/tuning', { tuning, source: 'manual' });
      setSaved('Saved as your default.');
    } catch (err) {
      setSaved(`Couldn't save: ${(err as Error).message}`);
    }
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
        <h2>Whee controller</h2>
        <p>Hold your phone like a pointer: top edge at the screen.</p>
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
  const me = you.current;
  const chip = <span className={`chip ${live ? 'ok' : ''}`}>{live ? `Live · ${room.rttMs ?? '-'} ms` : room.status === 'offline' ? `Offline${room.error ? ` (${room.error})` : ''}` : room.status === 'ended' ? 'Game over' : 'Connecting…'}</span>;
  const noteLine = note && (
    <p className="gun-msg" role="status">
      {note}
    </p>
  );
  if (room.status === 'ended')
    return (
      <div className="gun gun-setup" {...dressed}>
        <h2>Thanks for playing</h2>
        <p>The game is over. Start the next one on the screen.</p>
      </div>
    );

  const cal = hud?.cal;
  if (cal && cal.gun === me) {
    // Calibrating this phone: step 1 points blind, step 2 with the crosshair. The whole screen marks "on the dot".
    const step = cal.st === 'init' ? 'Step 1 of 2 · Initialize' : 'Step 2 of 2 · Calibrate';
    return (
      <div className="gun gun-cal" {...dressed}>
        <div className="gun-top">
          {chip}
          <span className="chip">{step}</span>
        </div>
        <div className="cal-dots" role="img" aria-label={`Dot ${cal.i + 1} of ${cal.pts.length}`}>
          {cal.pts.map((_, k) => (
            <i key={k} className={k < cal.i ? 'done' : k === cal.i ? 'now' : ''} />
          ))}
        </div>
        <p className="gun-hint">{cal.st === 'init' ? 'Point the phone at the green dot on the screen and tap.' : 'Put the crosshair on the green dot and tap.'}</p>
        <button type="button" className="trigger" onPointerDown={calibrate} disabled={!live} aria-label={`On the dot (${cal.i + 1} of ${cal.pts.length})`}>
          Tap on the dot
          <small>
            {cal.i + 1} of {cal.pts.length}
          </small>
        </button>
        {noteLine}
        <div className="row">
          <button type="button" className="link" onClick={() => menu({ calRedo: true })}>
            Redo from dot 1
          </button>
          <button type="button" className="link" onClick={() => menu({ calSkip: true })}>
            Skip
          </button>
        </div>
      </div>
    );
  }
  if (cal) {
    const n = (hud?.seats.findIndex((g) => g.id === cal.gun) ?? 0) + 1;
    return (
      <div className="gun gun-setup" {...dressed}>
        <div className="gun-top">{chip}</div>
        <h2>Waiting for Player {n} to calibrate</h2>
        <p>One phone at a time. You're next{cal.wait && cal.wait > 1 ? ' soon' : ''}.</p>
      </div>
    );
  }
  if (hud?.mode === 'training' && hud.ph === 'playing')
    return (
      <div className="gun gun-training">
        <div className="gun-top">{chip}</div>
        <div className="gun-note" role="status">
          <h2>Training</h2>
          <p>Watch the screen and follow the dot. Hold the phone the way you play. No need to tap.</p>
        </div>
      </div>
    );

  const driver = !!me && hud?.ctl === me;
  const inGame = !!hud && (hud.ph === 'playing' || hud.ph === 'roundEnd');
  if (driver && settings)
    return (
      <div className="gun gun-menu" {...dressed}>
        <div className="gun-top">{chip}</div>
        <PhoneSettings tuning={tuning} onTune={(c) => menu({ tune: c })} onSave={() => void saveDefault()} onClose={() => setSettings(false)} saved={saved} />
      </div>
    );
  if (driver && hud && (!inGame || hud.pz))
    // The lobby (before a game, after one) and the pause menu: the controller runs the game from here.
    return (
      <div className="gun gun-menu" {...dressed}>
        <div className="gun-top">
          {chip}
          {inGame && <span className="chip">Paused</span>}
        </div>
        {!inGame && (
          <p className="gun-ready" role="status">
            {gameName(hud.mode)} · {theme.name}. Start it on the screen (Enter).
          </p>
        )}
        {noteLine}
        <GameMenu
          mode={hud.mode}
          look={look}
          playing={inGame}
          onMode={(m) => menu({ mode: m })}
          onLook={(c) => menu({ theme: c })}
          onRecalibrate={() => menu({ recalibrate: true })}
          onSettings={() => setSettings(true)}
          onResume={inGame ? () => menu({ pause: false }) : undefined}
          onExit={() => menu({ finish: true })}
          confirmExit
        />
      </div>
    );
  if (!inGame && hud)
    return (
      <div className="gun gun-setup" {...dressed}>
        <div className="gun-top">{chip}</div>
        <h2>Ready</h2>
        <p>Player 1 picks the game. Start it on the screen.</p>
        {noteLine}
        <button type="button" onClick={() => menu({ recalibrate: true })} disabled={!live}>
          Re-calibrate
        </button>
      </div>
    );
  return (
    <div className={`gun${flash ? ` gun-${flash}` : ''}`} {...dressed}>
      <div className="gun-top">
        {chip}
        {hud && hud.mode === 'rounds' && hud.ph === 'playing' && (
          <span className="chip" aria-label={`Round ${hud.rd}, ${hud.sl} shots left`}>
            R{hud.rd} · {theme.shells[0].repeat(Math.max(0, hud.sl))}
            {theme.shells[1].repeat(Math.max(0, 3 - hud.sl))}
          </span>
        )}
        {driver ? (
          <button type="button" className="pause-btn" onClick={() => menu({ pause: true })} disabled={!live} aria-label="Pause">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18">
              <line x1="6" y1="3" x2="6" y2="15" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </button>
        ) : (
          <button type="button" className="calibrate-btn" onClick={() => menu({ recalibrate: true })} disabled={!live}>
            Re-calibrate
          </button>
        )}
      </div>
      {driver && (
        // Swap the look mid-round, no pause: the game doesn't change.
        <button type="button" className="look-chip" onClick={() => menu({ theme: nextTheme(look) })} disabled={!live} aria-label={`Look: ${theme.name}. Tap for the next look`}>
          Look: {theme.name} ›
        </button>
      )}
      {hud?.pz && <p className="gun-msg">Paused by Player 1.</p>}
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
