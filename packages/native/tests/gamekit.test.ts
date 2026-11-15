import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fakeGameKit,
  fakeMotion,
  getNative,
  gravityFor,
  installFakeNative,
  MOTION_SENSORS,
  NativeError,
  sampleFromWeb,
  type MotionBatch,
} from '../src/index';

const protocol = JSON.parse(readFileSync(join(__dirname, '../../../native/protocol/v1.json'), 'utf8'));
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.useRealTimers());

describe('the Game kit in the protocol file', () => {
  it('names a capability for every app call, and only for those', () => {
    for (const [name, call] of Object.entries<{ origins: string; capability?: string }>(protocol.calls)) {
      if (call.origins === 'app') expect(['haptics', 'motion', 'screen'], name).toContain(call.capability);
      else expect(call.capability, name).toBeUndefined();
    }
    expect(Object.keys(protocol.origins).sort()).toEqual(['any', 'app', 'auth']);
  });

  it("documents the motion batch this package reads, in CoreMotion's units", () => {
    const [s] = protocol.events.motion.samples;
    expect(Object.keys(s).sort()).toEqual(['t', ...MOTION_SENSORS].sort());
    const g = gravityFor(s.attitude);
    expect(g.y).toBeCloseTo(s.gravity.y, 1);
    expect(g.z).toBeCloseTo(s.gravity.z, 1);
  });
});

describe('native.motion', () => {
  it('streams batches from the app on the channel it gives, and stops it', async () => {
    const g: Record<string, any> = {};
    const fake = installFakeNative(
      { 'motion.start': (a) => ({ channel: 'm1', hz: a.hz }), 'motion.stop': () => ({}) },
      g,
    );
    const n = getNative(g);
    expect(n.motion.source).toBe('native');
    const got: MotionBatch[] = [];
    const stop = n.motion.start({ hz: 250 }, (b) => got.push(b));
    expect(stop.source).toBe('native');
    await expect(stop.ready).resolves.toEqual({ hz: 100 }); // clamped
    expect(fake.log[0]).toEqual({ name: 'motion.start', args: { hz: 100, sensors: [...MOTION_SENSORS] } });
    fake.emit('m1', protocol.events.motion);
    fake.emit('other', { samples: [] });
    expect(got).toEqual([protocol.events.motion]);
    stop();
    fake.emit('m1', protocol.events.motion);
    expect(got).toHaveLength(1);
    await tick();
    expect(fake.log.at(-1)).toEqual({ name: 'motion.stop', args: { channel: 'm1' } });
  });

  it('stops a stream that was stopped before it started', async () => {
    const g: Record<string, any> = {};
    const fake = installFakeNative({ 'motion.start': () => ({ channel: 'm1', hz: 60 }), 'motion.stop': () => ({}) }, g);
    const stop = getNative(g).motion.start({}, () => {});
    stop();
    await stop.ready;
    await tick();
    expect(fake.log.map((l) => l.name)).toEqual(['motion.start', 'motion.stop']);
  });

  it("reports the app's refusal (an app that didn't declare motion)", async () => {
    const g: Record<string, any> = {};
    installFakeNative(
      {
        'motion.start': () => {
          throw new NativeError('forbidden', 'Gyro Gym has not declared "motion"');
        },
      },
      g,
    );
    const onError = vi.fn();
    const stop = getNative(g).motion.start({ onError }, () => {});
    await expect(stop.ready).rejects.toMatchObject({ code: 'forbidden' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'forbidden' }));
  });

  it('says there is nothing to read without the app or motion events', async () => {
    const n = getNative({});
    expect(n.motion.source).toBe('none');
    const stop = n.motion.start({}, () => {});
    expect(stop.source).toBe('none');
    await expect(stop.ready).rejects.toMatchObject({ code: 'unsupported' });
    await expect(n.motion.requestPermission()).resolves.toBe('unsupported');
    // Asking for the app's sensors in a browser that has its own: none, not the browser's.
    expect(getNative(webGlobal().g).motion.start({ source: 'native' }, () => {}).source).toBe('none');
  });

  it('falls back to DeviceMotionEvent, batched per frame, at most hz samples a second', async () => {
    const { g, fire } = webGlobal();
    const n = getNative(g);
    expect(n.motion.source).toBe('web');
    const got: MotionBatch[] = [];
    const stop = n.motion.start({ hz: 50 }, (b) => got.push(b));
    expect(stop.source).toBe('web');
    fire('deviceorientation', { alpha: 90, beta: 45, gamma: -30 });
    for (let i = 0; i < 10; i++) fire('devicemotion', motionEvent(1000 + i * 10)); // 100 Hz in, 50 Hz out
    g.runFrames();
    expect(got).toHaveLength(1);
    expect(got[0]!.samples).toHaveLength(5);
    const s = got[0]!.samples[0]!;
    expect(s.t).toBe(0);
    expect(s.gravity!.z).toBeCloseTo(-1);
    expect(s.attitude!.pitch).toBeCloseTo(Math.PI / 4);
    expect(s.attitude!.roll).toBeCloseTo(-Math.PI / 6);
    expect(s.rotationRate!.x).toBeCloseTo(Math.PI); // beta 180 deg/s
    stop();
    expect(g.listeners.devicemotion.size).toBe(0);
    expect(g.listeners.deviceorientation.size).toBe(0);
  });

  it('keeps only the asked-for sensors', () => {
    const { g, fire } = webGlobal();
    const got: MotionBatch[] = [];
    getNative(g).motion.start({ sensors: ['gravity'] }, (b) => got.push(b));
    fire('devicemotion', motionEvent(5));
    g.runFrames();
    expect(Object.keys(got[0]!.samples[0]!).sort()).toEqual(['gravity', 't']);
  });

  it("asks iOS Safari's permission for motion and orientation", async () => {
    const { g } = webGlobal();
    g.DeviceMotionEvent = { requestPermission: vi.fn(async () => 'granted') };
    g.DeviceOrientationEvent = { requestPermission: vi.fn(async () => 'granted') };
    await expect(getNative(g).motion.requestPermission()).resolves.toBe('granted');
    g.DeviceOrientationEvent.requestPermission = async () => 'denied';
    await expect(getNative(g).motion.requestPermission()).resolves.toBe('denied');
    g.DeviceMotionEvent.requestPermission = async () => Promise.reject(new Error('needs a tap'));
    await expect(getNative(g).motion.requestPermission()).resolves.toBe('denied');
  });

  it("asks the browser for its sensors inside the app when told to, and never for the app's", async () => {
    const { g } = webGlobal();
    const ask = vi.fn(async () => 'granted');
    g.DeviceMotionEvent = { requestPermission: ask };
    installFakeNative({ 'motion.start': () => ({ channel: 'm1', hz: 60 }) }, g);
    const n = getNative(g);
    expect(n.motion.source).toBe('native');
    // The app's sensors (auto or native) never ask: this is what made "compare with the browser" silent.
    await expect(n.motion.requestPermission()).resolves.toBe('granted');
    await expect(n.motion.requestPermission({ source: 'native' })).resolves.toBe('granted');
    expect(ask).not.toHaveBeenCalled();
    await expect(n.motion.requestPermission({ source: 'web' })).resolves.toBe('granted');
    expect(ask).toHaveBeenCalledTimes(1);
    ask.mockResolvedValueOnce('denied');
    await expect(n.motion.requestPermission({ source: 'web' })).resolves.toBe('denied');
    // Outside the app there are no app sensors to grant.
    await expect(getNative(webGlobal().g).motion.requestPermission({ source: 'native' })).resolves.toBe('unsupported');
  });
});

