import { randomUUID } from 'node:crypto';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoStore } from '@stacks/api/lambda';
import { createApnsSender, type ApnsKey } from './apns';
import { createAppleVerifier } from './apple';
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
    iosBundleId: process.env.IOS_BUNDLE_ID || undefined,
    appleServicesId: process.env.APPLE_SERVICES_ID || undefined,
  },
  // Tokens from the iOS app are addressed to its bundle ID; from the portal's Apple JS, to the Services ID.
  verifyApple: (credential) => (appleVerifier ??= createAppleVerifier([process.env.IOS_BUNDLE_ID, process.env.APPLE_SERVICES_ID].filter((a): a is string => !!a)))(credential),
  push: createApnsSender({ key: apnsKey }),
  registry,
  appSessions: registry,
  verifyGoogle: (credential) => verify(credential),
  now: () => new Date(),
  newId: () => randomUUID(),
});

/**
 * The APNs key, stored by an admin as SecureStrings `<prefix>APNS_KEY` (the .p8) and
 * `<prefix>APNS_KEY_ID` (docs/IOS_SETUP.md); the Team ID is in stacks.config.json. Cached for five
 * minutes; undefined (nothing is pushed) until both are set.
 */
let apnsCache: { at: number; value: Promise<ApnsKey | undefined> } | undefined;
function apnsKey(): Promise<ApnsKey | undefined> {
  if (apnsCache && Date.now() - apnsCache.at < 300_000) return apnsCache.value;
  const prefix = process.env.PLATFORM_SECRETS_PREFIX ?? '';
  const teamId = process.env.APPLE_TEAM_ID ?? '';
  const value = (async () => {
    if (!prefix || !teamId) return undefined;
    const res = await new SSMClient({}).send(new GetParametersCommand({ Names: [`${prefix}APNS_KEY`, `${prefix}APNS_KEY_ID`], WithDecryption: true }));
    const get = (n: string) => res.Parameters?.find((p) => p.Name === `${prefix}${n}`)?.Value?.trim();
    const privateKeyPem = get('APNS_KEY');
    const keyId = get('APNS_KEY_ID');
    return privateKeyPem && keyId ? { privateKeyPem, keyId, teamId } : undefined;
  })().catch((err) => {
    console.error('Could not read the APNs key', err);
    apnsCache = undefined;
    return undefined;
  });
  apnsCache = { at: Date.now(), value };
  return value;
}

let appleVerifier: ReturnType<typeof createAppleVerifier> | undefined;
let verifier: ReturnType<typeof createGoogleVerifier> | undefined;
const iosClientIds = (process.env.GOOGLE_IOS_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const verify = (credential: string) => (verifier ??= createGoogleVerifier(env('GOOGLE_CLIENT_ID'), undefined, iosClientIds))(credential);

export const handler = (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => app(event);
