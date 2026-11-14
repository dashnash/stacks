/**
 * Game rooms in the demo: the app's real `defineGame` runs in the page. The tab that creates a
 * room is its server (the same `RoomServer` as on Fargate); players in this or any other demo tab
 * of the app reach it with the real signaling over the demo's realtime bus and a stand-in for
 * WebRTC over a `BroadcastChannel`. No AWS, and two personas can play side by side.
 */
import { randomToken, type Games, type IceCandidateInit, type IceServer, type Store } from '@stacks/api';
import { RoomServer, type GameDefinition, type PeerFactory, type PeerHooks, type ServerPeer, type Signaling } from '@stacks/game-server';
import type { ChannelLike, PeerLike } from '@stacks/web';
import type { GameServerSettings } from '@stacks/manifest';
import type { DemoRealtimeBus } from './realtime';

/** A room's server is taken for dead when its tab has not been heard from for this long. */
const HOST_SILENT_MS = 6000;
const HEARTBEAT_MS = 1500;
/** A peer whose other end has gone quiet for this long has lost its connection. */
const PEER_SILENT_MS = 4000;
const PEER_HEARTBEAT_MS = 1000;

type Wire =
  | { conn: string; kind: 'open' | 'opened' | 'close' | 'hb'; from: 'c' | 's' }
  | { conn: string; kind: 'data'; from: 'c' | 's'; ch: 'state' | 'events'; data: string }
  | { kind: 'stop'; room: string };

const peerChannel = (slug: string) => `stacks-demo-game:${slug}`;
const offerSdp = (conn: string) => `demo-peer:${conn}`;
const answerSdp = (conn: string) => `demo-peer-ok:${conn}`;
const hasBroadcast = () => typeof BroadcastChannel !== 'undefined';

/** One end of a demo "peer connection": its own BroadcastChannel, heartbeats, and a silence check. */
class Pipe {
  private readonly bc: BroadcastChannel | null;
  private beat: ReturnType<typeof setInterval> | undefined;
  private heard = Date.now();
  closed = false;
  constructor(
    slug: string,
    readonly conn: string,
    private readonly me: 'c' | 's',
    private readonly onMessage: (m: Extract<Wire, { conn: string }>) => void,
    private readonly onLost: () => void,
  ) {
    this.bc = hasBroadcast() ? new BroadcastChannel(peerChannel(slug)) : null;
    if (this.bc)
      this.bc.onmessage = (ev: MessageEvent<Wire>) => {
        const m = ev.data;
        if (this.closed || !m || !('conn' in m) || m.conn !== this.conn || m.from === this.me) return;
        this.heard = Date.now();
        if (m.kind === 'close') this.lost();
        else if (m.kind !== 'hb') this.onMessage(m);
      };
  }
  /** Start heartbeats (once the two ends know each other). */
  live(): void {
    this.heard = Date.now();
    this.beat ??= setInterval(() => {
      if (Date.now() - this.heard > PEER_SILENT_MS) this.lost();
      else this.post({ conn: this.conn, kind: 'hb', from: this.me });
    }, PEER_HEARTBEAT_MS);
  }
  post(m: Wire): void {
    if (this.closed) return;
    try {
      this.bc?.postMessage(m);
    } catch {
      // the channel closed under us
    }
  }
  private lost(): void {
    if (this.closed) return;
    this.shut();
    this.onLost();
  }
  /** Close this end, telling the other. */
  close(): void {
    if (this.closed) return;
    this.post({ conn: this.conn, kind: 'close', from: this.me });
    this.shut();
  }
  private shut(): void {
    this.closed = true;
    clearInterval(this.beat);
    this.bc?.close();
  }
}

class DemoDataChannel implements ChannelLike {
  readyState = 'connecting';
  onopen: ChannelLike['onopen'] = null;
  onmessage: ChannelLike['onmessage'] = null;
  onclose: ChannelLike['onclose'] = null;
  constructor(
    readonly label: 'state' | 'events',
    private readonly sendData: (ch: 'state' | 'events', data: string) => void,
  ) {}
  send(data: string): void {
    if (this.readyState === 'open') this.sendData(this.label, data);
  }
  close(): void {
    this.readyState = 'closed';
  }
}

