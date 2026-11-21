import { createHash, createHmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { describe, expect, it, vi } from 'vitest';
import { openEnvelope } from '@stacks/api';
import { appSyncSignaling, type ServerSocket } from '../src/node/appsync-signaling';
import { readEnvironment } from '../src/node/main';

const HTTP = 'abc.appsync-api.us-east-1.amazonaws.com';
const WS = 'abc.appsync-realtime-api.us-east-1.amazonaws.com';
const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session' };
const now = new Date('2026-06-01T12:00:00Z');

class Sha256 {
  private h;
  constructor(secret?: string | Uint8Array) {
    this.h = secret ? createHmac('sha256', secret) : createHash('sha256');
  }
  update(data: string | Uint8Array) {
    this.h.update(data);
  }
  async digest() {
    return new Uint8Array(this.h.digest());
  }
}
/** What the AWS SDK's signer makes of the request AppSync documents for a WebSocket operation. */
async function awsSignature(body: string) {
  const signer = new SignatureV4({ credentials, region: 'us-east-1', service: 'appsync', sha256: Sha256 as never, applyChecksum: false, uriEscapePath: true });
  const signed = await signer.sign(
    {
      method: 'POST',
      protocol: 'https:',
      hostname: HTTP,
      path: '/event',
      headers: { accept: 'application/json, text/javascript', 'content-encoding': 'amz-1.0', 'content-type': 'application/json; charset=UTF-8', host: HTTP },
      body,
    },
    { signingDate: now },
  );
  return signed.headers.authorization;
}

class FakeSocket implements ServerSocket {
  onopen: ServerSocket['onopen'] = null;
  onmessage: ServerSocket['onmessage'] = null;
  onclose: ServerSocket['onclose'] = null;
  onerror: ServerSocket['onerror'] = null;
  readonly sent: any[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  ofType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

const tick = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup() {
  const sockets: FakeSocket[] = [];
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ successful: [], failed: [] }), { status: 200 }));
  const logs: string[] = [];
  const signaling = appSyncSignaling({
    httpHost: HTTP,
    realtimeHost: WS,
    namespace: 'app',
    region: 'us-east-1',
    credentials: async () => credentials,
    webSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    fetch: fetchMock as never,
    now: () => now,
    log: (m) => logs.push(m),
  });
  /** Subscribe and play AppSync's side of the handshake. */
  const subscribe = async (channel: string, onEvent: (data: unknown) => void) => {
    const pending = signaling.subscribe(channel, onEvent);
    await tick();
    const socket = sockets.at(-1)!;
    if (!socket.ofType('subscribe').length) {
      socket.onopen?.({});
      socket.receive({ type: 'connection_ack', connectionTimeoutMs: 300_000 });
      await tick();
    }
    const sub = socket.ofType('subscribe').at(-1);
    socket.receive({ type: 'subscribe_success', id: sub.id });
    return { unsubscribe: await pending, socket, sub };
  };
  return { signaling, sockets, fetchMock, logs, subscribe };
}

