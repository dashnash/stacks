/**
 * The `realtime` module, server side: channel declarations with guards, the token route, the
 * token format and the AppSync Events authorizer's checks. Runs the same in Lambda, in tests and in
 * the browser demo (Web Crypto only). The AWS wiring (SigV4 publish, the key from Secrets Manager,
 * the authorizer's Lambda entry) is in `realtime-aws.ts` and `realtime-authorizer.ts`.
 *
 * Delivery is at most once: events are hints to refetch or small updates, never the only copy of
 * anything. Writes that change data still go through normal HTTP routes.
 */
import { base64url } from './crypto';
import { badRequest, forbidden, HttpError } from './http';

/** Largest event (its JSON envelope, in UTF-8 bytes) the SDK sends, on the server and in the browser. */
export const MAX_EVENT_BYTES = 4096;
/** Channels one token may name, subscribe and publish together. */
export const MAX_TOKEN_CHANNELS = 20;
/** How long a token is good for. The web SDK fetches a new one before then. */
export const TOKEN_TTL_SECONDS = 15 * 60;
/** AppSync takes at most this many events per HTTP publish. */
export const MAX_EVENTS_PER_PUBLISH = 5;
/** The one channel namespace each app's Event API has. Channels are `/<namespace>/<app channel>`. */
export const REALTIME_NAMESPACE = 'app';
/** The tag server publishes carry (clients never use it). */
export const SERVER_SENDER = 'server';

/** One channel segment as AppSync allows it: letters, digits and `-`, up to 50, not starting or ending with `-`. */
const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;
/** AppSync allows 5 segments including the namespace. */
const MAX_SEGMENTS = 4;

/** The caller of the token route, as route guards see them (`v`). */
export interface ChannelViewer {
  user: { id: string };
  role: string;
  canManageAccess: boolean;
}

/**
 * Decides whether `v` may use a channel. `id` is what the pattern's `*` matched (`list/*` on
 * `list/42` gives `"42"`; several `*` are joined with `/`; `""` for a pattern with none).
 */
export type ChannelGuard<V extends ChannelViewer = ChannelViewer> = (v: V, id: string) => boolean | Promise<boolean>;

export interface ChannelGuards<V extends ChannelViewer = ChannelViewer> {
  subscribe: ChannelGuard<V> | boolean;
  /** `false` (the default): only the server publishes here. */
  publish?: ChannelGuard<V> | boolean;
}

/** How an app declares its channels: `api.realtime.channel('room/*', { subscribe: v => true, publish: v => true })`. */
export interface RealtimeChannels<V extends ChannelViewer = ChannelViewer> {
  channel(pattern: string, guards: ChannelGuards<V>): RealtimeChannels<V>;
}

/** What the module gives an app's handlers (`v.deps.realtime`). */
export interface Realtime {
  /**
   * Send `data` (any JSON, at most 4 KB) to everyone subscribed to `channel`, e.g. `counter/main`.
   * An array sends one event per element (wrap an array to send it as one event). At most once:
   * clients refetch when they reconnect, so treat events as hints.
   */
  publish(channel: string, data: unknown): Promise<void>;
  /** For the token route: where browsers connect and the key tokens are signed with. */
  connection(): Promise<RealtimeConnection>;
}

export interface RealtimeConnection {
  /** HMAC key the token route signs with and the authorizer checks. */
  key: string;
  /** `wss://…appsync-realtime-api…/event/realtime`, or `demo:` in the browser demo. */
  endpoint: string;
  /** The Event API's HTTP host, which every realtime message names for auth. */
  host: string;
  namespace: string;
}

/** What the token route returns. */
export interface RealtimeTokenResponse {
  token: string;
  /** ISO time; the web SDK refreshes a minute before. */
  expiresAt: string;
  endpoint: string;
  host: string;
  namespace: string;
}

/** What a client or the server puts on the wire: the data plus who sent it (for the echo filter). */
export interface RealtimeEnvelope {
  d: unknown;
  /** `server`, or the sending tab's random tag. */
  f: string;
  /** A random event id, so a client can drop the copy it gets twice while re-subscribing. */
  i?: string;
}

/** `deps.realtime` for an app without the module: every call says how to turn it on. */
export function realtimeOff(slug: string): Realtime {
  const fail = () => Promise.reject(new Error(`${slug} does not have the realtime module: add "realtime" to "modules" in app.manifest.json`));
  return { publish: fail, connection: fail };
}

/** Is this a channel name an app may use (`counter/main`, `room/lobby`)? */
export function isChannelName(channel: unknown): channel is string {
  if (typeof channel !== 'string') return false;
  const parts = channel.split('/');
  return parts.length >= 1 && parts.length <= MAX_SEGMENTS && parts.every((p) => SEGMENT.test(p));
}

