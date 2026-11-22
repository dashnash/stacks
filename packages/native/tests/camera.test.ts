import { describe, expect, it } from 'vitest';
import { fakeCamera, getNative, installFakeNative, NativeError, screenPoint, screenRays, toDevice, toReference } from '../src/index';

const g = () => ({}) as Record<string, unknown>;
const close = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, d = 1e-9) => {
  expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(d);
};

describe('camera.locate', () => {
  it('is unsupported in a browser and in an app without it', async () => {
    const page = g();
    const n = getNative(page);
    expect(n.camera.available).toBe(false);
    await expect(n.camera.locate({ codes: ['a'] })).rejects.toMatchObject({ code: 'unsupported' });
    installFakeNative({ 'motion.start': () => ({ channel: 'm', hz: 60 }) }, page);
    await expect(n.camera.locate({ codes: ['a'] })).rejects.toBeInstanceOf(NativeError);
  });

  it("passes the app's answer and its errors through", async () => {
    const page = g();
    const cam = fakeCamera();
    const fake = installFakeNative({ ...cam.handlers }, page);
    const n = getNative(page);
    expect(n.camera.available).toBe(true);
    const r = await n.camera.locate({ codes: ['tl', 'tr', 'br', 'bl'], prompt: 'Snap it' });
    expect(Object.keys(r.found)).toEqual(['tl', 'tr', 'br', 'bl']);
    expect(fake.log[0]).toEqual({ name: 'camera.locate', args: { codes: ['tl', 'tr', 'br', 'bl'], prompt: 'Snap it' } });
    expect(cam.calls).toHaveLength(1);
    // Held up facing the screen: the codes are out of the back (-z), top left is up and to the left.
    expect(r.found.tl!.centre.z).toBeLessThan(-0.9);
    expect(r.found.tl!.centre.x).toBeLessThan(0);
    expect(r.found.tl!.centre.y).toBeGreaterThan(0);
    expect(r.found.br!.centre.x).toBeGreaterThan(0);
    expect(r.found.br!.corners).toHaveLength(4);

    installFakeNative(
      {
        'camera.locate': () => {
          throw new NativeError('cancelled', 'Cancelled');
        },
      },
      page,
    );
    await expect(n.camera.locate({ codes: ['a'] })).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('the geometry', () => {
  it('turns directions between the phone and the reference frame and back', () => {
    const a = { roll: 0.3, pitch: 1.1, yaw: -0.7 };
    const v = { x: 0.2, y: -0.5, z: 0.84 };
    close(toReference(a, toDevice(a, v)), v);
    // Upright, the back camera (-z) looks along the horizon, the way the yaw points.
    close(toReference({ roll: 0, pitch: Math.PI / 2, yaw: 0 }, { x: 0, y: 0, z: -1 }), { x: 0, y: 1, z: 0 });
  });

  it('builds what the camera would see of a pretend screen', () => {
    const s = { yaw: 0.2, pitch: 0.1, widthRad: 0.6, aspect: 16 / 9 };
    const centre = screenPoint(s, 0.5, 0.5);
    close(centre, { x: -Math.sin(0.2) * Math.cos(0.1), y: Math.cos(0.2) * Math.cos(0.1), z: Math.sin(0.1) });
    const left = screenPoint(s, 0, 0.5);
    const right = screenPoint(s, 1, 0.5);
    expect(Math.acos(left.x * right.x + left.y * right.y + left.z * right.z)).toBeCloseTo(0.6, 9);
    // Facing it exactly, its centre is straight out of the back.
    const r = screenRays(s, [{ code: 'c', x: 0.5, y: 0.5 }], { roll: 0, pitch: Math.PI / 2 + 0.1, yaw: 0.2 });
    close(r.found.c!.centre, { x: 0, y: 0, z: -1 });
  });
});
