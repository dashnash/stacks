import { readFileSync } from 'node:fs';

export type EnvName = 'production' | 'staging';

/** One environment's settings from `stacks.config.json`. Nothing here is secret. */
export interface EnvConfig {
  /** Apps live at `<slug>.<rootDomain>`, sign-in at `auth.<rootDomain>`. */
  rootDomain: string;
  /** Route 53 zone that holds `rootDomain`. Leave empty to serve on CloudFront's own domain (early testing). */
  hostedZoneId: string;
  /** That zone's name, e.g. `example.com` (defaults to `rootDomain`). */
  hostedZoneName?: string;
  googleClientId: string;
  platformAdmins: string[];
  /**
   * App slugs not deployed to this environment yet, e.g. while another site still owns their
   * hostname (Book Club's old stack holds mofobookklub.<domain> until the cut-over).
   */
  holdApps?: string[];
  /**
   * While true, the platform API and every app API answer 503 "Back in a few minutes" (except
   * health checks), so data can be migrated with nothing writing to it (the user-id cut-over).
   */
  maintenance?: boolean;
  /** The native iOS app for this environment (docs/NATIVE_APP_SPEC.md). Nothing here is secret. */
  native?: NativeConfig;
}

export interface NativeConfig {
  /** Apple Developer Team ID (10 characters). Until it is set, no apple-app-site-association is served. */
  appleTeamId?: string;
  /** The iOS app's bundle ID in this environment, e.g. `com.dashyhq.stacks` (staging: `….test`). */
  iosBundleId?: string;
  /** iOS OAuth client IDs whose Google ID tokens the platform accepts (the token's `azp`). */
  googleIosClientIds?: string[];
  /** The oldest app version the web still supports; older ones are asked to update. Default 1.0.0. */
  minShellVersion?: string;
}

/**
 * The apple-app-site-association document for an environment, or null until the Team ID and
 * bundle ID are set. Every link to the platform's hosts opens in the app, except sign-in plumbing.
 */
export function appleAppSiteAssociation(env: EnvConfig): string | null {
  const team = env.native?.appleTeamId?.trim();
  const bundle = env.native?.iosBundleId?.trim();
  if (!team || !bundle) return null;
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error(`native.appleTeamId "${team}" is not a 10-character Apple Team ID`);
  const components = [
    { '/': '/api/*', exclude: true },
    { '/': '/authorize', exclude: true },
    { '/': '/logout', exclude: true },
    { '/': '/.well-known/*', exclude: true },
    { '/': '*' },
  ];
  return JSON.stringify({ applinks: { details: [{ appIDs: [`${team}.${bundle}`], components }] } });
}

/**
 * The part of a CloudFront viewer-request function that answers
 * `/.well-known/apple-app-site-association` itself (JSON, no redirect), so every host serves it.
 */
export function aasaRoute(env: EnvConfig): string {
  const aasa = appleAppSiteAssociation(env);
  if (!aasa) return '';
  return `
  if (request.uri === '/.well-known/apple-app-site-association') {
    return { statusCode: 200, statusDescription: 'OK', headers: { 'content-type': { value: 'application/json' }, 'cache-control': { value: 'public, max-age=3600' } }, body: { encoding: 'text', data: ${JSON.stringify(aasa)} } };
  }`;
}

export interface StacksConfig {
  region: string;
  /** `owner/repo`, trusted by the CI roles. */
  githubRepo: string;
  /** OIDC `sub` prefix GitHub sends for the repo (needed when it uses immutable subject claims). */
  githubSubjectPrefix?: string;
  environments: Record<EnvName, EnvConfig>;
}

export function loadStacksConfig(path: string): StacksConfig {
  const config = JSON.parse(readFileSync(path, 'utf8')) as StacksConfig;
  for (const name of ['production', 'staging'] as const) {
    const env = config.environments?.[name];
    if (!env?.rootDomain) throw new Error(`${path}: environments.${name}.rootDomain is required`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.githubRepo ?? '')) throw new Error(`${path}: githubRepo must be "owner/repo"`);
  if (config.githubSubjectPrefix !== undefined && !/^repo:[^:\s]+$/.test(config.githubSubjectPrefix)) {
    throw new Error(`${path}: githubSubjectPrefix must look like "repo:owner/repo" or "repo:owner@id/repo@id"`);
  }
  return config;
}

/** Short environment tag used in every resource name, so IAM can scope by prefix. */
export const envTag = (env: EnvName) => (env === 'production' ? 'prod' : 'test');

/** `stacks-prod-app-book-club`, `stacks-test-platform`, ... */
export function stackName(env: EnvName, kind: 'app' | 'platform' | 'ci', slug?: string): string {
  if (kind === 'ci') return 'stacks-ci';
  return kind === 'app' ? `stacks-${envTag(env)}-app-${slug}` : `stacks-${envTag(env)}-platform`;
}

/** CDK bootstrap qualifier per environment: staging deploys through its own, permission-limited roles. */
export const bootstrapQualifier = (env: EnvName) => (env === 'production' ? 'stkprod' : 'stktest');

/** The managed policy every IAM role created by a staging deploy must carry as its permissions boundary. */
export const STAGING_BOUNDARY_NAME = 'stacks-test-boundary';

export const authOrigin = (env: EnvConfig) => `https://auth.${env.rootDomain}`;
export const appOrigin = (env: EnvConfig, slug: string) => `https://${slug}.${env.rootDomain}`;
/** SSM parameter names the platform stack writes and app stacks read at deploy time. */
export const ssmNames = (env: EnvName) => ({
  certificateArn: `/stacks/${envTag(env)}/certificate-arn`,
});
