/**
 * Sky Shot's game server. Seats by device: one `screen` (draws, tunes, starts), up to two guns
 * (`gun`, `gun-2`: a phone streaming raw motion) or a `mouse` (a gun whose input is already a
 * crosshair). The server maps motion to crosshairs, detects flicks, and decides every hit with lag
 * compensation: a shot is tested against the targets as the screen showed them when it was fired.
 */
import { defineGame, type GamePlayer, type GameRoom } from '@stacks/game-server';
import { Aim, qnorm, toEuler } from './aim';
import {
  MAX_RESULTS_BYTES,
  MAX_SAMPLES_PER_INPUT,
  MAX_SHOTS,
  seatKind,
  sig4,
  type ConfigStats,
  type GameMode,
  type GameSummary,
  type GunInput,
  type GunView,
  type Latency,
  type Phase,
  type Quat,
  type RangeKind,
  type Results,
  type ServerEvent,
  type ShotRecord,
  type Snapshot,
  type Vec3,
  type WindowSample,
  type WireSample,
} from './protocol';
import { rng, spawnRangeTarget, spawnRoundTarget, stepTargets, TargetHistory, targetView, type Target } from './targets';
import { applyTune, configId, DEFAULT_TUNING, type Tuning } from './tuning';

export const TICK_HZ = 60;
export const MAX_GUNS = 2;
/** Rounds: targets per round, shots per release, and the quota (6 in round 1, one more each round, at most 10). */
export const TARGETS_PER_ROUND = 10;
export const SHOTS_PER_RELEASE = 3;
export const quotaFor = (round: number) => Math.min(TARGETS_PER_ROUND, 5 + round);
export const POINTS_PER_HIT = 100;
/** Pause between releases and after a round, ms. */
const RELEASE_GAP_MS = 600;
const ROUND_END_MS = 2500;
/** The screen's lag (interpolation delay plus network) until it reports its own. */
export const DEFAULT_SCREEN_LAG_MS = 150;
/** Telemetry window around a shot, and its sample spacing (25 Hz). */
const WINDOW_BEFORE_MS = 300;
const WINDOW_AFTER_MS = 100;
const WINDOW_STEP_MS = 40;
/** Raw samples kept per gun (the window, plus slack). */
const SAMPLES_KEPT_MS = 1500;
/** Two taps closer than this are one (a bounce on the glass). */
const TAP_DEBOUNCE_MS = 80;

interface StampedSample {
  /** Server time, ms. */
  st: number;
  s: WireSample;
}

interface Gun {
  seat: GamePlayer;
  mouse: boolean;
  color: number;
  aim: Aim;
  lastSeq: number;
  /** Newest sample time seen (sender's clock, s): older ones in a later input are repeats. */
  lastSampleT: number;
  /** Recent (arrival − sender time) values; their minimum maps the sender's clock to the server's. */
  clock: number[];
  rtt: number;
  samples: StampedSample[];
  lastShotAt: number;
}

interface PendingShot {
  record: Omit<ShotRecord, 'window'>;
  gun: Gun;
  /** Server time of the shot. */
  at: number;
}

interface Stat extends ConfigStats {
  missSum: number;
  tttSum: number;
  tttN: number;
}

export interface State {
  room: GameRoom<ServerEvent>;
  startedAt: number;
  random: () => number;
  tuning: Tuning;
  cfg: string;
  configs: Record<string, Tuning>;
  mode: GameMode;
  phase: Phase;
  paused: boolean;
  aspect: number;
  screen: string | null;
  screenLag: number;
  screenRtt: number;
  guns: Map<string, Gun>;
  targets: Target[];
  history: TargetHistory;
  nextId: number;
  round: number;
  quota: number;
  roundHits: number;
  roundShots: number;
  toRelease: number;
  wave: number;
  shotsLeft: number;
  nextReleaseAt: number | null;
  phaseUntil: number;
  passed: boolean;
  score: number;
  gameShots: number;
  gameHits: number;
  shooter: { id: string; name: string } | null;
  games: GameSummary[];
  shots: ShotRecord[];
  dropped: number;
  pending: PendingShot[];
  stats: Record<string, Stat>;
  range: { kind: RangeKind; speed: number };
}

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const vec = (v: unknown, n: number, limit: number): number[] | null =>
  Array.isArray(v) && v.length === n && v.every((x) => fin(x) && Math.abs(x) <= limit) ? (v as number[]) : null;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** A sample from a browser, or null if it isn't one. Values are bounded (rates ≤ 50 rad/s, accel ≤ 16 g). */
