import { randomUUID } from 'node:crypto';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { AppManifest } from '@stacks/manifest';
import { createStacksApp, type AppRoutes } from './app';
import { DynamoStore } from './dynamo-store';
import type { AppDeps } from './model';
import { HttpPlatformClient } from './platform';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** The shared dependencies, wired from the environment the `PlatformApp` construct sets. */
export function defaultDeps(manifest: AppManifest): AppDeps {
  const secrets = new SecretsManagerClient({});
  let credential: Promise<string> | undefined;
  return {
    store: new DynamoStore(env('TABLE_NAME')),
    config: { appOrigin: env('STACKS_APP_ORIGIN'), authOrigin: env('STACKS_AUTH_ORIGIN') },
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
    ...(manifest.secrets?.length ? { secret: appSecrets(manifest) } : {}),
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

/** The app's private content bucket (the `contentPacks` module). */
export interface ContentStore {
  /** A short-lived link to a private object (default 15 minutes). */
  signUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /** Object keys under a prefix (cached for 10 minutes per container). */
  list(prefix: string): Promise<string[]>;
}

/** Content stored in `CONTENT_BUCKET`, set by the PlatformApp construct when the app enables `contentPacks`. */
export function contentStore(): ContentStore {
  const bucket = env('CONTENT_BUCKET');
  const s3 = new S3Client({});
  const lists = new Map<string, { at: number; keys: string[] }>();
  return {
    signUrl: (key, expiresIn = 900) => getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn }),
    async list(prefix) {
      const hit = lists.get(prefix);
      if (hit && Date.now() - hit.at < 600_000) return hit.keys;
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of page.Contents ?? []) if (o.Key && !o.Key.endsWith('/')) keys.push(o.Key);
        token = page.NextContinuationToken;
      } while (token);
      lists.set(prefix, { at: Date.now(), keys });
      return keys;
    },
  };
}
