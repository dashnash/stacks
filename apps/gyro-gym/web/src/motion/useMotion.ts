import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { hasWebMotion, native, requestWebMotionPermission, type Attitude, type MotionSource, type NativeErrorCode } from '@stacks/native';
import { MotionStats } from './stats';
import { ZERO } from './tilt';

export type Want = 'auto' | 'web';
export type SourceLabel = 'Native' | 'Fake' | 'Web' | 'None';

/** The chip: the app's CoreMotion, the demo's pretend one, the browser's, or nothing. */
export function sourceLabel(source: MotionSource): SourceLabel {
  if (source === 'native') return native.platform === 'fake' ? 'Fake' : 'Native';
  return source === 'web' ? 'Web' : 'None';
}

/** Can this page choose between the app's sensors and the browser's? */
export const canCompare = () => native.motion.source === 'native' && hasWebMotion(globalThis as never);

/** iOS Safari (and the browser fallback in the app) wants a tap before it gives motion events. */
export function webNeedsTap(): boolean {
  const DME = (globalThis as { DeviceMotionEvent?: { requestPermission?: unknown } }).DeviceMotionEvent;
  return typeof DME?.requestPermission === 'function';
}

export interface MotionState {
  source: MotionSource;
  /** The rate the source runs at, once started. */
  hz: number | null;
  error: MotionProblem | null;
  /** Waiting for the person to tap "Enable motion". */
  needsTap: boolean;
  enable: () => Promise<void>;
  stats: React.MutableRefObject<MotionStats | null>;
}

/** Streams motion while mounted; restarts when the rate or the source changes. */
export function useMotion(hz: number, want: Want = 'auto'): MotionState {
  const willUse: MotionSource = want === 'web' ? (hasWebMotion(globalThis as never) ? 'web' : 'none') : native.motion.source;
  const [granted, setGranted] = useState(false);
  const [readyHz, setReadyHz] = useState<number | null>(null);
  const [error, setError] = useState<MotionProblem | null>(null);
  const stats = useRef<MotionStats | null>(null);
  const needsTap = willUse === 'web' && webNeedsTap() && !granted;

  useEffect(() => {
    setReadyHz(null);
    setError(null);
    if (needsTap) {
      // Nothing streams until the tap: don't leave the last source's readings frozen on screen.
      stats.current = null;
      return;
    }
    const s = new MotionStats(hz);
    stats.current = s;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const stop = native.motion.start({ hz, source: want }, (batch) => s.add(batch, now()));
    let live = true;
    stop.ready.then(
      (r) => live && setReadyHz(r.hz),
      (e: { code?: NativeErrorCode; message?: string }) => live && setError({ code: e.code ?? 'failed', source: willUse, message: e.message ?? '' }),
    );
    return () => {
      live = false;
      stop();
    };
  }, [hz, want, needsTap]);

  const enable = useCallback(async () => {
    // Ask the browser itself: native.motion.requestPermission() answers for the app's sensors
    // ("granted": they never ask) when the page is in DashyHQ, even if we want the browser's.
    const answer = willUse === 'web' ? await requestWebMotionPermission(globalThis as never) : await native.motion.requestPermission();
    if (answer === 'granted') setGranted(true);
    else setError({ code: answer === 'denied' ? 'forbidden' : 'unsupported', source: 'web', message: '' });
  }, [willUse]);

  return { source: willUse, hz: readyHz, error, needsTap, enable, stats };
}

/** Re-render every `ms` (the readouts don't need every sample). */
export function useTicker(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

/** Where "Zero" was pressed: shared by the Lab (which sets it) and the Maze. */
export const ZeroContext = createContext<{ zero: Attitude; setZero: (a: Attitude) => void }>({ zero: ZERO, setZero: () => {} });
export const useZero = () => useContext(ZeroContext);

/** Why motion didn't start: the error, and whether the app or the browser said it. */
export interface MotionProblem {
  code: NativeErrorCode;
  source: MotionSource;
  message: string;
}

/** What to tell the person. The app's own sensors never ask; only the browser's do. */
export function problemText(p: MotionProblem): string {
  if (p.code === 'unsupported') return 'No motion sensors here. Use the arrow keys or drag in the Maze.';
  if (p.code === 'forbidden' && p.source === 'native')
    return `DashyHQ didn't let this app use motion${p.message ? ` (“${p.message}”)` : ''}. There's no prompt for this: the app decides from what Gyro Gym declares.`;
  if (p.code === 'forbidden')
    return 'Motion access was turned down. In Safari, allow Motion & Orientation Access for this site (aA › Website Settings), then reload.';
  return `Motion didn't start${p.message ? `: ${p.message}` : ''}.`;
}