export function readSample(raw: unknown): WireSample | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const q = vec(s.q, 4, 1.01);
  const r = vec(s.r, 3, 50);
  const a = vec(s.a, 3, 16);
  if (!fin(s.t) || s.t < 0 || !q || !r || !a || Math.hypot(...q) < 0.5) return null;
  return { t: s.t, q: qnorm(q as Quat), r: r as Vec3, a: a as Vec3 };
}

/** Sender time (s) → server time (ms): the minimum (arrival − send) over recent inputs, less half the round trip. */
function serverTime(gun: Gun, t: number, now: number): number {
  if (!gun.clock.length) return now - gun.rtt / 2;
  return t * 1000 + Math.min(...gun.clock) - gun.rtt / 2;
}

function newGame(state: State): void {
  state.targets = [];
  state.history.clear();
  state.score = 0;
  state.gameShots = 0;
  state.gameHits = 0;
  state.round = 0;
  state.wave = 0;
  state.toRelease = 0;
  state.shotsLeft = 0;
  state.nextReleaseAt = null;
  state.phase = 'ready';
}

/** The game in progress as a summary (null when nothing was shot). */
function summary(state: State): GameSummary | null {
  if (!state.gameShots && !state.score) return null;
  return {
    mode: state.mode,
    score: state.score,
    rounds: state.mode === 'rounds' ? state.round : 0,
    accuracy: state.gameShots ? sig4(state.gameHits / state.gameShots) : 0,
    shots: state.gameShots,
    hits: state.gameHits,
    shooterId: state.shooter?.id ?? null,
    shooterName: state.shooter?.name ?? null,
    endedAt: Math.round(state.room.elapsedMs),
  };
}

/** Close the game in progress (a mode change, or leaving Range) so it is kept in the results. */
function closeGame(state: State): void {
  const s = state.phase !== 'over' ? summary(state) : null;
  if (s) state.games.push(s);
}

function startGame(state: State): void {
  closeGame(state);
  newGame(state);
  if (state.mode === 'rounds') {
    state.round = 1;
    beginRound(state);
  } else {
    state.phase = 'playing';
  }
}

function beginRound(state: State): void {
  state.quota = quotaFor(state.round);
  state.toRelease = TARGETS_PER_ROUND;
  state.roundHits = 0;
  state.roundShots = 0;
  state.phase = 'playing';
  state.room.broadcast({ roundStart: { round: state.round, quota: state.quota } });
  release(state);
}

function release(state: State): void {
  const now = state.room.elapsedMs;
  const n = Math.min(state.round >= 3 ? 2 : 1, state.toRelease);
  state.wave++;
  for (let i = 0; i < n; i++) state.targets.push(spawnRoundTarget(state.nextId++, state.round, state.wave, now, state.aspect, state.random));
  state.toRelease -= n;
  state.shotsLeft = SHOTS_PER_RELEASE;
  state.nextReleaseAt = null;
}

function endRound(state: State): void {
  const passed = state.roundHits >= state.quota;
  const accuracy = state.roundShots ? state.roundHits / state.roundShots : 0;
  const bonus = passed ? Math.round(accuracy * 300 * state.round) : 0;
  state.score += bonus;
  state.passed = passed;
  state.phase = 'roundEnd';
  state.phaseUntil = state.room.elapsedMs + ROUND_END_MS;
  state.room.broadcast({ roundEnd: { round: state.round, hits: state.roundHits, quota: state.quota, passed, bonus } });
}

function gameOver(state: State): void {
  const s = summary(state) ?? { mode: state.mode, score: 0, rounds: state.round, accuracy: 0, shots: 0, hits: 0, shooterId: null, shooterName: null, endedAt: Math.round(state.room.elapsedMs) };
  state.games.push(s);
  state.phase = 'over';
  state.targets = [];
  state.room.broadcast({ gameOver: s });
}

function statFor(state: State, id: string): Stat {
  return (state.stats[id] ??= { shots: 0, hits: 0, meanMiss: 0, meanTtt: 0, missSum: 0, tttSum: 0, tttN: 0 });
}

