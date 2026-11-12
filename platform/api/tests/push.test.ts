import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apnsJwt, apnsOutcome, apnsPayload, createApnsSender } from '../src/apns';
import { createPlatformHarness } from './helpers';

const tok = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const PHONE = tok(1);
const OWNER_PHONE = tok(2);

describe('devices', () => {
  it('registers the app on a phone with the signed-in session, hands back a secret once, and never shows the token', async () => {
    const h = createPlatformHarness();
    const res = await h.addDevice('ann@test.dev', PHONE);
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^sdv_/);
    expect(res.body.device).toMatchObject({ deviceName: "ann@test.dev's iPhone", env: 'production' });
    const list = await h.call('GET', '/devices', { as: 'ann@test.dev' });
    expect(list.body.devices).toEqual([res.body.device]);
    expect(JSON.stringify(list.body)).not.toContain(PHONE);
    expect(JSON.stringify(await h.store.get(`DEVICE#${res.body.device.id}`, 'DEVICE'))).not.toContain(res.body.secret);
  });

  it('refuses tokens, environments and apps that are not this environment\'s iOS app', async () => {
    const h = createPlatformHarness();
    expect((await h.addDevice('ann@test.dev', 'not-hex')).status).toBe(400);
    expect((await h.addDevice('ann@test.dev', PHONE, { env: 'dev' })).status).toBe(400);
    expect((await h.addDevice('ann@test.dev', PHONE, { bundleId: 'ninja.dashnash.stacks' })).status).toBe(400);
    expect((await h.call('POST', '/devices', { body: { token: PHONE } })).status).toBe(401);
  });

  it('keeps one device per token: registering again refreshes it, and a phone that signs in as someone else moves to them', async () => {
    const h = createPlatformHarness();
    const first = (await h.addDevice('ann@test.dev', PHONE)).body;
    const again = (await h.addDevice('ann@test.dev', PHONE.toUpperCase(), { deviceName: 'Ann (new name)' })).body;
    expect(again.device.id).toBe(first.device.id);
    expect(again.secret).not.toBe(first.secret);
    expect((await h.call('GET', '/devices', { as: 'ann@test.dev' })).body.devices).toEqual([expect.objectContaining({ deviceName: 'Ann (new name)' })]);

    await h.addDevice('bob@test.dev', PHONE);
    expect((await h.call('GET', '/devices', { as: 'ann@test.dev' })).body.devices).toEqual([]);
    expect((await h.call('GET', '/devices', { as: 'bob@test.dev' })).body.devices).toHaveLength(1);
  });

  it('lets people remove their own devices only', async () => {
    const h = createPlatformHarness();
    const id = (await h.addDevice('ann@test.dev', PHONE)).body.device.id;
    expect((await h.call('DELETE', `/devices/${id}`, { as: 'bob@test.dev' })).status).toBe(404);
    expect((await h.call('DELETE', `/devices/${id}`, { as: 'ann@test.dev' })).status).toBe(200);
    expect((await h.call('GET', '/devices', { as: 'ann@test.dev' })).body.devices).toEqual([]);
    // The token is free again.
    expect((await h.addDevice('bob@test.dev', PHONE)).status).toBe(200);
  });

  it('forgets every device when someone signs out everywhere', async () => {
    const h = createPlatformHarness();
    await h.addDevice('ann@test.dev', PHONE);
    await h.call('POST', '/auth/logout', { as: 'ann@test.dev' });
    await h.signIn('ann@test.dev');
    expect((await h.call('GET', '/devices', { as: 'ann@test.dev' })).body.devices).toEqual([]);
  });
});