/** The browser's end: enough of `RTCPeerConnection` for `useGameRoom`, carried by a BroadcastChannel. */
export class DemoPeerConnection implements PeerLike {
  connectionState = 'new';
  localDescription: { sdp: string } | null = null;
  onicecandidate: PeerLike['onicecandidate'] = null;
  onconnectionstatechange: PeerLike['onconnectionstatechange'] = null;
  private readonly conn = randomToken().slice(0, 16);
  private readonly channels = new Map<string, DemoDataChannel>();
  private readonly pipe: Pipe;

  constructor(slug: string) {
    this.pipe = new Pipe(
      slug,
      this.conn,
      'c',
      (m) => {
        if (m.kind === 'opened') {
          this.pipe.live();
          this.setState('connected');
          for (const ch of this.channels.values()) {
            ch.readyState = 'open';
            ch.onopen?.({});
          }
        } else if (m.kind === 'data') this.channels.get(m.ch)?.onmessage?.({ data: m.data });
      },
      () => this.setState('failed'),
    );
  }
  createDataChannel(label: string): ChannelLike {
    const ch = new DemoDataChannel(label as 'state' | 'events', (c, data) => this.pipe.post({ conn: this.conn, kind: 'data', from: 'c', ch: c, data }));
    this.channels.set(label, ch);
    return ch;
  }
  async createOffer(): Promise<{ type: 'offer'; sdp: string }> {
    return { type: 'offer', sdp: offerSdp(this.conn) };
  }
  async setLocalDescription(description: { sdp?: string }): Promise<void> {
    this.localDescription = { sdp: description.sdp ?? offerSdp(this.conn) };
    this.setState('connecting');
  }
  async setRemoteDescription(description: { sdp: string }): Promise<void> {
    if (description.sdp !== answerSdp(this.conn)) throw new Error('Not an answer to this offer');
    this.pipe.post({ conn: this.conn, kind: 'open', from: 'c' });
  }
  async addIceCandidate(): Promise<void> {
    // nothing to traverse
  }
  close(): void {
    this.pipe.close();
    this.connectionState = 'closed';
  }
  private setState(state: string): void {
    if (this.connectionState === 'closed' || this.connectionState === state) return;
    this.connectionState = state;
    if (state === 'failed') for (const ch of this.channels.values()) ch.readyState = 'closed';
    this.onconnectionstatechange?.({});
  }
}

/** The server's end, for `RoomServer`. */
export function demoPeers(slug: string): PeerFactory {
  return (hooks: PeerHooks): ServerPeer => {
    let pipe: Pipe | null = null;
    let closed = false;
    const closeOnce = () => {
      if (closed) return;
      closed = true;
      pipe?.close();
      hooks.onClosed();
    };
    return {
      async answer(sdp) {
        const conn = sdp.startsWith('demo-peer:') ? sdp.slice('demo-peer:'.length) : '';
        if (!/^[\w-]{8,64}$/.test(conn)) throw new Error('Not a demo offer');
        const p = (pipe = new Pipe(
          slug,
          conn,
          's',
          (m) => {
            if (m.kind === 'open') {
              p.live();
              p.post({ conn, kind: 'opened', from: 's' });
              hooks.onOpen({
                state: (json) => p.post({ conn, kind: 'data', from: 's', ch: 'state', data: json }),
                event: (json) => p.post({ conn, kind: 'data', from: 's', ch: 'events', data: json }),
                close: closeOnce,
              });
            } else if (m.kind === 'data') (m.ch === 'state' ? hooks.onState : hooks.onEvent)(m.data);
          },
          closeOnce,
        ));
        return answerSdp(conn);
      },
      async addCandidate(_candidate: IceCandidateInit) {
        // nothing to traverse
      },
      close: closeOnce,
    };
  };
}

export interface DemoGamesOptions {
  slug: string;
  /** The app's game (`apps/<slug>/game/server.ts`); without it rooms can't start. */
  game?: GameDefinition<any, any, any>;
  settings: GameServerSettings;
  /** The demo's store, saving to the shared demo data on every write. */
  store: Store;
  bus: DemoRealtimeBus;
  /** How long "the server is starting" lasts (the real thing takes 30-60 s). Default 1200 ms. */
  startDelayMs?: number;
}