function publicStats(state: State): Record<string, ConfigStats> {
  const out: Record<string, ConfigStats> = {};
  for (const [id, s] of Object.entries(state.stats)) out[id] = { shots: s.shots, hits: s.hits, meanMiss: sig4(s.meanMiss), meanTtt: Math.round(s.meanTtt) };
  return out;
}

/**
 * A shot from `gun`, aimed at server time `aimT` (the tap, or the moment before a flick). It is tested
 * at E = aimT − the screen's lag: the targets and the crosshair as the screen showed them then. The
 * rewind is capped (`maxRewindMs`), so a lagging connection can't hit targets long gone.
 */
function fire(state: State, gun: Gun, aimT: number, trigger: ShotRecord['trigger']): void {
  if (state.phase !== 'playing' || (state.paused && state.mode === 'rounds')) return;
  const now = state.room.elapsedMs;
  if (state.mode === 'rounds' && state.shotsLeft <= 0) {
    state.room.broadcast({ empty: { seat: gun.seat.id } });
    return;
  }
  const tuning = state.tuning;
  let e = Math.min(now, aimT - state.screenLag);
  if (now - e > tuning.maxRewindMs) e = now - tuning.maxRewindMs;
  const rewind = Math.round(now - e);
  const aim = gun.aim.at(e);
  const cx = aim.x * state.aspect;
  const cy = aim.y;

  let best: { target: Target; d: number } | null = null;
  for (const past of state.history.at(e)) {
    const target = state.targets.find((t) => t.id === past.id);
    if (!target || target.state === 'hit' || !past.live) continue;
    const d = Math.hypot(cx - past.x, cy - past.y) - past.r * tuning.hitboxScale;
    if (!best || d < best.d) best = { target, d };
  }
  const hit = !!best && best.d <= 0;
  if (state.mode === 'rounds') {
    state.shotsLeft--;
    state.roundShots++;
  }
  state.gameShots++;
  state.shooter = { id: gun.seat.userId, name: gun.seat.name };
  const lat: Latency = { gun: Math.round(gun.rtt), screen: Math.round(state.screenRtt), pix: Math.round(gun.rtt / 2 + state.screenLag) };
  const stat = statFor(state, state.cfg);
  stat.shots++;
  const at = { x: r3(aim.x), y: r3(aim.y), lat, rw: rewind, cfg: state.cfg };
  if (hit) {
    const target = best!.target;
    target.state = 'hit';
    const pts = state.mode === 'rounds' ? (POINTS_PER_HIT + (target.kind === 'clay' ? 50 : 0)) * state.round : 0;
    state.score += pts;
    state.gameHits++;
    if (state.mode === 'rounds') state.roundHits++;
    stat.hits++;
    stat.tttSum += now - target.born;
    stat.tttN++;
    stat.meanTtt = stat.tttSum / stat.tttN;
    state.room.broadcast({ hit: { seat: gun.seat.id, target: target.id, pts, ...at } });
  } else {
    const d = best ? Math.max(0, best.d) : 1;
    stat.missSum += d;
    stat.meanMiss = stat.missSum / (stat.shots - stat.hits);
    state.room.broadcast({ miss: { seat: gun.seat.id, d: r3(d), ...at } });
  }
  state.room.broadcast({ stats: publicStats(state) });
  state.configs[state.cfg] = tuning;
  state.pending.push({
    gun,
    at: aimT,
    record: {
      t: Math.round(aimT),
      shooterId: gun.seat.userId,
      mode: state.mode,
      configId: state.cfg,
      trigger,
      hit,
      missDist: hit ? 0 : sig4(best ? Math.max(0, best.d) : 1),
      rewindMs: rewind,
      latency: { gunRtt: lat.gun, screenRtt: lat.screen, shotToPixel: lat.pix },
    },
  });
}

/** Turn pending shots into records once their motion window (to +100 ms) has arrived. */
function settleShots(state: State, force = false): void {
  const now = state.room.elapsedMs;
  state.pending = state.pending.filter((p) => {
    const newest = p.gun.samples[p.gun.samples.length - 1]?.st ?? -Infinity;
    if (!force && !p.gun.mouse && newest < p.at + WINDOW_AFTER_MS && now < p.at + WINDOW_BEFORE_MS + WINDOW_AFTER_MS) return true;
    const window: WindowSample[] = [];
    if (!p.gun.mouse) {
      for (let dt = -WINDOW_BEFORE_MS; dt <= WINDOW_AFTER_MS; dt += WINDOW_STEP_MS) {
        let near: StampedSample | undefined;
        for (const s of p.gun.samples) if (!near || Math.abs(s.st - (p.at + dt)) < Math.abs(near.st - (p.at + dt))) near = s;
        if (!near || Math.abs(near.st - (p.at + dt)) > WINDOW_STEP_MS) continue;
        const { q, r, a } = near.s;
        window.push([Math.round(near.st - p.at), ...q.map(sig4), ...r.map(sig4), ...a.map(sig4)] as WindowSample);
      }
    }
    state.shots.push({ ...p.record, window });
    if (state.shots.length > MAX_SHOTS) {
      state.shots.shift();
      state.dropped++;
    }
    return false;
  });
}