describe('push', () => {
  it('pushes a request to the approver: app name as title, an absolute link, grouped per app, badge = unread + waiting', async () => {
    const h = createPlatformHarness();
    await h.addDevice('owner@test.dev', OWNER_PHONE);
    await h.authorize('club', 'ann@test.dev');
    expect(h.pushes).toEqual([
      {
        token: OWNER_PHONE,
        device: expect.objectContaining({ env: 'production', bundleId: 'ninja.dashnash.stacks.test' }),
        message: {
          alert: { title: 'Book Club', body: expect.stringContaining('asked for access to Book Club') },
          badge: 2,
          url: 'https://auth.stacks.test/#/admin/access?app=club',
          threadId: 'club',
          category: 'ACCESS_REQUEST',
          actionToken: expect.stringMatching(/^spa_/),
        },
      },
    ]);
    // The inbox keeps the same absolute link.
    expect((await h.call('GET', '/notifications', { as: 'owner@test.dev' })).body.notifications[0].link).toBe('https://auth.stacks.test/#/admin/access?app=club');
  });

  it('tells the requester they are in, and clears the request from every approver\'s badge', async () => {
    const h = createPlatformHarness();
    await h.addDevice('owner@test.dev', OWNER_PHONE);
    await h.addDevice('ann@test.dev', PHONE);
    await h.authorize('club', 'ann@test.dev');
    h.pushes.length = 0;
    await h.setRole('club', 'ann@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } });
    expect(h.pushes.find((p) => p.token === PHONE)?.message).toEqual({
      alert: { title: 'Book Club', body: 'You now have access to Book Club.' },
      badge: 1,
      url: 'https://club.stacks.test/',
      threadId: 'club',
    });
    expect(h.pushes.find((p) => p.token === OWNER_PHONE)?.message).toEqual({ badge: 1 }); // the unread note, no request
  });

  it('clears the badge everywhere when the inbox is read', async () => {
    const h = createPlatformHarness();
    await h.addDevice('owner@test.dev', OWNER_PHONE);
    await h.authorize('club', 'ann@test.dev');
    await h.setRole('club', 'ann@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } });
    h.pushes.length = 0;
    await h.call('POST', '/notifications/read', { as: 'owner@test.dev' });
    expect(h.pushes).toEqual([expect.objectContaining({ token: OWNER_PHONE, message: { badge: 0 } })]);
    h.pushes.length = 0;
    await h.call('POST', '/notifications/read', { as: 'owner@test.dev' }); // nothing changed: nothing sent
    expect(h.pushes).toEqual([]);
  });

  it('mutes an app\'s pushes per person: the inbox still fills, the phone gets the badge only', async () => {
    const h = createPlatformHarness();
    await h.addDevice('owner@test.dev', OWNER_PHONE);
    expect((await h.call('GET', '/me/notification-settings', { as: 'owner@test.dev' })).body.apps).toEqual([
      { slug: 'club', name: 'Book Club', muted: false },
      { slug: 'hello', name: 'Hello Board', muted: false },
    ]);
    expect((await h.call('PUT', '/me/muted/club', { as: 'owner@test.dev' })).body.mutedApps).toEqual(['club']);
    expect((await h.call('PUT', '/me/muted/nope', { as: 'owner@test.dev' })).status).toBe(404);
    await h.authorize('club', 'ann@test.dev');
    expect(h.pushes.map((p) => p.message)).toEqual([{ badge: 2 }]);
    expect((await h.call('GET', '/me', { as: 'owner@test.dev' })).body.unread).toBe(1);

    await h.call('DELETE', '/me/muted/club', { as: 'owner@test.dev' });
    await h.authorize('club', 'bob@test.dev');
    expect(h.pushes.at(-1)?.message.alert?.title).toBe('Book Club');
  });

  it('drops devices Apple says are gone, and never lets a failed push break what caused it', async () => {
    const h = createPlatformHarness({ pushResult: (t) => (t === OWNER_PHONE ? 'gone' : 'failed') });
    await h.addDevice('owner@test.dev', OWNER_PHONE);
    await h.addDevice('root@test.dev', tok(3));
    h.deps.push = { send: async (d) => (d.token === tok(3) ? Promise.reject(new Error('network down')) : 'gone') };
    const first = await h.authorize('club', 'ann@test.dev');
    expect(first.url!.searchParams.get('error')).toBe('access_pending');
    expect((await h.call('GET', '/devices', { as: 'owner@test.dev' })).body.devices).toEqual([]);
    expect((await h.call('GET', '/devices', { as: 'root@test.dev' })).body.devices).toHaveLength(1);
  });

  it('forgets phones registered by another bundle ID (from before a move) instead of pushing them', async () => {
    const h = createPlatformHarness();
    await h.addDevice('owner@test.dev', OWNER_PHONE);
    await h.addDevice('owner@test.dev', tok(4));
    h.deps.config.iosBundleId = 'ninja.dashnash.stacks.next'; // the environment moves to a new app
    await h.addDevice('owner@test.dev', tok(5), { bundleId: 'ninja.dashnash.stacks.next' });
    await h.authorize('club', 'ann@test.dev');
    expect(h.pushes.map((p) => p.device.token)).toEqual([tok(5)]);
    expect((await h.call('GET', '/devices', { as: 'owner@test.dev' })).body.devices).toHaveLength(1);
  });

  it('pushes app notifications with the app\'s own link', async () => {
    const h = createPlatformHarness();
    await h.authorize('hello', 'ann@test.dev');
    await h.addDevice('ann@test.dev', PHONE);
    const res = await h.call('POST', '/apps/hello/notify', { headers: { authorization: 'Bearer cred-hello' }, body: { userId: await h.idOf('ann@test.dev'), text: 'Bob said hi', link: 'https://hello.stacks.test/#post-1' } });
    expect(res.status).toBe(200);
    expect(h.pushes.at(-1)?.message).toEqual({ alert: { title: 'Hello Board', body: 'Bob said hi' }, badge: 1, url: 'https://hello.stacks.test/#post-1', threadId: 'hello' });
  });
});

describe('Approve / Deny from the lock screen', () => {
  async function requestOnPhone(opts: { secondPhone?: boolean } = {}) {
    const h = createPlatformHarness();
    const owner = (await h.addDevice('owner@test.dev', OWNER_PHONE)).body;
    const other = opts.secondPhone ? (await h.addDevice('owner@test.dev', tok(4))).body : null;
    await h.authorize('club', 'ann@test.dev');
    const pushed = (token: string) => h.pushes.find((p) => p.token === token)!.message;
    const press = (device: { device: { id: string }; secret: string }, token: string | undefined, action: string, secret = device.secret) =>
      h.call('POST', `/devices/${device.device.id}/actions`, { body: { secret, token, action } });
    return { h, owner, other, pushed, press };
  }

  it('gives each of the approver\'s phones its own buttons and single-use token', async () => {
    const { pushed } = await requestOnPhone({ secondPhone: true });
    const a = pushed(OWNER_PHONE);
    const b = pushed(tok(4));
    expect(a).toMatchObject({ category: 'ACCESS_REQUEST', actionToken: expect.stringMatching(/^spa_/) });
    expect(b.actionToken).not.toBe(a.actionToken);
    expect(apnsPayload(a)).toMatchObject({ aps: { category: 'ACCESS_REQUEST' }, actionToken: a.actionToken });
  });

  it('approves with the default role, tells the requester, and records that it came from a phone', async () => {
    const { h, owner, pushed, press } = await requestOnPhone();
    const res = await press(owner, pushed(OWNER_PHONE).actionToken, 'approve');
    expect(res.body).toEqual({ ok: true, result: 'approved' });
    const grid = await h.call('GET', '/admin/access', { as: 'owner@test.dev' });
    expect(grid.body.grants.find((g: { userId: string }) => g.userId === grid.body.users.find((u: { email: string }) => u.email === 'ann@test.dev').id).role).toBe('MEMBER');
    expect((await h.call('GET', '/notifications', { as: 'ann@test.dev' })).body.notifications[0].text).toBe('You now have access to Book Club.');
    const audit = await h.call('GET', '/admin/audit', { as: 'owner@test.dev', query: { action: 'grant' } });
    expect(audit.body.events[0]).toMatchObject({ action: 'grant.set', details: expect.objectContaining({ via: 'push', from: 'PENDING', to: 'MEMBER' }) });
    // Single use.
    expect((await press(owner, pushed(OWNER_PHONE).actionToken, 'approve')).status).toBe(403);
  });

  it('denies by dismissing the request', async () => {
    const { h, owner, pushed, press } = await requestOnPhone();
    expect((await press(owner, pushed(OWNER_PHONE).actionToken, 'deny')).body.result).toBe('denied');
    expect((await h.call('GET', '/admin/access', { as: 'owner@test.dev' })).body.grants.some((g: { role: string }) => g.role === 'PENDING')).toBe(false);
  });

  it('says so when the request was already handled elsewhere', async () => {
    const { h, owner, pushed, press } = await requestOnPhone();
    await h.setRole('club', 'ann@test.dev', { as: 'owner@test.dev', body: { role: 'MEMBER' } });
    expect((await press(owner, pushed(OWNER_PHONE).actionToken, 'deny')).body.result).toBe('already-handled');
  });

  it('needs the device\'s secret, and the token for that device, within 7 days', async () => {
    const { h, owner, other, pushed, press } = await requestOnPhone({ secondPhone: true });
    expect((await press(owner, pushed(OWNER_PHONE).actionToken, 'approve', 'sdv_wrong')).status).toBe(401);
    expect((await press(other!, pushed(OWNER_PHONE).actionToken, 'approve')).status).toBe(403); // another phone's token
    h.advance(8 * 86_400_000);
    expect((await press(other!, pushed(tok(4)).actionToken, 'approve')).status).toBe(403);
    expect((await press(owner, 'spa_made_up', 'approve')).status).toBe(403);
    expect((await press(owner, pushed(OWNER_PHONE).actionToken, 'maybe')).status).toBe(400);
  });

  it('applies the normal rules, and tells the approver when it could not', async () => {
    const { h, owner, pushed, press } = await requestOnPhone();
    // The owner loses the right to manage access before pressing Approve.
    await h.setRole('club', 'admin2@test.dev', { as: 'owner@test.dev', body: { role: 'OWNER' } });
    await h.setRole('club', 'owner@test.dev', { as: 'admin2@test.dev', body: { role: 'MEMBER' } });
    expect((await press(owner, pushed(OWNER_PHONE).actionToken, 'approve')).status).toBe(403);
    const notes = (await h.call('GET', '/notifications', { as: 'owner@test.dev' })).body.notifications;
    expect(notes[0].text).toMatch(/^Couldn't approve ann for Book Club: /);
  });
});

describe('APNs', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const key = { keyId: 'ABC123DEFG', teamId: '47ZUZ59AHR', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };

  it('signs provider tokens the way Apple checks them', () => {
    const [h, p, s] = apnsJwt(key, 1_700_000_000_000).split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({ iss: '47ZUZ59AHR', iat: 1_700_000_000 });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true);
  });

  it('builds alerts and badge-only updates', () => {
    expect(apnsPayload({ alert: { title: 'Book Club', body: 'Hi' }, badge: 3, url: 'https://x/', threadId: 'club' })).toEqual({
      aps: { alert: { title: 'Book Club', body: 'Hi' }, sound: 'default', badge: 3, 'thread-id': 'club' },
      url: 'https://x/',
    });
    expect(apnsPayload({ badge: 0 })).toEqual({ aps: { badge: 0 } });
  });

  it('reads Apple\'s answers: dead tokens are dropped, other errors only fail this send', () => {
    expect(apnsOutcome(200, '')).toBe('ok');
    expect(apnsOutcome(410, '{"reason":"Unregistered"}')).toBe('gone');
    expect(apnsOutcome(400, '{"reason":"BadDeviceToken"}')).toBe('gone');
    expect(apnsOutcome(400, '{"reason":"DeviceTokenNotForTopic"}')).toBe('gone');
    expect(apnsOutcome(429, '{"reason":"TooManyRequests"}')).toBe('failed');
  });

  it('posts to the right environment and topic, reuses its token for 40 minutes, and sends nothing without a key', async () => {
    const calls: { env: string; path: string; headers: Record<string, string>; body: string }[] = [];
    let now = 1_700_000_000_000;
    const sender = createApnsSender({ key: async () => key, now: () => now, post: async (env, path, headers, body) => (calls.push({ env, path, headers, body }), { status: 200, body: '' }) });
    const device = { token: PHONE, env: 'sandbox' as const, bundleId: 'ninja.dashnash.stacks.test' };
    expect(await sender.send(device, { alert: { title: 'T', body: 'B' }, badge: 1 })).toBe('ok');
    expect(calls[0]).toMatchObject({ env: 'sandbox', path: `/3/device/${PHONE}`, headers: { 'apns-topic': 'ninja.dashnash.stacks.test', 'apns-push-type': 'alert', 'apns-priority': '10' } });
    await sender.send(device, { badge: 0 });
    expect(calls[1]!.headers).toMatchObject({ 'apns-push-type': 'alert', 'apns-priority': '5', authorization: calls[0]!.headers.authorization });
    now += 41 * 60_000;
    await sender.send(device, { badge: 0 });
    expect(calls[2]!.headers.authorization).not.toBe(calls[0]!.headers.authorization);

    const unset = createApnsSender({ key: async () => undefined, post: async () => Promise.reject(new Error('should not post')) });
    expect(await unset.send(device, { badge: 1 })).toBe('failed');
  });
});
