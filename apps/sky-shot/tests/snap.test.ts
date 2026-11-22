import { describe, expect, it } from 'vitest';
import { playGame, type TestPlayer } from '@stacks/testing';
import { screenPoint, screenRays, type PretendScreen } from '@stacks/native';
import { fromEuler } from '../game/aim';
import type { Quat, ServerEvent, Snapshot, Vec3, WireSample } from '../game/protocol';
import { skyShot } from '../game/server';
import { codePayloads, codeSpots, fitSnap, NO_NUDGE, nudge, NUDGE_MAX_GAIN, NUDGE_MAX_OFFSET, readSnapped, withNudge, type Snapped } from '../game/snap';
import { DEFAULT_TUNING } from '../game/tuning';

const ASPECT = 16 / 9;
const ANN = 'ann@test.dev';
const BOB = 'bob@test.dev';
const PISTOL = Math.PI / 2;
/** Held up like a camera, facing the way the screen is. */
const CAMERA = { roll: 0, pitch: Math.PI / 2, yaw: 0 };

const TV: PretendScreen = { yaw: 0.1, pitch: 0.05, widthRad: (31 * Math.PI) / 180, aspect: ASPECT };
const LAPTOP: PretendScreen = { yaw: -0.2, pitch: -0.15, widthRad: (40 * Math.PI) / 180, aspect: ASPECT };

/** What the phone sends after `native.camera.locate` saw `screen` (codes where the screen draws them). */
function snapOf(screen: PretendScreen, att = CAMERA): Snapped {
  const codes = codePayloads('test');
  const spots = codeSpots(screen.aspect);
  const r = screenRays(
    screen,
    codes.map((code, i) => ({ code, x: spots[i]![0], y: spots[i]![1] })),
    att,
  );
  return { rays: codes.map((c) => [r.found[c]!.centre.x, r.found[c]!.centre.y, r.found[c]!.centre.z] as Vec3), att };
}

/** The pose whose barrel (top edge) points at (x, y) on `screen`, in a grip (`roll`: 0 flat, π/2 pistol). */
function aimAt(screen: PretendScreen, x: number, y: number, roll = PISTOL): Quat {
  const d = screenPoint(screen, x, y);
  return fromEuler(roll, Math.asin(d.z), Math.atan2(-d.x, d.y));
}

describe('reading the screen from a snap', () => {
  it('gets the gain and vertical ratio a TV and a laptop need, whatever way the phone is held up', () => {
    for (const screen of [TV, LAPTOP]) {
      for (const att of [CAMERA, { roll: 0.2, pitch: 1.3, yaw: -0.3 }]) {
        const fit = fitSnap(snapOf(screen, att), ASPECT)!;
        expect(fit).toBeTruthy();
        // About one screen width per the screen's angular width (a flat screen: a little less at its edges).
        expect(fit.gain * screen.widthRad).toBeGreaterThan(0.95);
        expect(fit.gain * screen.widthRad).toBeLessThan(1.05);
        expect(fit.ratioY).toBeGreaterThan(0.95);
        expect(fit.ratioY).toBeLessThan(1.08);
      }
    }
  });

  it('refuses what is not a snap, or not a plausible screen', () => {
    expect(readSnapped(null)).toBeNull();
    expect(readSnapped({ rays: [[0, 0, -1]], att: CAMERA })).toBeNull();
    expect(readSnapped({ rays: Array(4).fill([0, 0, -3]), att: CAMERA })).toBeNull();
    expect(readSnapped({ rays: Array(4).fill([0, 0, -1]), att: { roll: 0, pitch: 'x', yaw: 0 } })).toBeNull();
    // Every code in the same place: no screen.
    expect(fitSnap(readSnapped({ rays: Array(4).fill([0, 0, -1]), att: CAMERA })!, ASPECT)).toBeNull();
    // A screen 2° wide is a mistake (a far-off poster, a reflection).
    expect(fitSnap(snapOf({ ...TV, widthRad: 0.035 }), ASPECT)).toBeNull();
  });
});