/** What the room records: every game, the shots (capped by count and by size), their configs. */
export function buildResults(state: State): Results {
  settleShots(state, true);
  const games = [...state.games];
  const open = state.phase !== 'over' ? summary(state) : null;
  if (open) games.push(open);
  let shots = state.shots;
  let dropped = state.dropped;
  const make = (): Results => {
    const configs: Record<string, Tuning> = {};
    for (const s of shots) configs[s.configId] = state.configs[s.configId] ?? state.tuning;
    return { v: 1, startedAt: state.startedAt, games, shots, droppedShots: dropped, configs };
  };
  let results = make();
  // Keep the latest shots that fit.
  while (shots.length && new TextEncoder().encode(JSON.stringify(results)).length > MAX_RESULTS_BYTES) {
    const cut = Math.max(1, Math.ceil(shots.length / 10));
    shots = shots.slice(cut);
    dropped += cut;
    results = make();
  }
  return results;
}

function addGun(state: State, seat: GamePlayer, mouse: boolean): void {
  if (state.guns.size >= MAX_GUNS) return;
  const used = new Set([...state.guns.values()].map((g) => g.color));
  const color = [0, 1, 2].find((c) => !used.has(c)) ?? 0;
  state.guns.set(seat.id, { seat, mouse, color, aim: new Aim(), lastSeq: -1, lastSampleT: -Infinity, clock: [], rtt: 0, samples: [], lastShotAt: -Infinity });
}

function onGunInput(state: State, gun: Gun, input: Partial<GunInput>): void {
  if (!fin(input.seq) || !fin(input.t) || input.t < 0) return;
  // A restarted phone (seq from 0 again) starts its clock over too.
  if (input.seq < gun.lastSeq - 1000) {
    gun.lastSampleT = -Infinity;
    gun.clock = [];
  } else if (input.seq <= gun.lastSeq) return;
  gun.lastSeq = input.seq;
  const now = state.room.elapsedMs;
  if (fin(input.rtt) && input.rtt >= 0 && input.rtt < 5000) gun.rtt = input.rtt;
  gun.clock.push(now - input.t * 1000);
  if (gun.clock.length > 120) gun.clock.shift();
  const tuning = state.tuning;

  if (gun.mouse) {
    const p = vec(input.p, 2, 2);
    if (p) gun.aim.point(serverTime(gun, input.t, now), p[0]!, p[1]!);
    return;
  }
  if (!Array.isArray(input.samples)) return;
  const samples = input.samples
    .slice(-MAX_SAMPLES_PER_INPUT)
    .map(readSample)
    .filter((s): s is WireSample => !!s && s.t > gun.lastSampleT)
    .sort((a, b) => a.t - b.t);
  for (const s of samples) {
    gun.lastSampleT = s.t;
    const st = serverTime(gun, s.t, now);
    gun.aim.update(st, s.q, s.r, tuning, state.aspect);
    gun.samples.push({ st, s });
    while (gun.samples.length > 2 && gun.samples[0]!.st < st - SAMPLES_KEPT_MS) gun.samples.shift();
    if (tuning.trigger === 'flick') {
      const a = tuning.flickAxis === 'y' ? Math.abs(s.a[1]) : tuning.flickAxis === 'z' ? Math.abs(s.a[2]) : Math.hypot(...s.a);
      if (a > tuning.flickThreshold && st - gun.lastShotAt > tuning.flickCooldown) {
        gun.lastShotAt = st;
        fire(state, gun, st - tuning.flickLookbackMs, 'flick');
      }
    }
  }
}

