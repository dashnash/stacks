import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppManifest } from '@stacks/manifest';
import type { AppDeps, AppRoutes } from '@stacks/api';
import { RealtimeHub, type ChannelStatus } from '@stacks/web';
import { createDemo, type Demo } from '../src/index';

const manifest: AppManifest = {
  slug: 'livedemo',
  name: 'Live',
  tagline: 't',
  description: 'd',
  visibility: 'private',
  roles: [
    { id: 'OWNER', label: 'Owner', canManageAccess: true },
    { id: 'READER', label: 'Reader' },
  ],
  topRole: 'OWNER',
  defaultRole: 'READER',
  modules: ['realtime'],
  owners: ['o@x.dev'],
};

const routes = (api: AppRoutes<AppDeps>) => {
  api.realtime
    .channel('counter/main', { subscribe: true })
    .channel('room/*', { subscribe: true, publish: (v) => v.role === 'OWNER' });
  api
    .member('GET', '/counter', async (_r, v) => ({ body: { n: (await v.deps.store.get<{ PK: string; SK: string; n: number }>('COUNTER', 'main'))?.n ?? 0 } }))
    .member('POST', '/counter', async (_r, v) => {
      const n = ((await v.deps.store.get<{ PK: string; SK: string; n: number }>('COUNTER', 'main'))?.n ?? 0) + 1;
      await v.deps.store.put({ PK: 'COUNTER', SK: 'main', n });
      await v.deps.realtime.publish('counter/main', { n });
      return { body: { n } };
    });
};

const personas = [
  { email: 'olive@demo', name: 'Olive', role: 'OWNER' },
  { email: 'rex@demo', name: 'Rex', role: 'READER' },
];

const demos: Demo[] = [];
/** A demo tab signed in as one persona, with its hub. */
async function tab(email: string) {
  const demo = createDemo({ manifest, routes, personas, storageKey: 'stacks-demo:livedemo:test' });
  demos.push(demo);
  await demo.signInAs(email);
  return { demo, hub: new RealtimeHub(demo.client) };
}
function watch(hub: RealtimeHub, channel: string, publish = false) {
  const events: unknown[] = [];
  let status: ChannelStatus = 'offline';
  hub.add({ channel, publish, echo: false, onEvent: (d) => events.push(d), onStatus: (s) => (status = s) }, 'x');
  return { events, status: () => status };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const d of demos.splice(0)) d.realtime?.close();
});

describe('demo realtime bus', () => {
  it("delivers a server publish in one tab to the other persona's tab, with that tab's data in step", async () => {
    const olive = await tab('olive@demo');
    const rex = await tab('rex@demo');
    const atOlive = watch(olive.hub, 'counter/main');
    const atRex = watch(rex.hub, 'counter/main');
    await vi.waitFor(() => expect([atOlive.status(), atRex.status()]).toEqual(['live', 'live']));
    await olive.demo.client.post('/counter');
    await olive.demo.client.post('/counter');
    await vi.waitFor(() => expect(atRex.events).toEqual([{ n: 1 }, { n: 2 }]));
    expect(atOlive.events).toEqual([{ n: 1 }, { n: 2 }]);
    // Rex's tab read Olive's saved data, and still has its own session.
    expect(await rex.demo.client.get('/counter')).toEqual({ n: 2 });
    expect((await rex.demo.client.session()).user.name).toBe('Rex');
  });

  it('applies the channel guards: a reader may listen on a room but not publish there', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const olive = await tab('olive@demo');
    const rex = await tab('rex@demo');
    const oliveRoom = watch(olive.hub, 'room/lobby', true);
    const rexRoom = watch(rex.hub, 'room/lobby');
    await vi.waitFor(() => expect([oliveRoom.status(), rexRoom.status()]).toEqual(['live', 'live']));
    await olive.hub.publish('room/lobby', { wave: 'Olive' });
    await vi.waitFor(() => expect(rexRoom.events).toEqual([{ wave: 'Olive' }]));
    expect(oliveRoom.events).toEqual([]); // her own echo is dropped

    await expect(rex.demo.client.post('/realtime/token', { subscribe: [], publish: ['room/lobby'] })).rejects.toMatchObject({ status: 403, code: 'REALTIME_REFUSED' });
    await expect(rex.demo.client.post('/realtime/token', { subscribe: ['nope/1'] })).rejects.toMatchObject({ code: 'REALTIME_UNDECLARED' });
    const rexPublisher = new RealtimeHub(rex.demo.client);
    const refused = watch(rexPublisher, 'room/lobby', true);
    await vi.waitFor(() => expect(refused.status()).toBe('offline'));
    error.mockRestore();
  });

  it('drops the cross-tab broadcast of an event published just before the bus closes', async () => {
    const olive = await tab('olive@demo');
    await olive.demo.client.post('/counter');
    olive.demo.realtime!.close();
    // The broadcast is deferred a task; posting on the closed channel used to throw (uncaught).
    await new Promise((r) => setTimeout(r, 10));
  });

  it('refuses a socket subscribe on a channel the token does not name', async () => {
    const olive = await tab('olive@demo');
    const { token } = await olive.demo.client.post<{ token: string }>('/realtime/token', { subscribe: ['counter/main'] });
    const header = btoa(JSON.stringify({ host: 'h', Authorization: token })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const ws = olive.demo.client.openSocket('demo:realtime', ['aws-appsync-event-ws', `header-${header}`]);
    const got: { type: string }[] = [];
    ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
    ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.send(JSON.stringify({ type: 'subscribe', id: 'a', channel: '/app/room/lobby', authorization: { Authorization: token } }));
    ws.send(JSON.stringify({ type: 'subscribe', id: 'b', channel: '/app/counter/main', authorization: { Authorization: token } }));
    await vi.waitFor(() => expect(got.map((m) => m.type)).toEqual(['connection_ack', 'subscribe_error', 'subscribe_success']));
  });
});
