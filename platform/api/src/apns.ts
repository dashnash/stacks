import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import type { Device, PushMessage, PushSender } from './model';

/*
 * Apple Push Notification service, called directly over HTTP/2 with token auth: an ES256 JWT from
 * the APNs key (.p8), its Key ID and the Team ID. Apple wants the token refreshed between 20 and 60
 * minutes; one connection per APNs environment is kept for the Lambda container's life.
 */

const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' } as const;
const TOKEN_MS = 40 * 60_000;

export interface ApnsKey {
  keyId: string;
  teamId: string;
  /** The .p8 contents (PEM). */
  privateKeyPem: string;
}

/** The provider token Apple checks: ES256, `kid` = Key ID, `iss` = Team ID. */
export function apnsJwt(key: ApnsKey, now = Date.now()): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = `${b64({ alg: 'ES256', kid: key.keyId })}.${b64({ iss: key.teamId, iat: Math.floor(now / 1000) })}`;
  const sig = sign('sha256', Buffer.from(head), { key: createPrivateKey(key.privateKeyPem), dsaEncoding: 'ieee-p1363' });
  return `${head}.${sig.toString('base64url')}`;
}

/** The APNs JSON body for a message. Badge-only messages are silent. */
export function apnsPayload(m: PushMessage): Record<string, unknown> {
  const aps: Record<string, unknown> = { badge: m.badge };
  if (m.alert) {
    aps.alert = { title: m.alert.title, body: m.alert.body };
    aps.sound = 'default';
    if (m.threadId) aps['thread-id'] = m.threadId;
  }
  return { aps, ...(m.url ? { url: m.url } : {}) };
}

/** What a reply means for the device: 410, or 400 BadDeviceToken / DeviceTokenNotForTopic, means drop it. */
export function apnsOutcome(status: number, body: string): 'ok' | 'gone' | 'failed' {
  if (status === 200) return 'ok';
  if (status === 410) return 'gone';
  let reason = '';
  try {
    reason = (JSON.parse(body) as { reason?: string }).reason ?? '';
  } catch {
    /* not JSON */
  }
  if (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')) return 'gone';
  console.error(`APNs ${status} ${reason || body}`);
  return 'failed';
}

type Post = (env: Device['env'], path: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>;

/** One HTTP/2 POST to APNs (kept-alive session per environment). */
function http2Post(): Post {
  const sessions = new Map<string, ClientHttp2Session>();
  const session = (env: Device['env']) => {
    const existing = sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = connect(HOSTS[env]);
    s.on('error', () => sessions.delete(env));
    s.on('goaway', () => sessions.delete(env));
    s.unref();
    sessions.set(env, s);
    return s;
  };
  return (env, path, headers, body) =>
    new Promise((resolve, reject) => {
      const req = session(env).request({ [constants.HTTP2_HEADER_METHOD]: 'POST', [constants.HTTP2_HEADER_PATH]: path, ...headers });
      let status = 0;
      let data = '';
      req.setEncoding('utf8');
      req.setTimeout(10_000, () => req.close(constants.NGHTTP2_CANCEL));
      req.on('response', (h) => (status = Number(h[constants.HTTP2_HEADER_STATUS])));
      req.on('data', (chunk: string) => (data += chunk));
      req.on('end', () => resolve({ status, body: data }));
      req.on('error', reject);
      req.end(body);
    });
}

/**
 * A sender for the platform. `key()` loads the APNs key (from SSM in the Lambda); while it answers
 * undefined (not set up yet) nothing is sent.
 */
export function createApnsSender(opts: { key: () => Promise<ApnsKey | undefined>; post?: Post; now?: () => number }): PushSender {
  const post = opts.post ?? http2Post();
  const now = opts.now ?? Date.now;
  let cached: { jwt: string; at: number; keyId: string } | undefined;
  return {
    async send(device, message) {
      const key = await opts.key();
      if (!key) return 'failed';
      if (!cached || cached.keyId !== key.keyId || now() - cached.at > TOKEN_MS) cached = { jwt: apnsJwt(key, now()), at: now(), keyId: key.keyId };
      const headers = {
        authorization: `bearer ${cached.jwt}`,
        'apns-topic': device.bundleId,
        // Badge-only updates are 'alert' pushes too (a 'background' push doesn't reliably set the badge).
        'apns-push-type': 'alert',
        'apns-priority': message.alert ? '10' : '5',
      };
      const res = await post(device.env, `/3/device/${device.token}`, headers, JSON.stringify(apnsPayload(message)));
      if (res.status === 403 && /ExpiredProviderToken|InvalidProviderToken/.test(res.body)) cached = undefined;
      return apnsOutcome(res.status, res.body);
    },
  };
}
