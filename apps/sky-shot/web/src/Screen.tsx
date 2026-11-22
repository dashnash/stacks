/**
 * The big screen (a desktop browser): joins the room as device `screen`, shows the QR code to pair a
 * phone, draws the game from the server's state, and owns the tuning panel. "Use mouse instead"
 * joins a second seat (device `mouse`) from the same page.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ErrorNote, createStateBuffer, useApi, useAsync, useGameRoom } from '@stacks/web';
import { DEVICE, type ConfigStats, type GameMode, type GameSummary, type GunInput, type RangeKind, type ScreenEvent, type ServerEvent, type Snapshot, type SnapView } from '../../game/protocol';
import { CODE_MARGIN, CODE_SIZE } from '../../game/snap';
import { configId, DEFAULT_TUNING, type Tuning } from '../../game/tuning';
import { drawFrame, EFFECT_MS, HIT_COPY_MS, Layers, type Effect, type HitCopy } from './draw';
import { useLook } from './Look';
import { gameName, GameMenu } from './Menu';
import { isThemeChoice, type ThemeChoice } from '../../game/themes';
import { lookStyle, nextTheme, themeOf } from './themes';
import { encodeQr, qrPath } from './qr';
import { AB_MS, AbBanner, AbChoice, TrainingDone, TrainingHud, TrainingIntro, TrainingResult, type Pick } from './Training';
import type { Prompt } from '../../game/protocol';
import { GRAPH_MS, TuningPanel, type MotionPoint } from './Tuning';
import type { FitReport } from '../../game/fit';

interface RoomInfo {
  id: string;
  code: string;
  status: 'starting' | 'open' | 'ended';
  createdBy: { id: string; name: string };
}

/** The screen draws this far behind the server (createStateBuffer's default). */
const DELAY_MS = 100;
const ACK_MS = 400;
/** Crosshair positions kept per gun for themes that draw a trail. */
const TRAIL = 12;

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Training's flow on the screen after the fit: the result, the two blind rounds, the pick, done. */
type Which = 'base' | 'fitted';
type Flow =
  | { k: 'none' }
  | { k: 'result' }
  | { k: 'ab'; order: [Which, Which]; step: 0 | 1; until: number }
  | { k: 'pick'; order: [Which, Which] }
  | { k: 'done'; message: string };

/** The link the phone opens: the controller page for this room. */
export const gunLink = (roomId: string, base = `${window.location.origin}${window.location.pathname}`) => `${base}#/gun/${encodeURIComponent(roomId)}`;