describe('appSyncSignaling', () => {
  it('connects with IAM: the documented subprotocol header, signed as AppSync checks it', async () => {
    const t = setup();
    const { socket } = await t.subscribe('room/r1/to-server', () => undefined);
    expect(socket.url).toBe(`wss://${WS}/event/realtime`);
    expect(socket.protocols[0]).toBe('aws-appsync-event-ws');
    const header = JSON.parse(Buffer.from(socket.protocols[1]!.slice('header-'.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    expect(header).toEqual({
      accept: 'application/json, text/javascript',
      'content-encoding': 'amz-1.0',
      'content-type': 'application/json; charset=UTF-8',
      host: HTTP,
      'x-amz-date': '20260601T120000Z',
      'x-amz-security-token': 'session',
      authorization: await awsSignature('{}'),
    });
    expect(socket.sent[0]).toEqual({ type: 'connection_init' });
  });

  it('subscribes with a signature over the channel, and resolves only once AppSync confirms', async () => {
    const t = setup();
    const { sub } = await t.subscribe('room/r1/to-server', () => undefined);
    expect(sub).toMatchObject({ type: 'subscribe', channel: '/app/room/r1/to-server' });
    expect(sub.authorization.authorization).toBe(await awsSignature(JSON.stringify({ channel: '/app/room/r1/to-server' })));
    expect(sub.authorization.host).toBe(HTTP);
  });

  it('rejects when the subscription is refused', async () => {
    const t = setup();
    const pending = t.signaling.subscribe('room/r1/to-server', () => undefined);
    const failed = pending.catch((err: Error) => err.message);
    await tick();
    const socket = t.sockets[0]!;
    socket.onopen?.({});
    socket.receive({ type: 'connection_ack' });
    await tick();
    socket.receive({ type: 'subscribe_error', id: socket.ofType('subscribe')[0].id, errors: [{ errorType: 'UnauthorizedException' }] });
    expect(await failed).toMatch(/was refused.*UnauthorizedException/);
  });

  it('delivers events (a list of JSON strings, as AppSync sends them) to the right handler', async () => {
    const t = setup();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const first = await t.subscribe('room/r1/to-server', (d) => a.push(d));
    const second = await t.subscribe('room/r2/to-server', (d) => b.push(d));
    expect(t.sockets).toHaveLength(1);
    first.socket.receive({ type: 'data', id: first.sub.id, event: [JSON.stringify({ d: { t: 'offer' }, f: 'tab', i: '1' }), 'not json'] });
    first.socket.receive({ type: 'data', id: second.sub.id, event: JSON.stringify({ d: 2, f: 'tab' }) });
    first.socket.receive({ type: 'ka' });
    expect(a).toEqual([{ d: { t: 'offer' }, f: 'tab', i: '1' }]);
    expect(b).toEqual([{ d: 2, f: 'tab' }]);
    first.unsubscribe();
    expect(first.socket.ofType('unsubscribe')).toEqual([{ type: 'unsubscribe', id: first.sub.id }]);
  });

  it('reconnects and subscribes again when the connection drops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const t = setup();
      const got: unknown[] = [];
      const pending = t.signaling.subscribe('room/r1/to-server', (d) => got.push(d));
      await vi.advanceTimersByTimeAsync(1);
      const first = t.sockets[0]!;
      first.onopen?.({});
      first.receive({ type: 'connection_ack' });
      await vi.advanceTimersByTimeAsync(1);
      first.receive({ type: 'subscribe_success', id: first.ofType('subscribe')[0].id });
      await pending;

      first.close();
      await vi.advanceTimersByTimeAsync(600);
      expect(t.sockets).toHaveLength(2);
      const second = t.sockets[1]!;
      second.onopen?.({});
      second.receive({ type: 'connection_ack' });
      await vi.advanceTimersByTimeAsync(1);
      const again = second.ofType('subscribe')[0];
      expect(again.channel).toBe('/app/room/r1/to-server');
      second.receive({ type: 'data', id: again.id, event: ['{"d":1,"f":"x"}'] });
      expect(got).toEqual([{ d: 1, f: 'x' }]);

      // Closed for good: no more reconnects.
      t.signaling.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes over HTTP with SigV4, in the server envelope', async () => {
    const t = setup();
    await t.signaling.publish('room/r1/to/u-ann', { t: 'answer', sid: 's1', sdp: 'v=0' });
    const [url, init] = t.fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://${HTTP}/event`);
    expect((init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260601\/us-east-1\/appsync\/aws4_request/);
    const body = JSON.parse(init.body as string);
    expect(body.channel).toBe('/app/room/r1/to/u-ann');
    expect(openEnvelope(body.events[0])).toMatchObject({ d: { t: 'answer', sid: 's1', sdp: 'v=0' }, f: 'server' });

    t.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ errorType: 'UnauthorizedException' }] }), { status: 401 }));
    await expect(t.signaling.publish('room/r1', { status: 'open' })).rejects.toThrow(/failed \(401\)/);
  });
});

describe('readEnvironment', () => {
  const env = {
    STACKS_ROOM_ID: 'r1',
    STACKS_APP: 'hello',
    TABLE_NAME: 't',
    STACKS_REALTIME_HTTP_HOST: HTTP,
    STACKS_REALTIME_WS_HOST: WS,
    STACKS_GAME_KEY_ARN: 'arn:key',
  };
  it('reads the task environment with the default limits', () => {
    expect(readEnvironment(env)).toMatchObject({ roomId: 'r1', namespace: 'app', maxPlayers: 8, idleMs: 600_000, unusedMs: 600_000, maxMs: 7_200_000, portRange: [40000, 40019] });
    expect(readEnvironment({ ...env, STACKS_GAME_MAX_PLAYERS: '4', STACKS_GAME_IDLE_MINUTES: '1', STACKS_GAME_MAX_HOURS: '0.25' })).toMatchObject({ maxPlayers: 4, idleMs: 60_000, unusedMs: 60_000, maxMs: 900_000 });
    expect(readEnvironment({ ...env, STACKS_GAME_WARM_MINUTES: '3' })).toMatchObject({ idleMs: 600_000, unusedMs: 180_000 });
  });
  it('names what is missing or wrong', () => {
    expect(() => readEnvironment({ ...env, STACKS_ROOM_ID: '' })).toThrow(/STACKS_ROOM_ID/);
    expect(() => readEnvironment({ ...env, STACKS_GAME_MAX_HOURS: 'two' })).toThrow(/STACKS_GAME_MAX_HOURS/);
  });
});