/** Throw unless `channel` is a valid app channel name. */
export function checkChannelName(channel: string): void {
  if (!isChannelName(channel)) {
    throw new Error(`"${channel}" is not a channel name: 1-${MAX_SEGMENTS} segments of letters, digits and "-", separated by "/"`);
  }
}

/** The wire envelope for one event, checked against {@link MAX_EVENT_BYTES}. */
export function envelope(data: unknown, from: string): string {
  if (data === undefined) throw new Error('Realtime events need data (use null for "something changed")');
  const i = base64url(globalThis.crypto.getRandomValues(new Uint8Array(9)));
  const json = JSON.stringify({ d: data, f: from, i } satisfies RealtimeEnvelope);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_EVENT_BYTES) throw new Error(`Realtime event is ${bytes} bytes; the limit is ${MAX_EVENT_BYTES}. Send an id and let clients fetch the rest.`);
  return json;
}

/** Parse an envelope off the wire; null for anything that isn't one. */
export function openEnvelope(raw: unknown): RealtimeEnvelope | null {
  try {
    const value = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Partial<RealtimeEnvelope> | null;
    if (!value || typeof value !== 'object' || !('d' in value) || typeof value.f !== 'string') return null;
    return { d: value.d, f: value.f, ...(typeof value.i === 'string' ? { i: value.i } : {}) };
  } catch {
    return null;
  }
}

/** `publish(channel, data | data[])` as a list of events. */
export function eventsOf(data: unknown): unknown[] {
  return Array.isArray(data) ? data : [data];
}

// --- Channel declarations ----------------------------------------------------------------------

interface Declaration<V extends ChannelViewer> {
  pattern: string;
  segments: string[];
  guards: ChannelGuards<V>;
}

/** The app's declared channels: matching and guard checks for the token route. */
export class ChannelRegistry<V extends ChannelViewer = ChannelViewer> implements RealtimeChannels<V> {
  private readonly declarations: Declaration<V>[] = [];

  channel(pattern: string, guards: ChannelGuards<V>): this {
    const segments = pattern.split('/');
    if (segments.length > MAX_SEGMENTS || !segments.every((s) => s === '*' || SEGMENT.test(s))) {
      throw new Error(`realtime.channel("${pattern}"): use 1-${MAX_SEGMENTS} segments of letters, digits, "-" or "*", e.g. "room/*"`);
    }
    if (this.declarations.some((d) => d.pattern === pattern)) throw new Error(`realtime.channel("${pattern}") is declared twice`);
    if (guards?.subscribe === undefined) throw new Error(`realtime.channel("${pattern}") needs a subscribe guard`);
    this.declarations.push({ pattern, segments, guards });
    return this;
  }

  get size(): number {
    return this.declarations.length;
  }

  /** The declaration for a channel and what its `*`s matched. Literal patterns win over wildcards. */
  match(channel: string): { declaration: Declaration<V>; id: string } | null {
    const parts = channel.split('/');
    let best: { declaration: Declaration<V>; id: string; literals: number } | null = null;
    for (const d of this.declarations) {
      if (d.segments.length !== parts.length) continue;
      const ids: string[] = [];
      let literals = 0;
      let ok = true;
      d.segments.forEach((s, i) => {
        if (s === '*') ids.push(parts[i]!);
        else if (s === parts[i]) literals++;
        else ok = false;
      });
      if (ok && (!best || literals > best.literals)) best = { declaration: d, id: ids.join('/'), literals };
    }
    return best && { declaration: best.declaration, id: best.id };
  }

  /** Check a token request against the declarations; throws an HttpError saying which channel failed. */
  async check(viewer: V, request: { subscribe: string[]; publish: string[] }): Promise<void> {
    const pass = async (guard: ChannelGuard<V> | boolean | undefined, id: string) =>
      typeof guard === 'function' ? (await guard(viewer, id)) === true : guard === true;
    for (const [kind, channels] of [['subscribe', request.subscribe], ['publish', request.publish]] as const) {
      for (const channel of channels) {
        const hit = this.match(channel);
        if (!hit) throw forbidden(`Channel "${channel}" is not declared`, 'REALTIME_UNDECLARED');
        const guard = kind === 'subscribe' ? hit.declaration.guards.subscribe : hit.declaration.guards.publish;
        if (kind === 'publish' && !guard) throw forbidden(`Only the server publishes on "${channel}"`, 'REALTIME_SUBSCRIBE_ONLY');
        if (!(await pass(guard, hit.id))) throw forbidden(`You can't ${kind} on "${channel}"`, 'REALTIME_REFUSED');
      }
    }
  }
}

