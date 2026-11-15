import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getNative, installFakeNative, NativeError, PROTOCOL, versionAtLeast, type Calls } from '../src/index';

const protocol = JSON.parse(readFileSync(join(__dirname, '../../../native/protocol/v1.json'), 'utf8'));

describe('the protocol file', () => {
  it('matches what this package speaks', () => {
    expect(protocol.protocol).toBe(PROTOCOL);
    const names: (keyof Calls)[] = [
      'app.info', 'auth.apple', 'auth.google', 'auth.signedOut', 'badge.set', 'push.register', 'push.saveDevice', 'push.status', 'share',
      'haptics.impact', 'haptics.notification', 'haptics.pattern', 'motion.start', 'motion.stop', 'screen.immersive', 'screen.keepAwake', 'screen.lockOrientation',
    ];
    expect(Object.keys(protocol.calls).sort()).toEqual([...names].sort());
    expect(protocol.global.example.calls.sort()).toEqual([...names].sort());
    expect(protocol.errorCodes).toEqual(['unsupported', 'forbidden', 'cancelled', 'failed']);
  });

  it("sends the protocol's request and reads its replies", async () => {
    const g: Record<string, unknown> = {};
    const sent: unknown[] = [];
    g.stacksNative = {
      ...protocol.global.example,
      call: async (name: string, args: unknown) => {
        sent.push({ v: 1, name, args });
        return name === 'share' ? protocol.envelope.ok : protocol.envelope.error;
      },
    };
    const n = getNative(g);
    await expect(n.call('share', protocol.calls.share.args)).resolves.toEqual(protocol.calls.share.result);
    expect(sent[0]).toEqual({ ...protocol.envelope.request, args: protocol.calls.share.args });
    await expect(n.call('app.info')).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('getNative', () => {
  it('is unavailable in a browser, and says so without throwing', async () => {
    const n = getNative({});
    expect([n.available, n.platform, n.version, n.has('auth.google')]).toEqual([false, null, null, false]);
    await expect(n.call('auth.google')).rejects.toEqual(new NativeError('unsupported', '"auth.google" needs the Stacks app'));
  });

  it('ignores an app speaking another protocol', () => {
    expect(getNative({ stacksNative: { protocol: 2, platform: 'ios', version: '9', calls: ['share'], call: async () => ({ ok: true, result: {} }) } }).available).toBe(false);
  });

  it('calls the app and turns its errors into NativeErrors', async () => {
    const g: Record<string, unknown> = {};
    const fake = installFakeNative(
      {
        'auth.google': () => ({ credential: 'tok' }),
        'app.info': () => {
          throw new NativeError('forbidden', 'Not from this page');
        },
      },
      g,
    );
    const n = getNative(g);
    expect([n.available, n.has('auth.google'), n.has('share')]).toEqual([true, true, false]);
    await expect(n.call('auth.google')).resolves.toEqual({ credential: 'tok' });
    await expect(n.call('app.info')).rejects.toMatchObject({ code: 'forbidden' });
    expect(fake.log.map((l) => l.name)).toEqual(['auth.google', 'app.info']);
    fake.remove();
    expect(n.available).toBe(false);
  });

  it('shares through the app, else navigator.share, else not at all', async () => {
    const g: Record<string, any> = {};
    installFakeNative({ share: () => ({ completed: true }) }, g);
    await expect(getNative(g).share({ url: 'https://x' })).resolves.toEqual({ completed: true });

    const shared: unknown[] = [];
    const web = { navigator: { share: async (d: unknown) => void shared.push(d) } };
    await expect(getNative(web as never).share({ url: 'https://y' })).resolves.toEqual({ completed: true });
    expect(shared).toEqual([{ url: 'https://y' }]);
    const cancelled = { navigator: { share: async () => Promise.reject(Object.assign(new Error('no'), { name: 'AbortError' })) } };
    await expect(getNative(cancelled as never).share({})).resolves.toEqual({ completed: false });
    await expect(getNative({ navigator: {} } as never).share({})).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('versionAtLeast', () => {
  it('compares versions as numbers', () => {
    expect(versionAtLeast('1.10.0', '1.2.0')).toBe(true);
    expect(versionAtLeast('1.0.0', '1.0.1')).toBe(false);
    expect(versionAtLeast('2', '1.9.9')).toBe(true);
    expect(versionAtLeast('1.0', '1.0.0')).toBe(true);
  });
});
