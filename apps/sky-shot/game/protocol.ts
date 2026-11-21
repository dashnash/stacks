/**
 * What travels between the screen, the guns and the game server. Shared by `game/server.ts` and the
 * web UI. Seats are told apart by their device label: `screen`, `gun` / `gun-2`, `mouse`.
 */
import type { FitReport } from './fit';
import type { RecSample, TrialKind } from './training';
import type { ThemeChoice } from './themes';
import type { Tuning } from './tuning';

export type Vec3 = [number, number, number];
/** Attitude as a quaternion `[x, y, z, w]` (no gimbal flips near vertical). */
export type Quat = [number, number, number, number];

/** Device labels (`useGameRoom(roomId, { device })`). */
export const DEVICE = { screen: 'screen', gun: 'gun', gun2: 'gun-2', mouse: 'mouse' } as const;
export type SeatKind = 'screen' | 'gun' | 'mouse' | 'watcher';
export const seatKind = (device: string | undefined): SeatKind =>
  device === DEVICE.screen ? 'screen' : device === DEVICE.gun || device === DEVICE.gun2 ? 'gun' : device === DEVICE.mouse ? 'mouse' : 'watcher';

/** One motion sample from the phone. `t` is the phone's motion clock, seconds. */
export interface WireSample {
  t: number;
  q: Quat;
  /** rotationRate, rad/s, device axes. */
  r: Vec3;
  /** userAcceleration, g. */
  a: Vec3;
}

/** The most samples one input carries (keeps it far under the 4 KB limit). */
export const MAX_SAMPLES_PER_INPUT = 8;

/**
 * Input from a gun (unreliable, about 60 a second). The phone always sends its latest 8 samples, so
 * a lost packet loses nothing; the server keeps only samples newer than it has seen. A mouse seat
 * sends `p`, the pointer as a crosshair (0-1 on both axes), instead of samples.
 */
export interface GunInput {
  seq: number;
  /** Sender's clock, seconds (the motion clock for a phone, `performance.now() / 1000` for a mouse). */
  t: number;
  /** The sender's round trip to the server, ms (for the clock estimate). */
  rtt?: number;
  samples?: WireSample[];
  p?: [number, number];
}

export type GameMode = 'rounds' | 'range' | 'training';
export type RangeKind = 'static' | 'sweep' | 'popup';
export type Phase = 'ready' | 'playing' | 'roundEnd' | 'over';

/**
 * The controller's menu (a phone; with only a mouse, the screen's pause panel sends the same as
 * screen events). Game, look, settings, pause and exit come from the first phone only; any phone may
 * re-calibrate, redo or skip its own calibration.
 */
export type MenuEvent =
  | { mode: GameMode }
  | { theme: ThemeChoice }
  | { tune: Partial<Tuning> }
  | { pause: boolean }
  | { range: { kind?: RangeKind; speed?: number } }
  /** Exit to the menu: end the room (saved) and the screen goes back to the title. */
  | { finish: true }
  /** Step 2 again (live crosshair, 5 dots). */
  | { recalibrate: true }
  /** Start the current step over, from dot 1. */
  | { calRedo: true }
  /** Skip the rest of this phone's calibration. */
  | { calSkip: true };

/** Events a gun sends. `t` on the sender's clock. */
/** `calibrate` during a 5-point calibration marks the current dot; otherwise it makes the current pose the centre. */
export type GunEvent = { shot: { t: number } } | { calibrate: { t: number } } | { menu: MenuEvent };

/**
 * Calibration on every controller connect, one phone at a time: `init` (5 dots, no crosshair: where
 * the phone points) then `fine` (5 dots with the live crosshair). Re-calibrate runs `fine` only.
 */
