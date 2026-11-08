import { randomUUID } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
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