/** `deps.games` in the demo. */
export class DemoGames implements Games {
  private readonly servers = new Map<string, RoomServer<any, any, any>>();
  private readonly starting = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly control: BroadcastChannel | null;
  private readonly beat: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly opts: DemoGamesOptions) {
    this.control = hasBroadcast() ? new BroadcastChannel(peerChannel(opts.slug)) : null;
    if (this.control)
      this.control.onmessage = (ev: MessageEvent<Wire>) => {
        if (ev.data?.kind === 'stop') this.stopLocal(ev.data.room);
      };
    // Other tabs tell a live server from a closed tab by these.
    this.beat = setInterval(() => {
      for (const room of [...this.servers.keys(), ...this.starting.keys()]) this.heartbeat(room);
    }, HEARTBEAT_MS);
  }

  private beatKey(room: string): string {
    return `stacks-demo-game:${this.opts.slug}:${room}`;
  }
  private heartbeat(room: string): void {
    try {
      localStorage.setItem(this.beatKey(room), String(Date.now()));
    } catch {
      // no storage: rooms then only work within this tab
    }
  }

  async start(roomId: string): Promise<void> {
    const { game, settings, slug } = this.opts;
    if (!game) throw new Error(`The demo of ${slug} needs its game to run rooms: pass \`game\` (from game/server.ts) in demoOptions()`);
    this.heartbeat(roomId);
    const signaling: Signaling = {
      subscribe: async (channel, onEvent) => this.opts.bus.tap(channel, onEvent),
      publish: (channel, data) => this.opts.bus.publish(channel, data),
    };
    const server = new RoomServer({
      roomId,
      game,
      store: this.opts.store,
      signaling,
      peers: demoPeers(slug),
      key: () => this.key(),
      maxPlayers: settings.maxPlayers,
      idleMs: settings.idleMinutes * 60_000,
      maxMs: settings.maxHours * 3_600_000,
      lingerMs: 100,
      log: (message, detail) => console.debug(`[demo game ${roomId}] ${message}`, detail ?? ''),
    });
    const begin = () => {
      this.starting.delete(roomId);
      if (this.closed) return;
      this.servers.set(roomId, server);
      void server
        .start()
        .then((opened) => !opened && this.servers.delete(roomId))
        .catch((err) => console.error('Demo game server failed', err));
      void server.done.then(() => {
        this.servers.delete(roomId);
        try {
          localStorage.removeItem(this.beatKey(roomId));
        } catch {
          // no storage
        }
      });
    };
    this.starting.set(roomId, setTimeout(begin, this.opts.startDelayMs ?? 1200));
  }

  async stop(roomId: string): Promise<void> {
    if (!this.stopLocal(roomId)) this.control?.postMessage({ kind: 'stop', room: roomId } satisfies Wire);
  }

  private stopLocal(roomId: string): boolean {
    const pending = this.starting.get(roomId);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.starting.delete(roomId);
      return true;
    }
    const server = this.servers.get(roomId);
    if (!server) return false;
    server.stop('stopped');
    return true;
  }

  async running(roomIds: string[]): Promise<Set<string>> {
    const alive = new Set<string>();
    for (const id of roomIds) {
      if (this.servers.has(id) || this.starting.has(id)) alive.add(id);
      else {
        try {
          if (Date.now() - Number(localStorage.getItem(this.beatKey(id)) ?? 0) < HOST_SILENT_MS) alive.add(id);
        } catch {
          // no storage
        }
      }
    }
    return alive;
  }

  /** One key for every demo tab of the app (tickets signed in one tab are checked in another). */
  async key(): Promise<string> {
    const name = `stacks-demo-game-key:${this.opts.slug}`;
    try {
      let key = localStorage.getItem(name);
      if (!key) localStorage.setItem(name, (key = randomToken('demo-game-key-')));
      return key;
    } catch {
      return 'demo-game-key';
    }
  }

  async iceServers(): Promise<IceServer[]> {
    return [];
  }

  async missingKeys(): Promise<string[]> {
    return [];
  }

  /** Stop every room this tab hosts and stop listening (tests, and when the demo resets). */
  close(): void {
    this.closed = true;
    clearInterval(this.beat);
    for (const timer of this.starting.values()) clearTimeout(timer);
    this.starting.clear();
    for (const server of this.servers.values()) server.stop('stopped');
    this.control?.close();
  }
}