describe('sampleFromWeb', () => {
  it("turns the web's m/s² and deg/s into CoreMotion's g and rad/s", () => {
    const s = sampleFromWeb(
      { timeStamp: 1500, acceleration: { x: 9.80665, y: 0, z: 0 }, accelerationIncludingGravity: { x: 9.80665, y: 0, z: 9.80665 }, rotationRate: { alpha: 0, beta: 0, gamma: 90 } },
      null,
      1000,
    );
    expect(s.t).toBe(0.5);
    expect(s.userAcceleration!.x).toBeCloseTo(-1);
    expect(s.gravity).toEqual({ x: -0, y: -0, z: -1 });
    expect(s.rotationRate!.y).toBeCloseTo(Math.PI / 2);
    expect(s.attitude!.roll).toBeCloseTo(0); // from gravity, without an orientation event
  });

  it('copes with missing fields (desktop browsers send nulls)', () => {
    const s = sampleFromWeb({ timeStamp: 0, acceleration: null, accelerationIncludingGravity: null, rotationRate: null }, null, 0);
    expect(s.userAcceleration).toEqual({ x: -0, y: -0, z: -0 });
    expect(s.gravity).toBeUndefined();
  });
});

describe('fakeMotion', () => {
  it('emits about hz samples a second in ~60 batches, tilted by set()', async () => {
    let now = 0;
    let fire: () => void = () => {};
    const motion = fakeMotion({ now: () => now, setInterval: (fn) => ((fire = fn), 1), clearInterval: () => (fire = () => {}) });
    const g: Record<string, any> = {};
    installFakeNative({ ...motion.handlers }, g);
    const got: MotionBatch[] = [];
    const stop = getNative(g).motion.start({ hz: 100 }, (b) => got.push(b));
    await stop.ready;
    motion.set({ pitch: Math.PI / 2 });
    for (let i = 0; i < 60; i++) {
      now += 1000 / 60;
      fire();
    }
    const samples = got.flatMap((b) => b.samples);
    expect(samples.length).toBeGreaterThanOrEqual(99);
    expect(samples.length).toBeLessThanOrEqual(100);
    expect(samples.at(-1)!.gravity!.y).toBeCloseTo(-1);
    expect(motion.running).toBe(true);
    stop();
    await tick();
    expect(motion.running).toBe(false);
  });

  it('wobbles on its own until set, then holds for 2 s', () => {
    let now = 10_000;
    const motion = fakeMotion({ wobble: true, now: () => now });
    expect(motion.attitude.roll).not.toBe(0);
    motion.set({ roll: 0.1, pitch: 0 });
    expect(motion.attitude.roll).toBe(0.1);
    now += 2500;
    expect(motion.attitude.roll).not.toBe(0.1);
  });
});