export type CalStage = 'init' | 'fine';
/** Events the screen sends. */
export type ScreenEvent =
  | { tune: Partial<Tuning> }
  | { mode: GameMode }
  | { range: { kind?: RangeKind; speed?: number } }
  | { start: true }
  | { pause: boolean }
  /**
   * Which server time the screen is drawing: `shown` for the targets (interpolated, ~100 ms back) and
   * `aim` for the crosshairs (the newest state), plus its round trip. For lag compensation.
   */
  | { ack: { shown: number; rtt: number; aim?: number } }
  /** Re-calibrate the first phone (step 2), cancel the calibration on now, or skip every one waiting (the demo's autoplay). */
  | { calibrate: 'points' | 'cancel' | 'skip' }
  /** The screen's shape (width / height): hit distances are measured in screen space. */
  | { view: { aspect: number } }
  /** Done playing: end the room so the session can be saved. */
  | { finish: true }
  /** The look the screen draws (the phones follow it; shots record it). */
  | { theme: ThemeChoice };

export interface Latency {
  /** Gun → server round trip, ms. */
  gun: number;
  /** Screen → server round trip, ms. */
  screen: number;
  /** Estimated motion sample → crosshair drawn, ms. */
  pix: number;
}

export interface ConfigStats {
  shots: number;
  hits: number;
  /** Mean miss distance (screen heights) over misses. */
  meanMiss: number;
  /** Range: mean ms from a target appearing to being hit. */
  meanTtt: number;
}

/** Events the server sends to everyone. */
export type ServerEvent =
  | { hit: { seat: string; target: number; x: number; y: number; pts: number; lat: Latency; rw: number; cfg: string } }
  | { miss: { seat: string; x: number; y: number; d: number; lat: Latency; rw: number; cfg: string } }
  /** A shot with none left in this release. */
  | { empty: { seat: string } }
  | { roundStart: { round: number; quota: number } }
  | { roundEnd: { round: number; hits: number; quota: number; passed: boolean; bonus: number } }
  | { gameOver: GameSummary }
  | { tuning: { tuning: Tuning; id: string } }
  | { stats: Record<string, ConfigStats> }
  /** A 5-point calibration finished: the fit, already applied. `poor`: the points didn't line up well. */
  | { calibrated: { gain: number; ratioY: number; offsetX: number; offsetY: number; error: number; poor: boolean; seat?: string; stage?: CalStage } }
  | { calibrationFailed: { reason: string; seat?: string } }

  /** A training run finished and was fitted. */
  | { trained: FitReport }
  /** A training run couldn't be fitted (no gun, or too little motion). */
  | { trainFailed: { reason: string } }
  /** The screen's look, on joining and whenever it changes. */
  | { theme: ThemeChoice };

/** A 5-point calibration in progress, in the snapshot: the dots and which one to point at. */
export interface CalibrationView {
  i: number;
  pts: [number, number][];
  /** The phone being calibrated (its seat), the step, and how many phones wait after it. */
  gun?: string;
  st?: CalStage;
  wait?: number;
}
/** Training, in the screen's snapshot. */
export interface TrainingView {
  /** What is on now: a trial, the gap before one, waiting to start, fitting, or done. */
  k: TrialKind | 'gap' | 'ready' | 'fit' | 'done';
  /** Trial number (from 0) and how many there are. */
  i: number;
  n: number;
  /** The dot (x in widths, y in heights), and on a jump the start dot too. */
  x: number;
  y: number;
  ax?: number;
  ay?: number;
  /** Show the crosshair (hidden while a jump is being made). */
  show: boolean;
  /** Fitting: progress 0-1. */
  p?: number;
}

export type TargetKind = 'bird' | 'clay' | 'balloon';
export const TARGET_KINDS: TargetKind[] = ['bird', 'clay', 'balloon'];

/** A target in a snapshot: position normalised to the screen (0-1), radius in screen heights. */
export interface TargetView {
  id: number;
  k: number;
  x: number;
  y: number;
  r: number;
  /** 0 flying, 1 hit (falling), 2 fleeing. */
  s: number;
  /** Heading, radians (for drawing wings). */
  h: number;
}

/** A gun's crosshair: mapped (`x`, `y`) and raw (no smoothing or prediction). */
export interface GunView {
  id: string;
  /** Colour index. */
  c: number;
  x: number;
  y: number;
  rx: number;
  ry: number;
  /** Connected (not in the 20 s rejoin grace). */
  on: boolean;
  /** `mouse` or `gun`. */
  m: boolean;
}