/** Validate the token route's body: `{ subscribe: string[], publish: string[] }`, 1-20 channels in all. */
export function parseTokenRequest(body: Record<string, unknown>): { subscribe: string[]; publish: string[] } {
  const list = (field: 'subscribe' | 'publish') => {
    const value = body[field] ?? [];
    if (!Array.isArray(value)) throw badRequest(`"${field}" must be a list of channels`);
    for (const c of value) if (!isChannelName(c)) throw badRequest(`"${String(c)}" is not a channel name`);
    return [...new Set(value as string[])];
  };
  const subscribe = list('subscribe');
  const publish = list('publish');
  const total = subscribe.length + publish.length;
  if (total === 0) throw badRequest('Name at least one channel');
  if (total > MAX_TOKEN_CHANNELS) throw new HttpError(400, `At most ${MAX_TOKEN_CHANNELS} channels per token`, 'REALTIME_TOO_MANY');
  return { subscribe, publish };
}

// --- Tokens --------------------------------------------------------------------------------------

/** What a realtime token says: who, exactly which channels, until when. */
export interface RealtimeClaims {
  v: 1;
  /** The user's platform id. */
  u: string;
  /** App channels they may subscribe to (exact names, no wildcards). */
  s: string[];
  /** App channels they may publish on. */
  p: string[];
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const TOKEN_PREFIX = 'srt1';
const encoder = new TextEncoder();

async function hmac(key: string, data: string): Promise<string> {
  const k = await globalThis.crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, encoder.encode(data))));
}

function b64urlJson(value: unknown): string {
  return base64url(encoder.encode(JSON.stringify(value)));
}

function fromB64url(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Constant-time string compare (both are base64url HMACs of the same length when valid). */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `srt1.<claims>.<HMAC-SHA256>`, base64url. */
export async function signRealtimeToken(key: string, claims: RealtimeClaims): Promise<string> {
  const body = `${TOKEN_PREFIX}.${b64urlJson(claims)}`;
  return `${body}.${await hmac(key, body)}`;
}

/** The claims of a genuine, unexpired token, or null. */
export async function verifyRealtimeToken(key: string, token: unknown, nowMs: number): Promise<RealtimeClaims | null> {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const expected = await hmac(key, `${parts[0]}.${parts[1]}`);
  if (!sameString(expected, parts[2]!)) return null;
  let claims: RealtimeClaims;
  try {
    claims = JSON.parse(fromB64url(parts[1]!)) as RealtimeClaims;
  } catch {
    return null;
  }
  if (claims?.v !== 1 || typeof claims.u !== 'string' || !Array.isArray(claims.s) || !Array.isArray(claims.p) || typeof claims.exp !== 'number') return null;
  if (claims.exp * 1000 <= nowMs) return null;
  return claims;
}

// --- The AppSync Events Lambda authorizer --------------------------------------------------------

/**
 * What AppSync Events sends a Lambda authorizer: the `Authorization` value, plus the operation and
 * (for subscribe and publish) the full channel, e.g. `/app/counter/main`.
 */
export interface EventsAuthorizerEvent {
  authorizationToken?: string;
  requestContext?: {
    apiId?: string;
    accountId?: string;
    requestId?: string;
    operation?: 'EVENT_CONNECT' | 'EVENT_SUBSCRIBE' | 'EVENT_PUBLISH' | string;
    channelNamespaceName?: string;
    channel?: string;
  };
  requestHeaders?: Record<string, string>;
}

export interface EventsAuthorizerResult {
  isAuthorized: boolean;
  /** 0: never cache, so every subscribe and publish is checked against its own channel. */
  ttlOverride: number;
  handlerContext?: Record<string, string>;
}

/**
 * The authorizer's decision. Connect needs a valid token; subscribe and publish also need the
 * exact channel in the token's subscribe or publish list. Anything it can't place (no channel, an
 * unknown operation, another namespace) is denied.
 */
export async function authorizeRealtime(event: EventsAuthorizerEvent, key: string, nowMs: number, namespace = REALTIME_NAMESPACE): Promise<EventsAuthorizerResult> {
  const deny: EventsAuthorizerResult = { isAuthorized: false, ttlOverride: 0 };
  const claims = await verifyRealtimeToken(key, event.authorizationToken, nowMs);
  if (!claims) return deny;
  const allow: EventsAuthorizerResult = { isAuthorized: true, ttlOverride: 0, handlerContext: { userId: claims.u } };
  const op = event.requestContext?.operation;
  if (op === 'EVENT_CONNECT') return allow;
  if (op !== 'EVENT_SUBSCRIBE' && op !== 'EVENT_PUBLISH') return deny;
  const full = event.requestContext?.channel;
  const prefix = `/${namespace}/`;
  if (typeof full !== 'string' || !full.startsWith(prefix)) return deny;
  const channel = full.slice(prefix.length);
  const allowed = op === 'EVENT_SUBSCRIBE' ? claims.s : claims.p;
  return allowed.includes(channel) ? allow : deny;
}