export function QrCode({ text, label, quiet = 4 }: { text: string; label: string; quiet?: number }) {
  const qr = useMemo(() => encodeQr(text), [text]);
  return (
    <svg className="qr" viewBox={`${-quiet} ${-quiet} ${qr.size + quiet * 2} ${qr.size + quiet * 2}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect x={-quiet} y={-quiet} width={qr.size + quiet * 2} height={qr.size + quiet * 2} fill="#fff" />
      <path d={qrPath(qr.modules)} fill="#000" />
    </svg>
  );
}

/**
 * Camera calibration (#167): the four codes the phones look for, at the window's corners (where
 * `codeSpots` says), on a light ground, and each phone's step. On the page's body, over everything
 * (the header's account badge and the footer sit in those corners), so the camera sees every code.
 */
function SnapCodes({ view, snapping, playerOf, look }: { view: SnapView; snapping: boolean; playerOf: (seat: string) => number; look: ThemeChoice }) {
  const size = `${CODE_SIZE * 100}vh`;
  const m = `${CODE_MARGIN * 100}vh`;
  const at = [
    { left: m, top: m },
    { right: m, top: m },
    { right: m, bottom: m },
    { left: m, bottom: m },
  ];
  return createPortal(
    <div className={`snap-layer${snapping ? ' on' : ''}`} role="dialog" aria-label="Calibrating with the camera" data-theme={look.id} data-palette={look.palette} style={lookStyle(look)}>
      {snapping &&
        view.codes.map((c, k) => (
          <div key={c} className="snap-code" style={{ ...at[k], width: size, height: size }}>
            <QrCode text={c} label={`Calibration code ${k + 1} of 4`} quiet={1} />
          </div>
        ))}
      <div className="overlay snap-card">
        <h2>{snapping ? 'Hold your phone up and snap this screen' : 'Now aim at the dot in your own grip, and tap'}</h2>
        <p className="muted">{snapping ? "From where you'll play: all four corners in view for two seconds." : 'This sets where your phone points.'}</p>
        <ul className="snap-list">
          {view.guns.map((g) => (
            <li key={g.gun}>
              Player {playerOf(g.gun)} · {g.st === 'snap' ? 'Snap the screen' : 'Centre tap'}
            </li>
          ))}
        </ul>
        <p className="muted small">Use dots or skip on the phone.</p>
      </div>
    </div>,
    document.body,
  );
}

function Results({ over, best, onAgain, onDone, saving, remote }: { over: GameSummary; best: { rank: number | null } | null; onAgain: () => void; onDone: () => void; saving: boolean; remote: boolean }) {
  return (
    <div className="overlay results" role="dialog" aria-label="Results">
      <h2>{over.mode === 'rounds' ? 'Game over' : 'Range session'}</h2>
      <p className="big-score">{over.score.toLocaleString()}</p>
      <dl className="summary">
        <dt>Rounds</dt>
        <dd>{over.rounds}</dd>
        <dt>Accuracy</dt>
        <dd>{Math.round(over.accuracy * 100)} %</dd>
        <dt>Hits</dt>
        <dd>
          {over.hits}/{over.shots}
        </dd>
        {best?.rank ? (
          <>
            <dt>Leaderboard</dt>
            <dd>#{best.rank}</dd>
          </>
        ) : null}
      </dl>
      {remote && <p className="muted on-phone">Start the next game on your phone.</p>}
      <div className="row">
        {!remote && (
          <button type="button" className="primary" onClick={onAgain}>
            Play again
          </button>
        )}
        <button type="button" onClick={onDone} disabled={saving}>
          {saving ? 'Saving…' : '← Exit to menu'}
        </button>
      </div>
    </div>
  );
}

export function Screen({ roomId, mode: startMode, autostart = false, openPanel = false }: { roomId: string; mode: GameMode; autostart?: boolean; openPanel?: boolean }) {
  const api = useApi();
  const info = useAsync(() => api.get<{ room: RoomInfo }>(`/rooms/${encodeURIComponent(roomId)}`), [roomId]);
  const buffer = useMemo(() => createStateBuffer<Snapshot>({ delayMs: DELAY_MS }), []);
  const latest = useRef<Snapshot | null>(null);
  const offset = useRef<number | null>(null);
  const effects = useRef<Effect[]>([]);
  const effectId = useRef(0);
  const hits = useRef<HitCopy[]>([]);
  const trails = useRef(new Map<string, [number, number][]>());
  const layers = useMemo(() => new Layers(), []);
  const { look, setLook } = useLook();
  const lookNow = useRef(look);
  lookNow.current = look;
  const { palette, theme: lookTheme } = themeOf(look);
  /** The look this screen last told the room, and whether the room has echoed it (so the join-time default can't win). */
  const sentLook = useRef<ThemeChoice | null>(null);
  const lookSynced = useRef(false);
  const [exiting, setExiting] = useState(false);
  /** Esc in a game: "Exit to menu?" (the screen only exits; the controller runs the game). */
  const [confirmExit, setConfirmExit] = useState(false);
  /** The controller answered a prompt (wired below, once the training handlers exist). */
  const onChosen = useRef<(prompt: string, option: string) => void>(() => undefined);
  const [hitboxes, setHitboxes] = useState(false);
  const motion = useRef<MotionPoint[]>([]);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [tuning, setTuning] = useState<{ tuning: Tuning; id: string }>({ tuning: DEFAULT_TUNING, id: configId(DEFAULT_TUNING) });
  const [stats, setStats] = useState<Record<string, ConfigStats>>({});
  const [lastShot, setLastShot] = useState<{ gun: number; screen: number; pix: number; rw: number } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [over, setOver] = useState<GameSummary | null>(null);
  const [panel, setPanel] = useState(openPanel);
  const [overlay, setOverlay] = useState(false);
  const [useMouse, setUseMouse] = useState(false);
  const [range, setRange] = useState<{ kind: RangeKind; speed: number }>({ kind: 'static', speed: 1 });
  const [saved, setSaved] = useState<{ rank: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout>>();
  const [report, setReport] = useState<FitReport | null>(null);
  const [trainError, setTrainError] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow>({ k: 'none' });
  const [tuneSaving, setTuneSaving] = useState(false);
  const [tuneError, setTuneError] = useState<string | null>(null);
  const [, setClock] = useState(0);
  /** Hits and shots in each A/B round. */
  const abScore = useRef<[{ hits: number; shots: number }, { hits: number; shots: number }]>([
    { hits: 0, shots: 0 },
    { hits: 0, shots: 0 },
  ]);
  const abStep = useRef<0 | 1 | null>(null);
  const tuningNow = useRef<Tuning>(DEFAULT_TUNING);
  // Your saved default goes to the room once it is live.
  const mine = useAsync(() => api.get<{ tuning: Tuning | null }>('/tuning'), []);
  const saveDefault = useCallback(
    async (t: Tuning, source: 'calibration' | 'training' | 'manual') => {
      setTuneSaving(true);
      setTuneError(null);
      try {
        await api.put('/tuning', { tuning: t, source });
        return true;
      } catch (err) {
        setTuneError((err as Error).message);
        return false;
      } finally {
        setTuneSaving(false);
      }
    },
    [api],
  );

  const show = useCallback((text: string, ms = 1800) => {
    setBanner(text);
    clearTimeout(bannerTimer.current);
    bannerTimer.current = setTimeout(() => setBanner(null), ms);
  }, []);
  useEffect(() => () => clearTimeout(bannerTimer.current), []);

  const colorOf = (seat: string) => latest.current?.g.find((g) => g.id === seat)?.c ?? 0;
  const onEvent = useCallback(
    (e: ServerEvent) => {
      const now = performance.now();
      if (('hit' in e || 'miss' in e) && abStep.current !== null) {
        const s = abScore.current[abStep.current];
        s.shots++;
        if ('hit' in e) s.hits++;
      }
      if ('hit' in e) {
        // The target as the screen is drawing it now: themes whose hit targets don't fall keep this copy.
        const shown = buffer.sample()?.tg.find((t) => t.id === e.hit.target);
        effects.current.push({ kind: 'hit', id: ++effectId.current, x: e.hit.x, y: e.hit.y, c: colorOf(e.hit.seat), at: now, pts: e.hit.pts, r: shown?.r });
        if (shown) hits.current.push({ id: shown.id, k: shown.k, x: shown.x, y: shown.y, r: shown.r, h: shown.h, at: now });
        hits.current = hits.current.filter((x) => now - x.at < HIT_COPY_MS);
        setLastShot({ ...e.hit.lat, rw: e.hit.rw });
      } else if ('miss' in e) {
        effects.current.push({ kind: 'miss', id: ++effectId.current, x: e.miss.x, y: e.miss.y, c: colorOf(e.miss.seat), at: now });
        setLastShot({ ...e.miss.lat, rw: e.miss.rw });
      } else if ('tuning' in e) {
        tuningNow.current = e.tuning.tuning;
        setTuning(e.tuning);
      } else if ('calibrated' in e) {
        const c = e.calibrated;
        const off = `${Math.round(c.error * 100)} %`;
        // The first phone's fit is the room's tuning: save it as your default once step 2 is done.
        const first = !c.seat || c.seat === latest.current?.ctl;
        if (c.stage === 'init') show('Step 1 done. Now with the crosshair.', 2000);
        else if (c.stage === 'snap' && c.poor) show(`Calibrated, but the snap was a bit off (by ${off}). Re-calibrate?`, 4000);
        else if (c.poor) show(`Calibrated, but the dots didn't line up (off by ${off}). Re-calibrate?`, 4000);
        else if (first) {
          show(`Calibrated: ${c.gain.toFixed(2)} widths/rad, off by ${off}. Saved as your default.`, 3500);
          void saveDefault(tuningNow.current, 'calibration');
        } else show(`Calibrated, off by ${off}.`, 2500);
      } else if ('calibrationFailed' in e) show(e.calibrationFailed.reason, 3500);
      else if ('theme' in e && isThemeChoice(e.theme)) {
        // The controller changed the look: wear it (and keep it as yours). Until the room has our own
        // look back, what it says is its default, not a choice.
        const sent = sentLook.current;
        const same = (a: ThemeChoice | null, b: ThemeChoice) => !!a && a.id === b.id && a.palette === b.palette;
        if (!lookSynced.current) lookSynced.current = same(sent, e.theme);
        else if (!same(lookNow.current, e.theme)) setLook(e.theme);
      }
      else if ('stats' in e) setStats(e.stats);
      else if ('roundStart' in e) show(`Round ${e.roundStart.round} · hit ${e.roundStart.quota} of 10`);
      else if ('roundEnd' in e) show(e.roundEnd.passed ? `Round ${e.roundEnd.round} clear! +${e.roundEnd.bonus} accuracy bonus` : `Round ${e.roundEnd.round}: ${e.roundEnd.hits} of ${e.roundEnd.quota}`, 2400);
      else if ('gameOver' in e) setOver(e.gameOver);
      else if ('empty' in e) show('Out of shots', 800);
      else if ('trained' in e) {
        setReport(e.trained);
        setTrainError(null);
        setFlow({ k: 'result' });
      } else if ('trainFailed' in e) setTrainError(e.trainFailed.reason);
      else if ('chosen' in e) onChosen.current(e.chosen.prompt, e.chosen.option);
      effects.current = effects.current.filter((x) => now - x.at < EFFECT_MS);
    },
    [show, saveDefault, buffer, setLook],
  );

  // Events go both ways on one channel: the screen sends ScreenEvents and receives ServerEvents.
  const room = useGameRoom<Snapshot, unknown, ScreenEvent | ServerEvent>(roomId, {
    device: DEVICE.screen,
    onState: (s, meta) => {
      buffer.push(s, meta);
      latest.current = s;
      const guess = performance.now() - meta.serverTime;
      offset.current = offset.current === null ? guess : Math.min(offset.current, guess);
      if (s.mo) {
        motion.current.push({ at: meta.serverTime, ...s.mo });
        while (motion.current.length && motion.current[0]!.at < meta.serverTime - GRAPH_MS) motion.current.shift();
      }
    },
    onEvent: (e) => onEvent(e as ServerEvent),
  });
  const mouseRoom = useGameRoom<Snapshot, GunInput, unknown>(useMouse ? roomId : null, { device: DEVICE.mouse });
  const { sendEvent, status } = room;
  const live = status === 'live';
  const rtt = useRef(0);
  rtt.current = room.rttMs ?? 0;

  // Once live: tell the server the screen's shape and the mode (once: a reconnect keeps the room's);
  // keep telling it what we draw: targets ~100 ms back, crosshairs from the newest state.
  const modeSent = useRef(false);
  useEffect(() => {
    if (!live) return;
    const view = () => sendEvent({ view: { aspect: Math.max(0.5, Math.min(3, window.innerWidth / Math.max(1, window.innerHeight))) } });
    view();
    if (!modeSent.current) {
      modeSent.current = true;
      sendEvent({ mode: startMode });
    }
    window.addEventListener('resize', view);
    // Targets are drawn ~100 ms back (interpolated), crosshairs from the newest state.
    const ack = setInterval(() => {
      if (offset.current === null) return;
      const newest = performance.now() - offset.current;
      sendEvent({ ack: { shown: newest - DELAY_MS, rtt: rtt.current, aim: newest } });
    }, ACK_MS);
    return () => {
      window.removeEventListener('resize', view);
      clearInterval(ack);
    };
  }, [live, sendEvent, startMode]);

  // The room draws nothing itself, but the phones follow the screen's look and shots record it.
  useEffect(() => {
    if (!live) return;
    sentLook.current = look;
    sendEvent({ theme: look });
  }, [live, look, sendEvent]);
  // A theme with its own fonts: draw again once they have loaded.
  useEffect(() => {
    const fonts = themeOf(look).theme.fonts;
    if (!fonts.length || !document.fonts) return;
    let on = true;
    void Promise.all(fonts.map((f) => document.fonts.load(f))).then(
      () => on && layers.clear(),
      () => undefined,
    );
    return () => {
      on = false;
    };
  }, [look, layers]);

  // The HUD and overlays at 10 Hz; the canvas every frame.
  useEffect(() => {
    const id = setInterval(() => setSnap(latest.current), 100);
    return () => clearInterval(id);
  }, []);
  // Your saved default, once per room.
  const sentMine = useRef(false);
  useEffect(() => {
    if (live && mine.data && !sentMine.current) {
      sentMine.current = true;
      if (mine.data.tuning) sendEvent({ tune: mine.data.tuning });
    }
  }, [live, mine.data, sendEvent]);
  const training = snap?.m === 'training';
  const pointCal = snap?.cal;
  // Camera calibrations: the codes stay up while any phone is snapping; the centre dot while any taps.
  const snaps = snap?.sn;
  const snapping = !!snaps?.guns.some((g) => g.st === 'snap');
  const phone = !!snap?.g.some((g) => !g.m);
  const lobby = !!snap && snap.g.length > 0 && snap.ph === 'ready' && !training && !pointCal;
  const inGame = !!snap && (snap.ph === 'playing' || snap.ph === 'roundEnd');
  const paused = inGame && !!snap?.pz;
  const playerOf = (seat: string) => (snap?.g.findIndex((g) => g.id === seat) ?? 0) + 1;
  const hitboxScale = tuning.tuning.hitboxScale;
  useEffect(() => {
    let frame = 0;
    const still = reducedMotion();
    const draw = () => {
      const el = canvas.current;
      const ctx = el?.getContext?.('2d');
      if (el && ctx) {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (el.width !== w * devicePixelRatio || el.height !== h * devicePixelRatio) {
          el.width = w * devicePixelRatio;
          el.height = h * devicePixelRatio;
        }
        ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        const cal = latest.current?.cal;
        const centreTap = !cal && !!latest.current?.sn?.guns.some((g) => g.st === 'tap');
        const guns = latest.current?.g;
        if (!still)
          for (const g of guns ?? []) {
            const t = trails.current.get(g.id) ?? [];
            t.push([g.x, g.y]);
            if (t.length > TRAIL) t.shift();
            trails.current.set(g.id, t);
          }
        drawFrame(
          ctx,
          w,
          h,
          buffer.sample(),
          effects.current,
          { now: performance.now(), theme: lookNow.current, overlay, calibrate: centreTap, guns, cal, hits: hits.current, hitboxes: hitboxes ? hitboxScale : undefined, reducedMotion: still, training: latest.current?.tr, trails: trails.current, dpr: devicePixelRatio },
          layers,
        );
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [buffer, overlay, hitboxes, hitboxScale, layers]);

  // The panel pauses Rounds (not Range: tune while you shoot); closing it resumes only a pause it made.
  const panelPaused = useRef(false);
  useEffect(() => {
    if (!live) return;
    const s = latest.current;
    if (panel && s?.m === 'rounds' && !s.pz) {
      panelPaused.current = true;
      sendEvent({ pause: true });
    } else if (!panel && panelPaused.current) {
      panelPaused.current = false;
      sendEvent({ pause: false });
    }
  }, [panel, live, sendEvent]);
  /** Exit to the menu: end the room (it's saved), then back to the title. */
  const exit = useCallback(() => {
    if (status === 'live') {
      setExiting(true);
      sendEvent({ finish: true });
    } else window.location.hash = '#/';
  }, [status, sendEvent]);
  const keys = useRef({ exit, inGame, lobby, phone, confirm: () => undefined as void, start: () => undefined as void });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if ((e.key === 't' || e.key === 'T') && abStep.current === null) setPanel((p) => !p);
      if (e.key === 'l' || e.key === 'L') setLook(nextTheme(lookNow.current));
      const k = keys.current;
      // Esc: exit to the menu (in a game, asked first; a second Esc confirms). With only a mouse, Enter starts from the lobby.
      if (e.key === 'Escape') {
        if (k.inGame) k.confirm();
        else k.exit();
      }
      if (e.key === 'Enter' && k.lobby && !k.phone && !(e.target instanceof HTMLButtonElement)) k.start();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setLook]);

  const start = useCallback(() => {
    setOver(null);
    sendEvent({ start: true });
  }, [sendEvent]);
  keys.current = { exit, inGame, lobby, phone, start, confirm: () => (confirmExit ? exit() : setConfirmExit(true)) };
  useEffect(() => {
    if (!inGame) setConfirmExit(false);
  }, [inGame]);
  // A game started (from the controller): the last results go.
  useEffect(() => {
    if (snap?.ph === 'playing') setOver(null);
  }, [snap?.ph]);
  // Demo autoplay: start once a gun has joined.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autostart && live && !autoStarted.current && snap && snap.g.length && snap.ph === 'ready') {
      autoStarted.current = true;
      // Straight in, for screenshots: no calibration.
      sendEvent({ calibrate: 'skip' });
      start();
    }
  }, [autostart, live, snap, start, sendEvent]);

  // When the room is over (Done, or idle / time): save it once, then show where you placed.
  const roomOver = status === 'ended';
  useEffect(() => {
    if (!roomOver || saved || saving) return;
    setSaving(true);
    void (async () => {
      try {
        await api.post(`/sessions/${encodeURIComponent(roomId)}/save`, {});
        const board = await api.get<{ entries: { score: number }[]; best: { score: number } | null }>('/leaderboard');
        const rank = board.best ? board.entries.findIndex((e) => e.score <= board.best!.score) + 1 || null : null;
        setSaved({ rank });
      } catch (err) {
        setSaveError(err as Error);
        setSaved({ rank: null });
      } finally {
        setSaving(false);
      }
    })();
  }, [roomOver, saved, saving, api, roomId]);

  // Exited (here, or from the phone's menu): once it's saved, back to the title.
  useEffect(() => {
    if (roomOver && saved && (exiting || room.over?.reason === 'finished')) window.location.hash = '#/';
  }, [roomOver, saved, exiting, room.over]);

  // Mouse fallback: the pointer is a gun.
  const mouseSeq = useRef(0);
  const point = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!useMouse) return;
    const box = e.currentTarget.getBoundingClientRect();
    mouseRoom.sendInput({ seq: ++mouseSeq.current, t: performance.now() / 1000, rtt: mouseRoom.rttMs ?? 0, p: [(e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height] });
  };
  const click = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!useMouse || e.button !== 0) return;
    point(e);
    mouseRoom.sendEvent({ shot: { t: performance.now() / 1000 } });
  };

  const tune = (change: Partial<Tuning>) => sendEvent({ tune: change });

  // --- Training: after the fit ---
  const trainAgain = () => {
    setReport(null);
    setFlow({ k: 'none' });
    abStep.current = null;
    sendEvent({ mode: 'training' });
    sendEvent({ start: true });
  };
  const applyFit = (message = 'Using the fit') => {
    if (!report) return;
    sendEvent({ tune: report.fitted });
    setFlow({ k: 'done', message: `${message}. Saved as your default.` });
    void saveDefault(report.fitted, 'training');
  };
  const keepMine = (message = 'Kept yours') => {
    if (report) sendEvent({ tune: report.base });
    setFlow({ k: 'done', message: `${message}. Nothing changed.` });
  };
  /** One blind round: that config, on the Range with sweeping targets. */
  const abRound = (which: Which) => {
    if (!report) return;
    sendEvent({ tune: which === 'base' ? report.base : report.fitted });
    sendEvent({ mode: 'range' });
    sendEvent({ range: { kind: 'sweep', speed: 1 } });
    sendEvent({ start: true });
  };
  const startAb = () => {
    const order: [Which, Which] = Math.random() < 0.5 ? ['base', 'fitted'] : ['fitted', 'base'];
    abScore.current = [
      { hits: 0, shots: 0 },
      { hits: 0, shots: 0 },
    ];
    abStep.current = 0;
    setPanel(false);
    setFlow({ k: 'ab', order, step: 0, until: Date.now() + AB_MS });
    abRound(order[0]);
  };
  useEffect(() => {
    if (flow.k !== 'ab') return;
    const id = setInterval(() => {
      setClock((c) => c + 1);
      if (Date.now() < flow.until) return;
      if (flow.step === 0) {
        abStep.current = 1;
        setFlow({ ...flow, step: 1, until: Date.now() + AB_MS });
        abRound(flow.order[1]);
      } else {
        abStep.current = null;
        setFlow({ k: 'pick', order: flow.order });
      }
    }, 250);
    return () => clearInterval(id);
  }, [flow]);
  const pick = (p: Pick) => {
    if (flow.k !== 'pick') return;
    const fitWas = flow.order[0] === 'fitted' ? 'A' : 'B';
    if (p === 'same') keepMine(`Can't tell: kept yours (the fit was ${fitWas})`);
    else if ((p === 'A' ? flow.order[0] : flow.order[1]) === 'fitted') applyFit(`You picked the fit (${fitWas})`);
    else keepMine(`You picked yours (the fit was ${fitWas})`);
  };
  // With a phone paired, the training choices are put to it; its answer comes back as `chosen`.
  const prompt: Prompt | null = !phone
    ? null
    : flow.k === 'result' && report
      ? {
          id: 'fit',
          title: 'Your fitted aim',
          text: 'The screen shows yours next to the fit.',
          options: [
            { id: 'compare', label: 'Compare blind (A/B)', primary: true },
            { id: 'use', label: 'Use the fit' },
            { id: 'keep', label: 'Keep mine' },
            { id: 'again', label: 'Train again' },
          ],
        }
      : flow.k === 'pick'
        ? {
            id: 'ab',
            title: 'Which felt better?',
            text: 'Go by feel.',
            options: [
              { id: 'A', label: 'A', primary: true },
              { id: 'B', label: 'B', primary: true },
              { id: 'same', label: "Can't tell" },
            ],
          }
        : flow.k === 'done'
          ? {
              id: 'done',
              title: flow.message.slice(0, 80),
              options: [
                { id: 'play', label: 'Play Rounds', primary: true },
                { id: 'again', label: 'Train again' },
                { id: 'exit', label: 'Exit to menu' },
              ],
            }
          : null;
  const promptKey = prompt ? JSON.stringify(prompt) : '';
  useEffect(() => {
    if (!live) return;
    sendEvent({ prompt: promptKey ? (JSON.parse(promptKey) as Prompt) : null });
  }, [live, promptKey, sendEvent]);
  onChosen.current = (id, option) => {
    if (id === 'fit') {
      if (option === 'compare') startAb();
      else if (option === 'use') applyFit();
      else if (option === 'keep') keepMine();
      else if (option === 'again') trainAgain();
    } else if (id === 'ab' && (option === 'A' || option === 'B' || option === 'same')) pick(option);
    else if (id === 'done') {
      if (option === 'play') {
        setFlow({ k: 'none' });
        sendEvent({ mode: 'rounds' });
      } else if (option === 'again') trainAgain();
      else if (option === 'exit') exit();
    }
  };

  const changeRange = (change: { kind?: RangeKind; speed?: number }) => {
    setRange((r) => ({ ...r, ...change }));
    sendEvent({ range: change });
  };

  const code = info.data?.room.code;
  const guns = snap?.g.length ?? 0;
  const link = gunLink(roomId);

  return (
    <div className={`screen${panel ? ' with-panel' : ''}`} data-theme={look.id} data-palette={look.palette} style={lookStyle(look)}>
      <canvas
        ref={canvas}
        className="sky"
        onPointerMove={point}
        onPointerDown={click}
        onContextMenu={(e) => {
          // Mouse players: right-click pauses (the menu comes in).
          if (!useMouse || !inGame) return;
          e.preventDefault();
          sendEvent({ pause: !paused });
        }}
        aria-label="Whee play area"
      />

      {snap && (
        <div className="hud" aria-live="off">
          <span className="score">{snap.sc.toLocaleString()}</span>
          {snap.m === 'rounds' ? (
            <>
              <span className="round">Round {snap.rd || 1}</span>
              <span className="shells" aria-label={`${snap.sl} shots left`}>
                {Array.from({ length: 3 }, (_, i) => (
                  <i key={i} className={i < snap.sl ? 'shell' : 'shell spent'} />
                ))}
              </span>
              <span>
                Hits {snap.h}/{snap.q || '-'}
              </span>
            </>
          ) : snap.m === 'training' ? (
            <span>Training</span>
          ) : (
            <span>Range · {range.kind}</span>
          )}
          {snap.g.map((g) => (
            <span key={g.id} className="gun-chip" style={{ color: palette.seats[g.c % palette.seats.length] }}>
              ● {g.m ? 'mouse' : 'gun'}
            </span>
          ))}
          <button type="button" className="link hud-tune" onClick={() => setPanel((p) => !p)}>
            Tuning (T)
          </button>
        </div>
      )}

      {training && snap?.tr && ['gap', 'jump', 'track', 'hold', 'fit'].includes(snap.tr.k) && <TrainingHud tr={snap.tr} />}
      {flow.k === 'ab' && <AbBanner label={flow.step === 0 ? 'A' : 'B'} msLeft={flow.until - Date.now()} />}

      {banner && (
        <div className="banner" role="status">
          {banner}
        </div>
      )}

      {status === 'starting' || status === 'connecting' ? (
        <div className="overlay" role="status">
          <h2>{status === 'starting' ? 'Starting the game server…' : 'Connecting…'}</h2>
          <p className="muted">{status === 'starting' ? 'This takes 30-60 seconds.' : 'Almost there.'}</p>
          <button type="button" className="link" onClick={exit}>
            ← Exit to menu (Esc)
          </button>
        </div>
      ) : status === 'offline' ? (
        <div className="overlay" role="alert">
          <h2>{room.error === 'full' ? 'This game is full' : room.error === 'not_found' ? 'No such game' : 'Not connected'}</h2>
          <a className="button" href="#/">
            Back to the title screen
          </a>
        </div>
      ) : roomOver ? (
        <div className="overlay results" role="status">
          <h2>Thanks for playing</h2>
          <p>{saving ? 'Saving your scores and shots…' : saved ? 'Saved: scores are on the leaderboard and your shots in Telemetry.' : ''}</p>
          <ErrorNote error={saveError} className="error" />
          <div className="row">
            <a className="button primary" href="#/">
              Title screen
            </a>
            <a className="button" href="#/telemetry">
              Telemetry
            </a>
          </div>
        </div>
      ) : flow.k === 'result' && report ? (
        <TrainingResult report={report} onCompare={startAb} onUse={() => applyFit()} onKeep={() => keepMine()} onAgain={trainAgain} remote={phone} />
      ) : flow.k === 'pick' ? (
        <AbChoice onPick={pick} score={abScore.current} remote={phone} />
      ) : flow.k === 'done' ? (
        <TrainingDone
          message={flow.message}
          saving={tuneSaving}
          error={tuneError}
          onPlay={() => {
            setFlow({ k: 'none' });
            sendEvent({ mode: 'rounds' });
          }}
          onAgain={trainAgain}
          onDone={exit}
          remote={phone}
        />
      ) : flow.k === 'ab' ? null : over ? (
        <Results over={over} best={saved} saving={saving} onAgain={start} onDone={exit} remote={phone} />
      ) : live && !guns ? (
        <div className="overlay pair">
          <h2>Pair your controller</h2>
          <p>Scan with your iPhone camera: it opens the controller in DashyHQ (or Safari). Everything else happens on the phone.</p>
          <a href={link} className="qr-link" target="_blank" rel="noreferrer">
            <QrCode text={link} label="QR code to open the gun on your phone" />
          </a>
          <p className="code-line">
            Or open Whee on your phone and enter <strong className="code">{code ?? '····'}</strong>
          </p>
          <div className="row">
            <button type="button" className="link" onClick={exit}>
              ← Exit to menu (Esc)
            </button>
            <button type="button" className="link" onClick={() => setUseMouse(true)}>
              Use the mouse instead
            </button>
          </div>
        </div>
      ) : live && snaps && !pointCal ? (
        <SnapCodes view={snaps} snapping={snapping} playerOf={playerOf} look={look} />
      ) : live && pointCal ? (
        <div className="overlay calibrate" role="dialog" aria-label="Calibrating">
          <p className="cal-step">
            Player {playerOf(pointCal.gun ?? '')} · {pointCal.st === 'init' ? 'Step 1 of 2 · Initialize' : 'Step 2 of 2 · Calibrate'} · Dot {Math.min(pointCal.i + 1, pointCal.pts.length)} of {pointCal.pts.length}
          </p>
          <h2>{pointCal.st === 'init' ? 'Point at the green dot and tap your phone' : 'Put the crosshair on the dot and tap'}</h2>
          <p className="muted">
            {pointCal.st === 'init' ? 'No crosshair yet: this finds where your phone points.' : 'The crosshair is live now: this fine-tunes it to your hand.'}
            {pointCal.wait ? ` ${pointCal.wait} more phone${pointCal.wait > 1 ? 's' : ''} after this.` : ''}
          </p>
          <p className="muted small">Redo or skip on the phone.</p>
        </div>
      ) : confirmExit && inGame ? (
        <div className="overlay exit-confirm" role="alertdialog" aria-label="Exit to menu?">
          <h2>Exit to menu?</h2>
          <p className="muted">This ends the game. Scores so far are saved.</p>
          <div className="row">
            <button type="button" className="primary" onClick={exit}>
              Exit (Esc)
            </button>
            <button type="button" onClick={() => setConfirmExit(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : paused && !panel && flow.k === 'none' ? (
        phone ? (
          <div className="overlay paused" role="status">
            <h2>Paused</h2>
            <p className="muted">The menu is on your phone.</p>
            <button type="button" onClick={exit}>
              ← Exit to menu
            </button>
          </div>
        ) : (
          <aside className="menu-panel" aria-label="Pause menu">
            <div className="row spread">
              <h2>Menu</h2>
              <span className="muted small">Right-click</span>
            </div>
            <GameMenu
              mode={snap!.m}
              look={look}
              playing
              canTrain={false}
              onMode={(m) => sendEvent({ mode: m })}
              onLook={setLook}
              onSettings={() => setPanel(true)}
              onResume={() => sendEvent({ pause: false })}
              onExit={exit}
            />
          </aside>
        )
      ) : live && training && snap?.tr?.k === 'ready' ? (
        <TrainingIntro onStart={start} error={trainError} remote={phone} />
      ) : live && lobby ? (
        <div className="overlay lobby" role="dialog" aria-label="Ready">
          <ul className="players">
            {snap!.g.map((g, i) => (
              <li key={g.id} style={{ color: palette.seats[g.c % palette.seats.length] }}>
                ● Player {i + 1} · {g.m ? 'mouse' : 'phone'}
              </li>
            ))}
          </ul>
          <h2>
            {gameName(snap!.m)} · {lookTheme.name}
          </h2>
          {phone ? (
            <p className="muted on-phone">Pick the game and start it on your phone.</p>
          ) : (
            // Only a mouse: the screen is the controller.
            <>
              <GameMenu mode={snap!.m} look={look} canTrain={false} onMode={(m) => sendEvent({ mode: m })} onLook={setLook} onSettings={() => setPanel(true)} />
              <button type="button" className="primary big" onClick={start}>
                Start {snap?.m === 'range' ? 'the Range' : 'Round 1'} (Enter)
              </button>
            </>
          )}
          <div className="row">
            <button type="button" className="link" onClick={exit}>
              ← Exit to menu (Esc)
            </button>
            {!useMouse && (
              <button type="button" className="link" onClick={() => setUseMouse(true)}>
                Add a mouse gun
              </button>
            )}
          </div>
        </div>
      ) : null}

      {panel && (
        <TuningPanel
          tuning={tuning.tuning}
          configId={tuning.id}
          stats={stats}
          snapshot={snap}
          motion={motion.current}
          lastShot={lastShot}
          mode={snap?.m ?? startMode}
          range={range}
          overlay={overlay}
          onTune={tune}
          onRange={changeRange}
          onOverlay={setOverlay}
          hitboxes={hitboxes}
          onHitboxes={setHitboxes}
          onClose={() => setPanel(false)}
          onSave={() => void saveDefault(tuning.tuning, 'manual').then((ok) => ok && show('Saved as your default'))}
          onCalibrate={phone ? () => sendEvent({ calibrate: 'points' }) : undefined}
        />
      )}
    </div>
  );
}
