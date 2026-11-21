/**
 * The big screen (a desktop browser): joins the room as device `screen`, shows the QR code to pair a
 * phone, draws the game from the server's state, and owns the tuning panel. "Use mouse instead"
 * joins a second seat (device `mouse`) from the same page.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ErrorNote, createStateBuffer, useApi, useAsync, useGameRoom } from '@stacks/web';
import { DEVICE, type ConfigStats, type GameMode, type GameSummary, type GunInput, type RangeKind, type ScreenEvent, type ServerEvent, type Snapshot } from '../../game/protocol';
import { configId, DEFAULT_TUNING, type Tuning } from '../../game/tuning';
import { drawFrame, EFFECT_MS, GUN_COLORS, type Effect } from './draw';
import { encodeQr, qrPath } from './qr';
import { AB_MS, AbBanner, AbChoice, TrainingDone, TrainingHud, TrainingIntro, TrainingResult, type Pick } from './Training';
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

export function QrCode({ text, label }: { text: string; label: string }) {
  const qr = useMemo(() => encodeQr(text), [text]);
  const quiet = 4;
  return (
    <svg className="qr" viewBox={`${-quiet} ${-quiet} ${qr.size + quiet * 2} ${qr.size + quiet * 2}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect x={-quiet} y={-quiet} width={qr.size + quiet * 2} height={qr.size + quiet * 2} fill="#fff" />
      <path d={qrPath(qr.modules)} fill="#000" />
    </svg>
  );
}

function Results({ over, best, onAgain, onDone, saving }: { over: GameSummary; best: { rank: number | null } | null; onAgain: () => void; onDone: () => void; saving: boolean }) {
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
      <div className="row">
        <button type="button" className="primary" onClick={onAgain}>
          Play again
        </button>
        <button type="button" onClick={onDone} disabled={saving}>
          {saving ? 'Saving…' : 'Done (save)'}
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
        effects.current.push({ kind: 'pop', x: e.hit.x, y: e.hit.y, c: colorOf(e.hit.seat), at: now }, ...(e.hit.pts ? [{ kind: 'score' as const, x: e.hit.x, y: e.hit.y, c: 0, at: now, text: `+${e.hit.pts}` }] : []));
        setLastShot({ ...e.hit.lat, rw: e.hit.rw });
      } else if ('miss' in e) {
        effects.current.push({ kind: 'flash', x: e.miss.x, y: e.miss.y, c: colorOf(e.miss.seat), at: now });
        setLastShot({ ...e.miss.lat, rw: e.miss.rw });
      } else if ('tuning' in e) {
        tuningNow.current = e.tuning.tuning;
        setTuning(e.tuning);
      } else if ('calibrated' in e) {
        const c = e.calibrated;
        const off = `${Math.round(c.error * 100)} %`;
        if (c.poor) show(`Calibrated, but the dots didn't line up (off by ${off}). Try again?`, 4000);
        else {
          show(`Calibrated: ${c.gain.toFixed(2)} widths/rad, off by ${off}. Saved as your default.`, 3500);
          void saveDefault(tuningNow.current, 'calibration');
        }
      } else if ('calibrationFailed' in e) show(e.calibrationFailed.reason, 3500);
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
      effects.current = effects.current.filter((x) => now - x.at < EFFECT_MS);
    },
    [show, saveDefault],
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
  const calibrating = !!snap && snap.g.length > 0 && snap.ph === 'ready' && !training;
  const pointCal = snap?.cal;
  const phone = !!snap?.g.some((g) => !g.m);
  useEffect(() => {
    let frame = 0;
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
        drawFrame(ctx, w, h, buffer.sample(), effects.current, { now: performance.now(), overlay, calibrate: calibrating && !cal, guns: latest.current?.g, cal, training: latest.current?.tr });
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [buffer, overlay, calibrating]);

  // The panel pauses Rounds (not Range).
  useEffect(() => {
    if (live) sendEvent({ pause: panel });
  }, [panel, live, sendEvent]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if ((e.key === 't' || e.key === 'T') && abStep.current === null) setPanel((p) => !p);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const start = useCallback(() => {
    setOver(null);
    sendEvent({ start: true });
  }, [sendEvent]);
  // Demo autoplay: start once a gun has joined.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autostart && live && !autoStarted.current && snap && snap.g.length && snap.ph === 'ready') {
      autoStarted.current = true;
      start();
    }
  }, [autostart, live, snap, start]);

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

  // Mouse fallback: the pointer is a gun.
  const mouseSeq = useRef(0);
  const point = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!useMouse) return;
    const box = e.currentTarget.getBoundingClientRect();
    mouseRoom.sendInput({ seq: ++mouseSeq.current, t: performance.now() / 1000, rtt: mouseRoom.rttMs ?? 0, p: [(e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height] });
  };
  const click = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!useMouse) return;
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
  const changeRange = (change: { kind?: RangeKind; speed?: number }) => {
    setRange((r) => ({ ...r, ...change }));
    sendEvent({ range: change });
  };

  const code = info.data?.room.code;
  const guns = snap?.g.length ?? 0;
  const link = gunLink(roomId);

  return (
    <div className={`screen${panel ? ' with-panel' : ''}`}>
      <canvas ref={canvas} className="sky" onPointerMove={point} onPointerDown={click} aria-label="Sky Shot play area" />

      {snap && (
        <div className="hud" aria-live="off">
          <span className="score">{snap.sc.toLocaleString()}</span>
          {snap.m === 'rounds' ? (
            <>
              <span>Round {snap.rd || 1}</span>
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
            <span key={g.id} className="gun-chip" style={{ color: GUN_COLORS[g.c % GUN_COLORS.length] }}>
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
        <TrainingResult report={report} onCompare={startAb} onUse={() => applyFit()} onKeep={() => keepMine()} onAgain={trainAgain} />
      ) : flow.k === 'pick' ? (
        <AbChoice onPick={pick} score={abScore.current} />
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
          onDone={() => sendEvent({ finish: true })}
        />
      ) : flow.k === 'ab' ? null : over ? (
        <Results over={over} best={saved} saving={saving} onAgain={start} onDone={() => sendEvent({ finish: true })} />
      ) : live && !guns ? (
        <div className="overlay pair">
          <h2>Pair your phone</h2>
          <p>Scan with your iPhone camera: it opens the gun in DashyHQ (or Safari).</p>
          <a href={link} className="qr-link" target="_blank" rel="noreferrer">
            <QrCode text={link} label="QR code to open the gun on your phone" />
          </a>
          <p className="code-line">
            Or open Sky Shot on your phone and enter <strong className="code">{code ?? '····'}</strong>
          </p>
          <button type="button" className="link" onClick={() => setUseMouse(true)}>
            Use mouse instead
          </button>
        </div>
      ) : live && pointCal ? (
        <div className="overlay calibrate" role="dialog" aria-label="Calibrating">
          <h2>Point at the green dot and tap the phone</h2>
          <p className="muted">
            Dot {Math.min(pointCal.i + 1, pointCal.pts.length)} of {pointCal.pts.length}. Hold the phone the way you play.
          </p>
          <button type="button" className="link" onClick={() => sendEvent({ calibrate: 'cancel' })}>
            Cancel
          </button>
        </div>
      ) : live && training && snap?.tr?.k === 'ready' ? (
        <TrainingIntro onStart={start} error={trainError} />
      ) : live && calibrating ? (
        <div className="overlay calibrate">
          <h2>{tuning.tuning.mode === 'relative' ? 'Wave to find your crosshair' : 'Point your phone at the dot and tap Calibrate'}</h2>
          {phone && (
            <button type="button" onClick={() => sendEvent({ calibrate: 'points' })}>
              Calibrate (5 dots)
            </button>
          )}
          <button type="button" className="primary" onClick={start}>
            Start {snap?.m === 'range' ? 'the Range' : 'Round 1'}
          </button>
          {!useMouse && (
            <button type="button" className="link" onClick={() => setUseMouse(true)}>
              Add a mouse gun
            </button>
          )}
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
          onClose={() => setPanel(false)}
          onSave={() => void saveDefault(tuning.tuning, 'manual').then((ok) => ok && show('Saved as your default'))}
          onCalibrate={phone ? () => sendEvent({ calibrate: 'points' }) : undefined}
        />
      )}
    </div>
  );
}