describe('camera calibration in a room', () => {
  function room() {
    const g = playGame(skyShot({ seed: 1 }), { maxPlayers: 3 });
    const screen = g.join(ANN, { device: 'screen' }) as TestPlayer<Snapshot>;
    screen.event({ view: { aspect: ASPECT } });
    screen.event({ tune: { mode: 'absolute' } });
    const phones: { p: TestPlayer<Snapshot>; pose: Quat; seq: number; recent: WireSample[] }[] = [];
    const add = (who: string, device: string) => {
      const ph = { p: g.join(who, { device }) as TestPlayer<Snapshot>, pose: aimAt(TV, 0.5, 0.5), seq: 0, recent: [] as WireSample[] };
      phones.push(ph);
      return ph;
    };
    const run = (ms: number) => {
      const end = g.now + ms;
      while (g.now < end) {
        for (const ph of phones) {
          ph.recent.push({ t: g.now / 1000, q: ph.pose, r: [0, 0, 0.3], a: [0, 0, 0] });
          if (ph.recent.length > 8) ph.recent.shift();
          ph.p.input({ seq: ++ph.seq, t: g.now / 1000, rtt: 0, samples: [...ph.recent] });
        }
        g.advance(16);
      }
    };
    const calibrated = () => (screen.events as ServerEvent[]).flatMap((e) => ('calibrated' in e ? [e.calibrated] : []));
    return { g, screen, add, run, calibrated };
  }

  it('snap, then one centre tap in your grip: the crosshair lands where the phone points, on a TV and a laptop', () => {
    for (const [screenGeo, roll] of [
      [TV, PISTOL],
      [LAPTOP, 0],
    ] as const) {
      const t = room();
      const ann = t.add(ANN, 'gun');
      t.run(100);
      const sn = t.screen.state!.sn!;
      expect(sn.guns).toEqual([{ gun: ann.p.id, st: 'snap' }]);
      expect(sn.codes).toHaveLength(4);
      expect(t.screen.state!.cal).toBeUndefined();
      ann.p.event({ menu: { snapped: snapOf(screenGeo) } });
      t.run(50);
      expect(t.screen.state!.sn!.guns).toEqual([{ gun: ann.p.id, st: 'tap' }]);
      // Back in the grip, aiming at the centre (a little off, as a real hand is), and tap.
      ann.pose = aimAt(screenGeo, 0.5, 0.5, roll);
      t.run(400);
      ann.p.event({ calibrate: { t: t.g.now / 1000 } });
      t.run(50);
      expect(t.screen.state!.sn).toBeUndefined();
      expect(t.calibrated()).toEqual([expect.objectContaining({ seat: ann.p.id, stage: 'snap', poor: false })]);
      for (const [x, y] of [
        [0.5, 0.5],
        [0.1, 0.12],
        [0.9, 0.12],
        [0.9, 0.88],
        [0.1, 0.88],
        [0.3, 0.7],
      ] as const) {
        ann.pose = aimAt(screenGeo, x, y, roll);
        t.run(1500);
        const c = t.screen.state!.g[0]!;
        // The aim maps heading and elevation linearly; a flat screen's perspective puts the far
        // corners up to ~2% of the height off (the centre is exact). A homography would close that.
        const within = x === 0.5 && y === 0.5 ? 0.005 : 0.025;
        expect(Math.abs(c.x - x), `x at ${x},${y}`).toBeLessThan(within);
        expect(Math.abs(c.y - y), `y at ${x},${y}`).toBeLessThan(within);
      }
    }
  });

  it('several phones snap at once; the game starts once all are done', () => {
    const t = room();
    const ann = t.add(ANN, 'gun');
    const bob = t.add(BOB, 'gun-2');
    t.run(100);
    expect(t.screen.state!.sn!.guns.map((g) => g.st)).toEqual(['snap', 'snap']);
    ann.p.event({ menu: { snapped: snapOf(TV) } });
    bob.p.event({ menu: { snapped: snapOf(TV) } });
    t.run(50);
    expect(t.screen.state!.sn!.guns.map((g) => g.st)).toEqual(['tap', 'tap']);
    ann.p.event({ calibrate: { t: t.g.now / 1000 } });
    t.run(50);
    // Bob isn't done: Start waits.
    ann.p.event({ menu: { start: true } });
    t.run(50);
    expect(t.screen.state!.ph).toBe('ready');
    bob.p.event({ shot: { t: t.g.now / 1000 } });
    t.run(50);
    expect(t.screen.state!.sn).toBeUndefined();
    expect(t.calibrated().map((c) => c.seat)).toEqual([ann.p.id, bob.p.id]);
    ann.p.event({ menu: { start: true } });
    t.run(50);
    expect(t.screen.state!.ph).toBe('playing');
  });

  it('falls back to the dots (step 1 on connect, step 2 on Re-calibrate); a bad snap or Snap again goes back to snapping', () => {
    const t = room();
    const ann = t.add(ANN, 'gun');
    t.run(100);
    ann.p.event({ menu: { snapped: { rays: Array(4).fill([0, 0, -1]), att: CAMERA } } });
    t.run(50);
    expect(t.screen.events).toContainEqual({ calibrationFailed: { reason: expect.stringMatching(/Couldn't read the screen/), seat: ann.p.id } });
    expect(t.screen.state!.sn!.guns).toEqual([{ gun: ann.p.id, st: 'snap' }]);
    ann.p.event({ menu: { snapped: snapOf(TV) } });
    t.run(50);
    ann.p.event({ menu: { calRedo: true } });
    t.run(50);
    expect(t.screen.state!.sn!.guns).toEqual([{ gun: ann.p.id, st: 'snap' }]);
    ann.p.event({ menu: { calDots: true } });
    t.run(50);
    expect(t.screen.state!.sn).toBeUndefined();
    expect(t.screen.state!.cal).toMatchObject({ gun: ann.p.id, st: 'init', i: 0 });
    ann.p.event({ menu: { calSkip: true } });
    ann.p.event({ menu: { recalibrate: true } });
    t.run(50);
    expect(t.screen.state!.sn!.guns).toEqual([{ gun: ann.p.id, st: 'snap' }]);
    ann.p.event({ menu: { calDots: true } });
    t.run(50);
    expect(t.screen.state!.cal).toMatchObject({ gun: ann.p.id, st: 'fine' });
  });

  it("a phone that joins mid-game pauses it to snap; taps then calibrate, they don't shoot", () => {
    const t = room();
    const ann = t.add(ANN, 'gun');
    ann.p.event({ menu: { calSkip: true } });
    t.screen.event({ mode: 'range' });
    ann.p.event({ menu: { start: true } });
    t.run(500);
    expect(t.screen.state!.pz).toBe(false);
    const bob = t.add(BOB, 'gun-2');
    t.run(50);
    expect(t.screen.state!.pz).toBe(true);
    bob.p.event({ menu: { snapped: snapOf(TV) } });
    t.run(50);
    bob.p.event({ shot: { t: t.g.now / 1000 } });
    t.run(50);
    expect((t.screen.events as ServerEvent[]).some((e) => 'hit' in e || 'miss' in e)).toBe(false);
    expect(t.screen.state!.pz).toBe(false);
  });
});

describe('the quiet correction from near misses', () => {
  it('moves an absolute offset against the error, in small steps, never past its cap', () => {
    let n = NO_NUDGE;
    n = nudge(n, 'absolute', [0.02, -0.01], [0, 0], ASPECT);
    expect(n.dx).toBeCloseTo(-0.001, 6);
    expect(n.dy).toBeCloseTo(0.0005, 6);
    for (let i = 0; i < 500; i++) n = nudge(n, 'absolute', [0.03, -0.03], [0, 0], ASPECT);
    expect(n.dx).toBeCloseTo(-NUDGE_MAX_OFFSET, 6);
    expect(n.dy).toBeCloseTo(NUDGE_MAX_OFFSET, 6);
    expect(n.gain).toBe(1);
  });

  it('lowers a relative gain after overshooting, raises it after falling short, within its cap', () => {
    const move: [number, number] = [0.3, 0];
    const over = nudge(NO_NUDGE, 'relative', [0.03, 0], move, ASPECT);
    const short = nudge(NO_NUDGE, 'relative', [-0.03, 0], move, ASPECT);
    expect(over.gain).toBeLessThan(1);
    expect(short.gain).toBeGreaterThan(1);
    expect(over.dx).toBe(0);
    // A tiny move says nothing about the gain.
    expect(nudge(NO_NUDGE, 'relative', [0.03, 0], [0.005, 0], ASPECT)).toEqual(NO_NUDGE);
    let n = NO_NUDGE;
    for (let i = 0; i < 500; i++) n = nudge(n, 'relative', [0.2, 0], move, ASPECT);
    expect(n.gain).toBeCloseTo(1 - NUDGE_MAX_GAIN, 6);
  });

  it('sits on top of the tuning (so the config id, and the stats per config, stay put)', () => {
    const t = withNudge(DEFAULT_TUNING, { dx: 0.01, dy: -0.02, gain: 0.9 });
    expect(t.offsetX).toBeCloseTo(DEFAULT_TUNING.offsetX + 0.01, 9);
    expect(t.offsetY).toBeCloseTo(DEFAULT_TUNING.offsetY - 0.02, 9);
    expect(t.sensitivity).toBeCloseTo(DEFAULT_TUNING.sensitivity * 0.9, 9);
    expect(withNudge(DEFAULT_TUNING, null)).toBe(DEFAULT_TUNING);
  });
});