function onScreenEvent(state: State, event: Record<string, unknown>): void {
  const now = state.room.elapsedMs;
  if ('tune' in event) {
    state.tuning = applyTune(state.tuning, event.tune);
    state.cfg = configId(state.tuning);
    state.room.broadcast({ tuning: { tuning: state.tuning, id: state.cfg } });
  } else if ('mode' in event && (event.mode === 'rounds' || event.mode === 'range')) {
    if (event.mode !== state.mode) {
      closeGame(state);
      state.mode = event.mode;
      newGame(state);
    }
  } else if ('range' in event && event.range && typeof event.range === 'object') {
    const r = event.range as { kind?: unknown; speed?: unknown };
    if (r.kind === 'static' || r.kind === 'sweep' || r.kind === 'popup') {
      state.range.kind = r.kind;
      if (state.mode === 'range') state.targets = [];
    }
    if (fin(r.speed)) state.range.speed = Math.min(2, Math.max(0.1, r.speed));
  } else if ('start' in event) {
    startGame(state);
  } else if ('pause' in event) {
    state.paused = event.pause === true;
  } else if ('ack' in event && event.ack && typeof event.ack === 'object') {
    const { shown, rtt } = event.ack as { shown?: unknown; rtt?: unknown };
    if (!fin(shown) || !fin(rtt) || rtt < 0 || rtt > 5000) return;
    state.screenRtt = rtt;
    const lag = Math.min(1000, Math.max(0, now - rtt / 2 - shown));
    state.screenLag = state.screenLag * 0.8 + lag * 0.2;
  } else if ('view' in event && event.view && typeof event.view === 'object') {
    const aspect = (event.view as { aspect?: unknown }).aspect;
    if (fin(aspect)) state.aspect = Math.min(3, Math.max(0.5, aspect));
  } else if ('finish' in event) {
    state.room.end(buildResults(state));
  }
}

function tickRounds(state: State, dt: number, now: number): void {
  if (state.phase === 'roundEnd') {
    if (now >= state.phaseUntil) {
      if (state.passed) {
        state.round++;
        beginRound(state);
      } else gameOver(state);
    }
    return;
  }
  if (state.phase !== 'playing') return;
  if (state.shotsLeft <= 0) for (const t of state.targets) if (t.state === 'fly' && t.wave === state.wave) t.until = Math.min(t.until, now);
  const gone = stepTargets(state.targets, dt, now, state.aspect, false);
  if (gone.length) state.targets = state.targets.filter((t) => !gone.includes(t));
  if (state.targets.length) return;
  if (state.toRelease > 0) {
    state.nextReleaseAt ??= now + RELEASE_GAP_MS;
    if (now >= state.nextReleaseAt) release(state);
  } else endRound(state);
}

function tickRange(state: State, dt: number, now: number): void {
  if (state.phase !== 'playing') return;
  const gone = stepTargets(state.targets, dt, now, state.aspect, true);
  state.targets = state.targets.filter((t) => !gone.includes(t) && !(t.state === 'hit' && t.y > 1.2));
  const want = state.range.kind === 'sweep' ? 2 : 3;
  const flying = state.targets.filter((t) => t.state === 'fly').length;
  if (flying < want) {
    state.nextReleaseAt ??= now + (state.range.kind === 'popup' ? 400 : 250);
    if (now >= state.nextReleaseAt) {
      state.targets.push(spawnRangeTarget(state.nextId++, state.range.kind, state.range.speed, now, state.aspect, state.random));
      state.nextReleaseAt = null;
    }
  }
}

export interface SkyShotOptions {
  /** Seed for target paths (tests pass one; the server uses the clock). */
  seed?: number;
}

