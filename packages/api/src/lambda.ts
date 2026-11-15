import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { hasModule, type AppManifest } from '@stacks/manifest';
import { createStacksApp, type AppRoutes } from './app';
import { DynamoStore } from './dynamo-store';
import { gamesOff, type Games } from './games';
import type { AppDeps } from './model';
import type { Store } from './store';
import { HttpPlatformClient } from './platform';
import { realtimeOff, type Realtime } from './realtime';
import { appSyncRealtime, realtimeKeyReader } from './realtime-aws';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** The shared dependencies, wired from the environment the `PlatformApp` construct sets. */
export function defaultDeps(manifest: AppManifest): AppDeps {
  const secrets = new SecretsManagerClient({});
  let credential: Promise<string> | undefined;
  const store = new DynamoStore(env('TABLE_NAME'));
  return {
    store,
    config: { appOrigin: env('STACKS_APP_ORIGIN'), authOrigin: env('STACKS_AUTH_ORIGIN'), maintenance: process.env.STACKS_MAINTENANCE === '1' },
    platform: new HttpPlatformClient({
      baseUrl: env('STACKS_PLATFORM_URL'),
      appSlug: manifest.slug,
      credential: () =>
        (credential ??= secrets
          .send(new GetSecretValueCommand({ SecretId: env('STACKS_APP_SECRET_ARN') }))
          .then((r) => r.SecretString ?? '')
          .catch((err) => {
            credential = undefined;
            throw err;
          })),
    }),
    now: () => new Date(),
    newId: () => randomUUID(),
    realtime: defaultRealtime(manifest),
    games: defaultGames(manifest, store),
    ...(manifest.secrets?.length ? { secret: appSecrets(manifest) } : {}),
  };
}

/** The app's Event API, as `AppStack` wires it (`STACKS_REALTIME_*`), or the "turn it on" stand-in. */
function defaultRealtime(manifest: AppManifest): Realtime {
  if (!hasModule(manifest, 'realtime')) return realtimeOff(manifest.slug);
  return appSyncRealtime({
    httpHost: env('STACKS_REALTIME_HTTP_HOST'),
    realtimeHost: env('STACKS_REALTIME_WS_HOST'),
    namespace: process.env.STACKS_REALTIME_NAMESPACE || undefined,
    region: process.env.AWS_REGION ?? 'us-east-1',
    key: realtimeKeyReader({ secretId: env('STACKS_REALTIME_KEY_ARN') }),
  });
}

/**
 * Game servers as `AppStack` wires them (`STACKS_GAME_*`), or the "turn it on" stand-in. The ECS
 * client loads on first use, so apps without the module never pay for it.
 */
function defaultGames(manifest: AppManifest, store: Store): Games {
  if (!hasModule(manifest, 'gameServer')) return gamesOff(manifest.slug);
  let games: Promise<Games> | undefined;
  const load = () =>
    (games ??= import('./games-aws').then(({ awsGames }) =>
      awsGames({
        app: manifest.slug,
        store,
        clusterArn: env('STACKS_GAME_CLUSTER_ARN'),
        taskDefinition: env('STACKS_GAME_TASK_DEFINITION'),
        containerName: env('STACKS_GAME_CONTAINER'),
        subnetIds: env('STACKS_GAME_SUBNET_IDS').split(','),
        securityGroupId: env('STACKS_GAME_SECURITY_GROUP'),
        key: realtimeKeyReader({ secretId: env('STACKS_GAME_KEY_ARN') }),
        bundle: { bucket: env('STACKS_GAME_BUNDLE_BUCKET'), key: env('STACKS_GAME_BUNDLE_KEY') },
        ...(process.env.STACKS_GAME_TURN_PREFIX ? { turnPrefix: process.env.STACKS_GAME_TURN_PREFIX } : {}),
      }),
    ));
  return {
    start: async (roomId) => (await load()).start(roomId),
    stop: async (roomId) => (await load()).stop(roomId),
    running: async (roomIds) => (await load()).running(roomIds),
    key: async () => (await load()).key(),
    iceServers: async (ttl) => (await load()).iceServers(ttl),
    missingKeys: async () => (await load()).missingKeys?.() ?? [],
  };
}