describe('native.haptics and native.screen', () => {
  it('go to the app when it has them', async () => {
    const g: Record<string, any> = {};
    const fake = installFakeNative(fakeGameKit(), g);
    const n = getNative(g);
    await n.haptics.impact('heavy');
    await n.haptics.notification('success');
    await n.haptics.pattern([{ t: 0, intensity: 1, sharpness: 1 }]);
    await n.screen.lockOrientation('portrait');
    await n.screen.immersive(true);
    await n.screen.keepAwake(true);
    expect(fake.log).toEqual([
      { name: 'haptics.impact', args: { style: 'heavy' } },
      { name: 'haptics.notification', args: { type: 'success' } },
      { name: 'haptics.pattern', args: { events: [{ t: 0, intensity: 1, sharpness: 1 }] } },
      { name: 'screen.lockOrientation', args: { orientation: 'portrait' } },
      { name: 'screen.immersive', args: { on: true } },
      { name: 'screen.keepAwake', args: { on: true } },
    ]);
  });

  it('pass on the app refusing them', async () => {
    const g: Record<string, any> = {};
    installFakeNative({ 'haptics.impact': () => Promise.reject(new NativeError('forbidden', 'not declared')) }, g);
    await expect(getNative(g).haptics.impact()).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('check a pattern fits before sending it', async () => {
    const n = getNative({});
    await expect(n.haptics.pattern(Array.from({ length: 33 }, (_, i) => ({ t: i / 100, intensity: 1, sharpness: 1 })))).rejects.toMatchObject({ code: 'failed' });
    await expect(n.haptics.pattern([{ t: 4.9, intensity: 1, sharpness: 1, duration: 0.2 }])).rejects.toMatchObject({ code: 'failed' });
  });

  it('use the browser where it can, and never throw for haptics', async () => {
    const vibrate = vi.fn(() => true);
    const lock = vi.fn(async () => {});
    const release = vi.fn(async () => {});
    const g: Record<string, any> = { navigator: { vibrate, wakeLock: { request: async () => ({ release }) } }, screen: { orientation: { lock, unlock: vi.fn() } } };
    const n = getNative(g);
    await n.haptics.impact('heavy');
    await n.haptics.pattern([{ t: 0, intensity: 1, sharpness: 1, duration: 0.1 }, { t: 0.3, intensity: 1, sharpness: 1 }]);
    expect(vibrate.mock.calls).toEqual([[40], [[100, 200, 20]]]);
    await n.screen.lockOrientation('landscape');
    expect(lock).toHaveBeenCalledWith('landscape');
    await n.screen.keepAwake(true);
    await n.screen.keepAwake(false);
    expect(release).toHaveBeenCalled();
    await expect(n.screen.immersive(true)).rejects.toMatchObject({ code: 'unsupported' });

    const bare = getNative({});
    await expect(bare.haptics.impact()).resolves.toBeUndefined();
    await expect(bare.screen.keepAwake(true)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(bare.screen.lockOrientation('portrait')).rejects.toMatchObject({ code: 'unsupported' });
  });
});

function motionEvent(timeStamp: number) {
  return {
    timeStamp,
    acceleration: { x: 0, y: 0, z: 0 },
    accelerationIncludingGravity: { x: 0, y: 0, z: 9.80665 },
    rotationRate: { alpha: 0, beta: 180, gamma: 0 },
  };
}

function webGlobal() {
  const listeners: Record<string, Set<(e: unknown) => void>> = { devicemotion: new Set(), deviceorientation: new Set() };
  let frames: (() => void)[] = [];
  const g: Record<string, any> = {
    listeners,
    DeviceMotionEvent: function DeviceMotionEvent() {},
    addEventListener: (t: string, fn: (e: unknown) => void) => listeners[t]?.add(fn),
    removeEventListener: (t: string, fn: (e: unknown) => void) => listeners[t]?.delete(fn),
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    cancelAnimationFrame: () => {},
    runFrames: () => {
      const run = frames;
      frames = [];
      for (const fn of run) fn();
    },
  };
  const fire = (t: string, e: unknown) => listeners[t]?.forEach((fn) => fn(e));
  return { g, fire };
}