/** The game, for `playGame` in tests with a fixed seed. */
export function skyShot(opts: SkyShotOptions = {}) {
  return defineGame<State, ServerEvent, Snapshot>({
    tickHz: TICK_HZ,
    maxPlayers: 3,
    maxSeatsPerUser: 3,
    // A phone sends ~62 inputs a second; leave room for jitter.
    inputsPerSecond: 90,
    eventsPerSecond: 30,

    init: (room) => {
      const tuning = { ...DEFAULT_TUNING };
      const state: State = {
        room,
        startedAt: Date.now(),
        random: rng(opts.seed ?? Date.now()),
        tuning,
        cfg: configId(tuning),
        configs: {},
        mode: 'rounds',
        phase: 'ready',
        paused: false,
        aspect: 16 / 9,
        screen: null,
        screenLag: DEFAULT_SCREEN_LAG_MS,
        screenRtt: 0,
        guns: new Map(),
        targets: [],
        history: new TargetHistory(),
        nextId: 1,
        round: 0,
        quota: 0,
        roundHits: 0,
        roundShots: 0,
        toRelease: 0,
        wave: 0,
        shotsLeft: 0,
        nextReleaseAt: null,
        phaseUntil: 0,
        passed: false,
        score: 0,
        gameShots: 0,
        gameHits: 0,
        shooter: null,
        games: [],
        shots: [],
        dropped: 0,
        pending: [],
        stats: {},
        range: { kind: 'static', speed: 1 },
      };
      return state;
    },

    onJoin(state, player) {
      const kind = seatKind(player.device);
      if (kind === 'screen') state.screen = player.id;
      else if (kind === 'gun' || kind === 'mouse') addGun(state, player, kind === 'mouse');
      state.room.send(player.id, { tuning: { tuning: state.tuning, id: state.cfg } });
      state.room.send(player.id, { stats: publicStats(state) });
    },

    onLeave(state, player) {
      if (state.screen === player.id) state.screen = null;
      const gun = state.guns.get(player.id);
      if (gun) {
        state.pending = state.pending.filter((p) => p.gun !== gun);
        state.guns.delete(player.id);
      }
    },

    onInput(state, player, input) {
      const gun = state.guns.get(player.id);
      if (gun && input && typeof input === 'object') onGunInput(state, gun, input as Partial<GunInput>);
    },

    onEvent(state, player, event) {
      if (!event || typeof event !== 'object') return;
      const e = event as Record<string, unknown>;
      const gun = state.guns.get(player.id);
      if (gun) {
        const now = state.room.elapsedMs;
        if ('shot' in e && e.shot && typeof e.shot === 'object' && (gun.mouse || state.tuning.trigger === 'tap')) {
          const t = (e.shot as { t?: unknown }).t;
          const at = fin(t) && t >= 0 ? Math.min(now, serverTime(gun, t, now)) : now - gun.rtt / 2;
          if (at - gun.lastShotAt < TAP_DEBOUNCE_MS) return;
          gun.lastShotAt = at;
          fire(state, gun, at, gun.mouse ? 'mouse' : 'tap');
        } else if ('calibrate' in e) gun.aim.calibrate();
        return;
      }
      if (player.id === state.screen) onScreenEvent(state, e);
    },

    tick(state, dt) {
      const now = state.room.elapsedMs;
      settleShots(state);
      if (state.paused && state.mode === 'rounds') {
        // Frozen: push every deadline back by the time that passed.
        const ms = dt * 1000;
        for (const t of state.targets) t.until += ms;
        if (state.nextReleaseAt !== null) state.nextReleaseAt += ms;
        state.phaseUntil += ms;
        for (const t of state.targets) t.born += ms;
      } else if (state.mode === 'rounds') tickRounds(state, dt, now);
      else tickRange(state, dt, now);
      state.history.record(now, state.targets);
    },

    snapshot(state, forPlayer) {
      const g: GunView[] = [...state.guns.values()].map((gun) => {
        const c = gun.aim.current;
        return { id: gun.seat.id, c: gun.color, x: r3(c.x), y: r3(c.y), rx: r3(c.rx), ry: r3(c.ry), on: true, m: gun.mouse };
      });
      const snap: Snapshot = {
        ph: state.phase,
        m: state.mode,
        pz: state.paused,
        tg: state.targets.map((t) => targetView(t, state.aspect)),
        g,
        sc: state.score,
        rd: state.round,
        sl: state.shotsLeft,
        h: state.roundHits,
        q: state.quota,
        left: state.toRelease,
        cfg: state.cfg,
      };
      if (forPlayer.id === state.screen) {
        const first = [...state.guns.values()][0];
        snap.lat = { gun: Math.round(first?.rtt ?? 0), screen: Math.round(state.screenRtt), pix: Math.round((first?.rtt ?? 0) / 2 + state.screenLag), lag: Math.round(state.screenLag) };
        const last = first?.samples[first.samples.length - 1]?.s;
        if (last) {
          const e = toEuler(last.q);
          snap.mo = { yaw: r3(e.yaw), pitch: r3(e.pitch), roll: r3(e.roll), r: last.r.map(r3) as Vec3, a: r3(Math.hypot(...last.a)) };
        }
      }
      return snap;
    },

    results: (state) => buildResults(state),
  });
}

export default skyShot();
