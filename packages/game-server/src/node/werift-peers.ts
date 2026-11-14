/**
 * WebRTC peers for the Fargate game server, on werift (pure TypeScript: it bundles into the one
 * server file, so the image needs no native build; see the README for why not node-datachannel).
 * Each peer binds one UDP port from the fixed range the security group opens.
 */
import { networkInterfaces } from 'node:os';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { EVENTS_CHANNEL, STATE_CHANNEL } from '../protocol';
import type { PeerFactory, PeerHooks, ServerPeer } from '../room-server';

export interface WeriftPeerOptions {
  /** UDP ports the security group allows in. One per connected player. */
  portRange: [number, number];
  /** STUN servers, so the task learns the public address its ENI is mapped to. */
  stunUrls?: string[];
  /** Bind to this local IPv4 address (default: the task's VPC address). */
  bindAddress?: string;
  /** Skip a snapshot when this many bytes are already queued for a player (their link is behind). */
  maxBufferedBytes?: number;
  /** Give ICE gathering this long before answering with what there is. */
  gatherTimeoutMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

export const DEFAULT_STUN_URLS = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

/**
 * The address to bind: the first IPv4 that is neither loopback nor link-local (a Fargate task also
 * has a 169.254.x.x interface for the ECS agent, which players can never reach).
 */
export function vpcAddress(interfaces = networkInterfaces()): string | undefined {
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return undefined;
}

/** A `PeerFactory` making one werift peer connection per player. */
export function weriftPeers(opts: WeriftPeerOptions): PeerFactory {
  const bind = opts.bindAddress ?? vpcAddress();
  const maxBuffered = opts.maxBufferedBytes ?? 64_000;
  const log = opts.log ?? (() => undefined);

  return (hooks: PeerHooks): ServerPeer => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: opts.stunUrls ?? DEFAULT_STUN_URLS }],
      iceUseDefaultStunServer: false,
      icePortRange: opts.portRange,
      iceUseIpv6: false,
      ...(bind ? { iceInterfaceAddresses: { udp4: bind } } : {}),
    });
    let state: RTCDataChannel | undefined;
    let events: RTCDataChannel | undefined;
    let opened = false;
    let closed = false;

    const text = (data: string | Buffer) => (typeof data === 'string' ? data : data.toString('utf8'));
    const closeOnce = () => {
      if (closed) return;
      closed = true;
      pc.close().catch(() => undefined);
      hooks.onClosed();
    };
    const maybeOpen = () => {
      if (opened || closed || state?.readyState !== 'open' || events?.readyState !== 'open') return;
      opened = true;
      hooks.onOpen({
        state: (json) => {
          // Unreliable means "latest or nothing": never queue behind a slow link.
          if (state!.readyState === 'open' && state!.bufferedAmount < maxBuffered) state!.send(json);
        },
        event: (json) => {
          if (events!.readyState === 'open') events!.send(json);
        },
        close: closeOnce,
      });
    };

    pc.onDataChannel.subscribe((channel) => {
      if (channel.label === STATE_CHANNEL && !state) {
        state = channel;
        channel.onMessage.subscribe((data) => hooks.onState(text(data)));
      } else if (channel.label === EVENTS_CHANNEL && !events) {
        events = channel;
        channel.onMessage.subscribe((data) => hooks.onEvent(text(data)));
      } else {
        channel.close();
        return;
      }
      channel.stateChanged.subscribe((s) => {
        if (s === 'open') maybeOpen();
        else if (s === 'closed') closeOnce();
      });
      maybeOpen();
    });
    pc.connectionStateChange.subscribe((s) => {
      if (s === 'failed' || s === 'closed' || s === 'disconnected') closeOnce();
    });

    return {
      async answer(offerSdp) {
        await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        await pc.setLocalDescription(await pc.createAnswer());
        // Answer with every candidate in the SDP (one message, nothing to trickle from here).
        if (pc.iceGatheringState !== 'complete') {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              log('ICE gathering is slow; answering with what there is');
              resolve();
            }, opts.gatherTimeoutMs ?? 4000);
            pc.iceGatheringStateChange.subscribe((s) => {
              if (s === 'complete') {
                clearTimeout(timer);
                resolve();
              }
            });
          });
        }
        const sdp = pc.localDescription?.sdp;
        if (!sdp) throw new Error('No local description');
        return sdp;
      },
      async addCandidate(candidate) {
        if (closed) return;
        await pc.addIceCandidate(candidate as Parameters<typeof pc.addIceCandidate>[0]);
      },
      close: closeOnce,
    };
  };
}
