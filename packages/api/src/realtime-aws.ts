/**
 * The `realtime` module on AWS: publishing to the app's AppSync Event API over HTTP (SigV4, the
 * Lambda's own role) and the token-signing key from Secrets Manager. Node only.
 */
import { createHash, createHmac } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { checkChannelName, envelope, eventsOf, MAX_EVENTS_PER_PUBLISH, REALTIME_NAMESPACE, SERVER_SENDER, type Realtime, type RealtimeConnection } from './realtime';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256Hex = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

/** AWS Signature Version 4 headers for a JSON POST (enough for AppSync Events' HTTP publish). */
export function signRequest(opts: {
  url: string;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
  /** Headers to sign instead of the default `content-type: application/json` (the Events WebSocket wants its own set). */
  headers?: Record<string, string>;
}): Record<string, string> {
  const url = new URL(opts.url);
  const amzDate = opts.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...(opts.headers ?? { 'content-type': 'application/json' }),
    host: url.host,
    'x-amz-date': amzDate,
    ...(opts.credentials.sessionToken ? { 'x-amz-security-token': opts.credentials.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    'POST',
    url.pathname || '/',
    url.searchParams.toString(),
    names.map((n) => `${n}:${headers[n]!.trim()}\n`).join(''),
    names.join(';'),
    sha256Hex(opts.body),
  ].join('\n');
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${opts.credentials.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, opts.region), opts.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

/** The Lambda's role credentials (Lambda always sets these). */
export function lambdaCredentials(): AwsCredentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('No AWS credentials in the environment');
  return { accessKeyId, secretAccessKey, ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}) };
}

const KEY_TTL_MS = 5 * 60_000;

/** The realtime key (a Secrets Manager secret), cached for five minutes per container. */
export function realtimeKeyReader(opts: { secretId: string; client?: Pick<SecretsManagerClient, 'send'>; now?: () => number }) {
  const client = opts.client ?? new SecretsManagerClient({});
  const now = opts.now ?? Date.now;
  let cached: { at: number; value: Promise<string> } | undefined;
  return (): Promise<string> => {
    if (cached && now() - cached.at < KEY_TTL_MS) return cached.value;
    const value = client.send(new GetSecretValueCommand({ SecretId: opts.secretId })).then((r) => {
      if (!r.SecretString) throw new Error('The realtime key secret is empty');
      return r.SecretString;
    });
    value.catch(() => (cached = undefined));
    cached = { at: now(), value };
    return value;
  };
}

/**
 * `deps.realtime` on AWS: publishes with SigV4 to `https://<httpHost>/event`, at most
 * {@link MAX_EVENTS_PER_PUBLISH} events per request. `opts` are for tests.
 */
export function appSyncRealtime(opts: {
  httpHost: string;
  realtimeHost: string;
  region: string;
  key: () => Promise<string>;
  namespace?: string;
  credentials?: () => AwsCredentials;
  fetch?: typeof fetch;
  now?: () => Date;
}): Realtime {
  const namespace = opts.namespace ?? REALTIME_NAMESPACE;
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const credentials = opts.credentials ?? lambdaCredentials;
  const now = opts.now ?? (() => new Date());
  const url = `https://${opts.httpHost}/event`;
  return {
    async publish(channel, data) {
      checkChannelName(channel);
      // Check every event first, so a batch with one oversized event sends nothing.
      const events = eventsOf(data).map((d) => envelope(d, SERVER_SENDER));
      for (let i = 0; i < events.length; i += MAX_EVENTS_PER_PUBLISH) {
        const body = JSON.stringify({ channel: `/${namespace}/${channel}`, events: events.slice(i, i + MAX_EVENTS_PER_PUBLISH) });
        const headers = signRequest({ url, body, region: opts.region, service: 'appsync', credentials: credentials(), now: now() });
        const res = await doFetch(url, { method: 'POST', headers, body });
        const answer = (await res.json().catch(() => ({}))) as { failed?: unknown[]; errors?: unknown[] };
        if (!res.ok || answer.failed?.length || answer.errors?.length) {
          throw new Error(`Realtime publish to ${channel} failed (${res.status}): ${JSON.stringify(answer).slice(0, 500)}`);
        }
      }
    },
    async connection(): Promise<RealtimeConnection> {
      return { key: await opts.key(), endpoint: `wss://${opts.realtimeHost}/event/realtime`, host: opts.httpHost, namespace };
    },
  };
}
