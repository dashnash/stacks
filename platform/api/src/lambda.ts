import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoStore } from '@stacks/api/lambda';
import { createPlatformApp } from './app';
import { SsmAppRegistry } from './aws';
import { createGoogleVerifier } from './google';

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const registry = new SsmAppRegistry(env('STACKS_ENV_TAG'));
const rootDomain = env('STACKS_ROOT_DOMAIN');

const app = createPlatformApp({
  store: new DynamoStore(env('TABLE_NAME')),
  config: {
    rootDomain,
    authOrigin: `https://auth.${rootDomain}`,
    googleClientId: env('GOOGLE_CLIENT_ID'),
    platformAdmins: env('PLATFORM_ADMINS').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    maintenance: process.env.STACKS_MAINTENANCE === '1',
    minShellVersion: process.env.MIN_SHELL_VERSION || '1.0.0',
  },
  registry,
  appSessions: registry,
  verifyGoogle: (credential) => verify(credential),
  now: () => new Date(),
  newId: () => randomUUID(),
});

let verifier: ReturnType<typeof createGoogleVerifier> | undefined;
const iosClientIds = (process.env.GOOGLE_IOS_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const verify = (credential: string) => (verifier ??= createGoogleVerifier(env('GOOGLE_CLIENT_ID'), undefined, iosClientIds))(credential);

export const handler = (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => app(event);