const SECRET_TTL_MS = 5 * 60_000;

/**
 * Reads the app's secrets from SSM (`/stacks/<env>/secrets/<slug>/<NAME>`, SecureString), as the
 * `PlatformApp` construct allows. Only names the manifest declares; undefined when not set yet.
 */
export function appSecrets(manifest: AppManifest, opts: { client?: Pick<SSMClient, 'send'>; prefix?: string; now?: () => number } = {}) {
  const declared = new Set((manifest.secrets ?? []).map((s) => s.name));
  const client = opts.client ?? new SSMClient({});
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<string | undefined> }>();
  return (name: string): Promise<string | undefined> => {
    if (!declared.has(name)) return Promise.reject(new Error(`Secret ${name} is not declared in app.manifest.json "secrets"`));
    const hit = cache.get(name);
    if (hit && now() - hit.at < SECRET_TTL_MS) return hit.value;
    const prefix = opts.prefix ?? env('STACKS_SECRETS_PREFIX');
    const value = client
      .send(new GetParameterCommand({ Name: `${prefix}${name}`, WithDecryption: true }))
      .then((r) => r.Parameter?.Value || undefined)
      .catch((err: { name?: string }) => {
        if (err?.name === 'ParameterNotFound') return undefined;
        cache.delete(name);
        throw err;
      });
    cache.set(name, { at: now(), value });
    return value;
  };
}

/**
 * The Lambda entry point for an app:
 *
 *   export const handler = createLambdaHandler({ manifest, routes });
 *
 * Pass `extend` to add the app's own dependencies to the shared ones.
 */
export function createLambdaHandler<D extends AppDeps = AppDeps>(opts: {
  manifest: AppManifest;
  routes: (api: AppRoutes<D>) => void;
  extend?: (base: AppDeps) => D;
}): (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2> {
  const base = defaultDeps(opts.manifest);
  const deps = opts.extend ? opts.extend(base) : (base as D);
  return createStacksApp({ manifest: opts.manifest, deps, routes: opts.routes });
}

export { DynamoStore } from './dynamo-store';
export { appSyncRealtime, realtimeKeyReader, signRequest } from './realtime-aws';
export type { AwsCredentials } from './realtime-aws';

/** The app's private content bucket (the `contentPacks` module). */
export interface ContentStore {
  /** A short-lived link to a private object (default 15 minutes). */
  signUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /** Object keys under a prefix (cached for 10 minutes per container; `put` and `delete` clear it). */
  list(prefix: string): Promise<string[]>;
  /** Store an object, e.g. a file a member uploaded. Validate type and size before calling. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Delete an object. Deleting a key that doesn't exist is not an error. */
  delete(key: string): Promise<void>;
}

/**
 * Content stored in `CONTENT_BUCKET`, set by the PlatformApp construct when the app enables
 * `contentPacks`. `opts` are for tests.
 */
export function contentStore(opts: { bucket?: string; client?: Pick<S3Client, 'send'>; now?: () => number } = {}): ContentStore {
  const bucket = opts.bucket ?? env('CONTENT_BUCKET');
  const s3 = opts.client ?? new S3Client({});
  const now = opts.now ?? Date.now;
  const lists = new Map<string, { at: number; keys: string[] }>();
  return {
    signUrl: (key, expiresIn = 900) => getSignedUrl(s3 as S3Client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn }),
    async list(prefix) {
      const hit = lists.get(prefix);
      if (hit && now() - hit.at < 600_000) return hit.keys;
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of page.Contents ?? []) if (o.Key && !o.Key.endsWith('/')) keys.push(o.Key);
        token = page.NextContinuationToken;
      } while (token);
      lists.set(prefix, { at: now(), keys });
      return keys;
    },
    async put(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
      lists.clear();
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      lists.clear();
    },
  };
}
