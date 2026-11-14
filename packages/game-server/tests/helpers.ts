import { MemoryStore, roomChannels, roomKeys, signGameTicket, type IceCandidateInit, type ToPlayerSignal } from '@stacks/api';
import { defineGame, RoomServer, type GameRoom, type PeerHooks, type PlayerLink, type ServerPeer, type Signaling } from '../src/index';

export const KEY = 'test-game-key';
export const ROOM = 'room-1';

/** Signaling in memory: what the server published, and a way to play a client publishing. */
export class FakeSignaling implements Signaling {
  readonly published: { channel: string; data: unknown }[] = [];
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  async subscribe(channel: string, onEvent: (data: unknown) => void) {
    let set = this.handlers.get(channel);
    if (!set) this.handlers.set(channel, (set = new Set()));
    set.add(onEvent);
    return () => void set!.delete(onEvent);
  }
  async publish(channel: string, data: unknown) {
    this.published.push({ channel, data });
  }
  /** A browser publishes on a channel (bare data, or in the web SDK's envelope). */
  fromClient(channel: string, data: unknown, wrap = false) {
    for (const h of this.handlers.get(channel) ?? []) h(wrap ? JSON.stringify({ d: data, f: 'tab-1', i: 'e1' }) : data);
  }
  on(channel: string) {
    return this.published.filter((p) => p.channel === channel).map((p) => p.data);
  }
  listeners(channel: string) {
    return this.handlers.get(channel)?.size ?? 0;
  }
}

/** A peer in memory: the test opens it, sends as the client, and sees what the server sent. */
export class FakePeer implements ServerPeer {
  readonly candidates: IceCandidateInit[] = [];
  readonly state: string[] = [];
  readonly events: unknown[] = [];
  offer = '';
  closed = false;
  failAnswer = false;
  constructor(readonly hooks: PeerHooks) {}
  async answer(offerSdp: string) {
    if (this.failAnswer) throw new Error('no ports left');
    this.offer = offerSdp;
    return `answer-to:${offerSdp}`;
  }
  async addCandidate(c: IceCandidateInit) {
    this.candidates.push(c);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.hooks.onClosed();
  }
  /** Both data channels opened. */
  open() {
    const link: PlayerLink = { state: (json) => this.state.push(json), event: (json) => this.events.push(JSON.parse(json)), close: () => this.close() };
    this.hooks.onOpen(link);
  }
  /** The connection failed under the server. */
  drop() {
    this.close();
  }
}

export interface DotsState {
  room: GameRoom<unknown>;
  seen: string[];
}

export const game = defineGame<DotsState>({
  tickHz: 20,
  init: (room) => ({ room, seen: [] }),
  onJoin: (s, p) => void s.seen.push(`join ${p.name}`),
  onLeave: (s, p) => void s.seen.push(`leave ${p.name}`),
  onInput: (s, p, input) => void s.seen.push(`input ${p.name} ${JSON.stringify(input)}`),
  onEvent: (s, p, event) => {
    if (event === 'finish') s.room.end({ winner: p.id });
  },
  snapshot: (s) => ({ seen: s.seen }),
  results: (s) => ({ seen: s.seen.length }),
});

export async function setup(opts: { status?: string; maxPlayers?: number; store?: MemoryStore } = {}) {
  const store = opts.store ?? new MemoryStore();
  if (opts.status !== 'missing') await store.put({ ...roomKeys.meta(ROOM), id: ROOM, status: opts.status ?? 'starting', maxPlayers: opts.maxPlayers ?? 8 });
  const signaling = new FakeSignaling();
  const peers: FakePeer[] = [];
  const clock = { wall: Date.parse('2026-06-01T12:00:00Z'), mono: 0 };
  const logs: string[] = [];
  const server = new RoomServer({
    roomId: ROOM,
    game,
    store,
    signaling,
    peers: (hooks) => {
      const peer = new FakePeer(hooks);
      peers.push(peer);
      return peer;
    },
    key: async () => KEY,
    maxPlayers: 8,
    idleMs: 10 * 60_000,
    maxMs: 2 * 3_600_000,
    now: () => clock.wall,
    monotonic: () => clock.mono,
    every: () => () => undefined,
    lingerMs: 0,
    log: (m, d) => logs.push(d === undefined ? m : `${m}: ${String(d)}`),
  });
  /** Let game time pass, tick by tick. */
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += 50) {
      clock.mono += 50;
      clock.wall += 50;
      server.advance();
    }
  };
  const ticket = (userId: string, name: string, overrides: { roomId?: string; exp?: number; key?: string } = {}) =>
    signGameTicket(overrides.key ?? KEY, { roomId: overrides.roomId ?? ROOM, userId, name, exp: overrides.exp ?? Math.floor(clock.wall / 1000) + 60 });
  /** A client sends an offer; resolves once the server has dealt with it. */
  const offer = async (userId: string, name: string, sid: string, overrides: Parameters<typeof ticket>[2] & { ticket?: string; wrap?: boolean } = {}) => {
    signaling.fromClient(roomChannels.toServer(ROOM), { t: 'offer', sid, ticket: overrides.ticket ?? (await ticket(userId, name, overrides)), sdp: `offer-${sid}` }, overrides.wrap);
    await settle();
  };
  const answers = (userId: string) => signaling.on(roomChannels.toPlayer(ROOM, userId)) as ToPlayerSignal[];
  return { store, signaling, peers, server, clock, logs, advance, ticket, offer, answers };
}

/** Let queued promises (ticket checks, store writes) run. */
export const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
