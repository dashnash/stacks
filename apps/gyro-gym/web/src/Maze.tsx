import { useEffect, useRef, useState } from 'react';
import { native } from '@stacks/native';
import { BALL_R, find, height, isWall, loadBest, MAZE, saveBest, startBall, step, width, type Ball } from './game/maze';
import { dragToTilt, isTiltKey, keysToTilt, relative, tiltFromAttitude, type Tilt } from './motion/tilt';
import { sourceLabel, useMotion, useZero } from './motion/useMotion';

type Status = 'ready' | 'running' | 'won';
/** At most 10 wall buzzes a second. */
export const HIT_GAP_MS = 100;
const W = width();
const H = height();
const GOAL = find('G');
const walls: { x: number; y: number }[] = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isWall(x, y)) walls.push({ x, y });

const fmt = (ms: number) => (ms / 1000).toFixed(2) + ' s';
const quiet = (p: Promise<unknown>) => void p.catch(() => {});

export function Maze() {
  const motion = useMotion(60);
  const { zero } = useZero();
  const ball = useRef<Ball>(startBall());
  const [, redraw] = useState(0);
  const [status, setStatus] = useState<Status>('ready');
  const [elapsed, setElapsed] = useState(0);
  const [best, setBest] = useState<number | null>(() => loadBest());
  const [newBest, setNewBest] = useState(false);
  const held = useRef(new Set<string>());
  const drag = useRef<{ x: number; y: number; tilt: Tilt } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const live = useRef({ status, startedAt: 0, lastHit: 0, zero });
  live.current.zero = zero;
  live.current.status = status;

  // While playing: the whole screen, held in portrait (the app only; quietly nothing elsewhere).
  useEffect(() => {
    if (native.has('screen.immersive')) quiet(native.screen.immersive(true));
    if (native.has('screen.lockOrientation')) quiet(native.screen.lockOrientation('portrait'));
    return () => {
      if (native.has('screen.immersive')) quiet(native.screen.immersive(false));
      if (native.has('screen.lockOrientation')) quiet(native.screen.lockOrientation('any'));
    };
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!isTiltKey(e.key)) return;
      held.current.add(e.key);
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => void held.current.delete(e.key);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(() => {
    let last = performance.now();
    let frame = 0;
    const raf = window.requestAnimationFrame ?? ((fn: FrameRequestCallback) => window.setTimeout(() => fn(performance.now()), 16));
    const caf = window.cancelAnimationFrame ?? window.clearTimeout;
    const loop = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      const L = live.current;
      if (L.status !== 'won') {
        const tilt = currentTilt();
        if (L.status === 'ready' && Math.hypot(tilt.x, tilt.y) > 0.05) {
          L.status = 'running';
          L.startedAt = now;
          setStatus('running');
        }
        if (L.status === 'running') {
          const r = step(ball.current, tilt, dt);
          if (r.hit && now - L.lastHit >= HIT_GAP_MS) {
            L.lastHit = now;
            quiet(native.haptics.impact(r.hit > 5 ? 'heavy' : 'medium'));
          }
          setElapsed(now - L.startedAt);
          if (r.goal) {
            const ms = now - L.startedAt;
            L.status = 'won';
            setStatus('won');
            setElapsed(ms);
            quiet(native.haptics.notification('success'));
            const better = saveBest(ms);
            setNewBest(better);
            setBest(loadBest() ?? ms);
          }
          redraw((n) => n + 1);
        }
      }
      frame = raf(loop);
    };
    frame = raf(loop);
    return () => caf(frame);
  }, []);

  function currentTilt(): Tilt {
    if (drag.current) return drag.current.tilt;
    if (held.current.size) return keysToTilt(held.current);
    const a = motion.stats.current?.latest?.attitude;
    return a ? tiltFromAttitude(relative(a, live.current.zero)) : { x: 0, y: 0 };
  }

  function restart() {
    ball.current = startBall();
    live.current.status = 'ready';
    setStatus('ready');
    setElapsed(0);
    setNewBest(false);
    redraw((n) => n + 1);
  }

  const size = () => stage.current?.getBoundingClientRect().width ?? 300;
  const b = ball.current;

  return (
    <section className="maze" aria-label="Maze">
      <div className="bar">
        <span className={`chip chip-${sourceLabel(motion.source).toLowerCase()}`}>{sourceLabel(motion.source)}</span>
        <span className="big" data-testid="timer">{fmt(elapsed)}</span>
        <span className="muted small">best {best ? fmt(best) : '–'}</span>
      </div>
      {motion.needsTap && (
        <button type="button" className="primary" onClick={() => void motion.enable()}>
          Enable motion
        </button>
      )}
      <div
        ref={stage}
        className="stage"
        role="application"
        aria-label="Maze: tilt the phone, use the arrow keys, or drag to roll the marble to the hole"
        style={{ aspectRatio: `${W} / ${H}` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, tilt: { x: 0, y: 0 } };
        }}
        onPointerMove={(e) => {
          if (drag.current) drag.current.tilt = dragToTilt(e.clientX - drag.current.x, e.clientY - drag.current.y, size());
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`}>
          {walls.map((w) => (
            <rect key={`${w.x},${w.y}`} x={w.x} y={w.y} width="1.02" height="1.02" className="wall" />
          ))}
          <circle cx={GOAL.x} cy={GOAL.y} r={0.38} className="hole" />
          <circle cx={b.x} cy={b.y} r={BALL_R} className="ball" data-testid="ball" />
        </svg>
        {status === 'won' && (
          <div className="won" role="status">
            <p className="big">{fmt(elapsed)}</p>
            <p>{newBest ? 'New best!' : `Best: ${best ? fmt(best) : '–'}`}</p>
            <button type="button" className="primary" onClick={restart}>
              Again
            </button>
          </div>
        )}
      </div>
      <p className="muted small">
        {status === 'ready' ? 'Tilt to start the clock.' : 'Roll to the hole.'} On a laptop: arrow keys or WASD, or drag the board.{' '}
        {status !== 'won' && (
          <button type="button" className="link" onClick={restart}>
            Restart
          </button>
        )}
      </p>
      <p className="sr-only">{`Marble at ${b.x.toFixed(1)}, ${b.y.toFixed(1)}; ${MAZE.length} rows.`}</p>
    </section>
  );
}