/** What every seat gets each tick (kept well under 1 KB). */
export interface Snapshot {
  ph: Phase;
  m: GameMode;
  pz: boolean;
  tg: TargetView[];
  g: GunView[];
  sc: number;
  rd: number;
  /** Shots left in this release (rounds). */
  sl: number;
  /** Hits this round, and the quota. */
  h: number;
  q: number;
  /** Targets still to come this round. */
  left: number;
  cfg: string;
  /** Screen only: latency now, and the first gun's motion (for the panel's graphs). */
  lat?: Latency & { lag: number };
  cal?: CalibrationView;
  /** The seat whose menu drives the game (the first phone), if a phone is paired. */
  ctl?: string;
  tr?: TrainingView;
  mo?: { yaw: number; pitch: number; roll: number; r: Vec3; a: number };
}

export interface GameSummary {
  mode: GameMode;
  score: number;
  /** Rounds reached. */
  rounds: number;
  accuracy: number;
  shots: number;
  hits: number;
  shooterId: string | null;
  shooterName: string | null;
  /** Ms since the room started. */
  endedAt: number;
  /** The look when the game ended (`themeTag`); absent in games saved before themes. */
  theme?: string;
}

/** A motion sample in a shot's window: `[t, qx, qy, qz, qw, rx, ry, rz, ax, ay, az]`, t in ms relative to the shot. */
export type WindowSample = [number, number, number, number, number, number, number, number, number, number, number];

export interface ShotRecord {
  /** Ms since the room started (server clock). */
  t: number;
  shooterId: string;
  mode: GameMode;
  configId: string;
  trigger: 'tap' | 'flick' | 'mouse';
  hit: boolean;
  /** Screen heights from the crosshair to the nearest hitbox edge; 0 for a hit. */
  missDist: number;
  rewindMs: number;
  latency: { gunRtt: number; screenRtt: number; shotToPixel: number };
  /** −300 ms … +100 ms around the shot, 25 Hz. */
  window: WindowSample[];
  /** The look the screen drew (`themeTag`); absent in shots saved before themes. */
  theme?: string;
}

/** What the room records when it ends (and the app API copies). */
export interface Results {
  v: 1;
  /** Wall clock when the room started, ms since the epoch. */
  startedAt: number;
  games: GameSummary[];
  shots: ShotRecord[];
  /** Shots past the cap: the oldest are dropped, and counted here. */
  droppedShots: number;
  /** Each config the shots refer to, once. */
  configs: Record<string, Tuning>;
  /** Training runs in this room: the fit, and the raw motion of the jumps (for refitting later). */
  training?: TrainingRecord[];
}

/** A raw sample, compact: `[t, qx, qy, qz, qw, rx, ry, rz]`, t in ms since the run started; q to 4 decimals, rates to 3. */
export type RawSample = [number, number, number, number, number, number, number, number];

export interface TrainingRecord {
  /** Ms since the room started. */
  t: number;
  shooterId: string;
  report: FitReport;
  /** The trials with their times (ms since the run started). */
  trials: { kind: TrialKind; a: [number, number]; b?: [number, number]; t0: number; move?: number; end: number }[];
  /** The motion at 25 Hz (dropped, oldest run first, if the results would be too big). */
  raw: RawSample[];
  aspect: number;
}

const fixed = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
export const toRaw = (s: RecSample, t0: number): RawSample => [Math.round(s.st - t0), ...s.q.map((v) => fixed(v, 4)), ...s.r.map((v) => fixed(v, 3))] as RawSample;

/** Results are capped at this many shots and this many bytes of JSON (the room record is a 400 KB DynamoDB item). */
export const MAX_SHOTS = 500;
export const MAX_RESULTS_BYTES = 250_000;

/** Round to 4 significant digits (telemetry). */
export function sig4(n: number): number {
  if (!Number.isFinite(n) || n === 0) return 0;
  return Number(n.toPrecision(4));
}
