import { describe, expect, it } from 'vitest';
import type { MotionSample } from '@stacks/native';
import { HISTORY_S, LATE_MS, MotionStats } from '../web/src/motion/stats';
import { dragToTilt, isTiltKey, keysToTilt, relative, tiltFromAttitude, ZERO } from '../web/src/motion/tilt';

const samples = (from: number, n: number, hz: number): MotionSample[] => Array.from({ length: n }, (_, i) => ({ t: from + i / hz }));

describe('MotionStats', () => {
  it('measures the rate by the samples’ own clock and the samples per batch', () => {
    const s = new MotionStats(100);
    let at = 0;
    // Two seconds at 100 Hz in 60 batches a second (1-2 samples each).
    for (let i = 0, t = 0; t < 200; i++) {
      const n = i % 3 === 2 ? 1 : 2;
      s.add({ samples: samples(t / 100, n, 100) }, (at += 1000 / 60));
      t += n;
    }
    const snap = s.snapshot();
    expect(snap.hz).toBeGreaterThanOrEqual(99);
    expect(snap.hz).toBeLessThanOrEqual(101);
    expect(snap.perBatch).toBeCloseTo(1.7, 0);
    expect(snap).toMatchObject({ late: 0, dropped: 0, total: 200 });
  });

  it('counts late batches and dropped samples', () => {
    const s = new MotionStats(100);
    s.add({ samples: samples(0, 2, 100) }, 0);
    s.add({ samples: samples(0.02, 2, 100) }, 16);
    s.add({ samples: samples(0.1, 2, 100) }, 16 + LATE_MS + 1); // 0.03 .. 0.09 missing: 6 samples, and late
    expect(s.snapshot()).toMatchObject({ late: 1, dropped: 6, total: 6, batches: 3 });
  });

  it('keeps five seconds of history and ignores empty batches', () => {
    const s = new MotionStats(10);
    s.add({ samples: [] }, 0);
    for (let i = 0; i < 80; i++) s.add({ samples: [{ t: i / 10 }] }, i * 100);
    expect(s.history[0]!.t).toBeGreaterThanOrEqual(7.9 - HISTORY_S - 1e-9);
    expect(s.latest!.t).toBeCloseTo(7.9);
    expect(s.snapshot().hz).toBe(10);
    expect(new MotionStats(60).snapshot()).toMatchObject({ hz: 0, perBatch: 0 });
  });

  it('scales up the first second', () => {
    const s = new MotionStats(100);
    s.add({ samples: samples(0, 51, 100) }, 0); // half a second
    expect(s.snapshot().hz).toBe(100);
  });
});

describe('tilt', () => {
  it('rolls things down the screen when the top is raised, and right when the right edge drops', () => {
    expect(tiltFromAttitude({ roll: 0, pitch: Math.PI / 6, yaw: 0 }).y).toBeCloseTo(0.5);
    expect(tiltFromAttitude({ roll: Math.PI / 6, pitch: 0, yaw: 0 }).x).toBeCloseTo(0.5);
    expect(tiltFromAttitude(ZERO).x).toBeCloseTo(0);
    expect(tiltFromAttitude(ZERO).y).toBeCloseTo(0);
  });

  it('is relative to Zero, wrapping round', () => {
    const r = relative({ roll: 0.1, pitch: 0.5, yaw: -3.1 }, { roll: 0.1, pitch: 0.2, yaw: 3.1 });
    expect(r.roll).toBeCloseTo(0);
    expect(r.pitch).toBeCloseTo(0.3);
    expect(r.yaw).toBeCloseTo(2 * Math.PI - 6.2);
  });

  it('turns arrow keys, WASD and drags into a tilt', () => {
    expect(keysToTilt(['ArrowLeft'])).toEqual({ x: -0.5, y: 0 });
    expect(keysToTilt(['w', 'd'])).toEqual({ x: 0.5, y: -0.5 });
    expect(keysToTilt(['ArrowLeft', 'ArrowRight', 'q'])).toEqual({ x: 0, y: 0 });
    expect([isTiltKey('ArrowUp'), isTiltKey('S'), isTiltKey('Enter')]).toEqual([true, true, false]);
    expect(dragToTilt(50, -400, 200)).toEqual({ x: 0.5, y: -1 });
  });
});
