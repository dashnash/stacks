import { readFileSync } from 'node:fs';

export type EnvName = 'production' | 'staging';

/** One environment's settings from `stacks.config.json`. Nothing here is secret. */
export interface EnvConfig {
  /** Apps live at `<slug>.<rootDomain>`, sign-in at `auth.<rootDomain>`. */
  rootDomain: string;
  /**
   * Route 53 zone that holds `rootDomain`: its ID, or `"lookup"` to have CI find it by
   * `hostedZoneName` at deploy time (see `resolveZoneIds`). Leave empty to serve on CloudFront's
   * own domain (early testing).
   */
  hostedZoneId: string;
  /** That zone's name, e.g. `example.com` (defaults to `rootDomain`; required with `"lookup"`). */
  hostedZoneName?: string;
  /**
   * Old roots this environment moved away from. Each is served only as 301 redirects to the same
   * host label, path and query on `rootDomain` (the `stacks-<env>-legacy-redirect` stack).
   */
  legacyRedirects?: LegacyRedirect[];
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
  /**
   * Sign in with Apple on the web: the Services ID configured for `auth.<rootDomain>`
   * (docs/IOS_SETUP.md). Unset: the portal shows no Apple button in browsers (the iOS app still has one).
   */
  appleServicesId?: string;
}

export interface LegacyRedirect {
  /** The old root, e.g. `test.example.com`: `<label>.<old>` goes to `<label>.<rootDomain>`, the bare old root to `auth.`. */
  rootDomain: string;
  /** Route 53 zone that holds it: an ID or `"lookup"`, like `EnvConfig.hostedZoneId`. */
  hostedZoneId: string;
  /** That zone's name (defaults to `rootDomain`). */
  hostedZoneName?: string;
}

export interface NativeConfig {
  /** Apple Developer Team ID (10 characters). Until it is set, no apple-app-site-association is served. */
  appleTeamId?: string;
  /** The iOS app's bundle ID in this environment, e.g. `ninja.dashnash.stacks` (staging: `….test`). */
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
    // The portal's sign-in page (`/#/signin?next=/authorize…`) belongs to the browser that started
    // the sign-in: its state cookie is there, so finishing in the app could only fail.
    { '/': '/', '#': '/signin*', exclude: true },
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
    const where = `${path}: environments.${name}`;
    checkZone(where, env);
    if (env.legacyRedirects !== undefined && !Array.isArray(env.legacyRedirects)) throw new Error(`${where}.legacyRedirects must be a list`);
    for (const [i, old] of (env.legacyRedirects ?? []).entries()) {
      if (!DOMAIN.test(old?.rootDomain ?? '')) throw new Error(`${where}.legacyRedirects[${i}].rootDomain must be a domain name`);
      if (old.rootDomain === env.rootDomain) throw new Error(`${where}.legacyRedirects[${i}] redirects ${old.rootDomain} to itself`);
      if (!old.hostedZoneId) throw new Error(`${where}.legacyRedirects[${i}].hostedZoneId is required`);
      checkZone(`${where}.legacyRedirects[${i}]`, old);
    }
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.githubRepo ?? '')) throw new Error(`${path}: githubRepo must be "owner/repo"`);
  if (config.githubSubjectPrefix !== undefined && !/^repo:[^:\s]+$/.test(config.githubSubjectPrefix)) {
    throw new Error(`${path}: githubSubjectPrefix must look like "repo:owner/repo" or "repo:owner@id/repo@id"`);
  }
  return config;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ZONE_ID = /^Z[A-Z0-9]{1,31}$/;

function checkZone(where: string, z: { rootDomain: string; hostedZoneId: string; hostedZoneName?: string }) {
  if (!z.hostedZoneId) return;
  if (z.hostedZoneId === ZONE_LOOKUP) {
    if (!z.hostedZoneName) throw new Error(`${where}: hostedZoneName is required when hostedZoneId is "${ZONE_LOOKUP}"`);
  } else if (!ZONE_ID.test(z.hostedZoneId)) {
    throw new Error(`${where}: hostedZoneId "${z.hostedZoneId}" is neither a Route 53 zone ID nor "${ZONE_LOOKUP}"`);
  }
  const zoneName = z.hostedZoneName ?? z.rootDomain;
  if (z.rootDomain !== zoneName && !z.rootDomain.endsWith(`.${zoneName}`)) throw new Error(`${where}: ${z.rootDomain} is not inside the zone ${zoneName}`);
}

/** `hostedZoneId: "lookup"`: CI resolves the zone ID by name at deploy time. */
export const ZONE_LOOKUP = 'lookup';
/** What a `"lookup"` zone synthesizes to when no ID was given (sessions, `ci.yml`): never deployable. */
export const ZONE_ID_PLACEHOLDER = 'ZLOOKUPPLACEHOLDER';

/** Every zone name the config asks CI to look up (`hostedZoneId: "lookup"`), sorted, without repeats. */
export function zonesToLookUp(config: StacksConfig): string[] {
  const names = new Set<string>();
  for (const env of Object.values(config.environments)) {
    for (const z of [env, ...(env.legacyRedirects ?? [])]) if (z.hostedZoneId === ZONE_LOOKUP) names.add(z.hostedZoneName ?? z.rootDomain);
  }
  return [...names].sort();
}

/** Parses the `-c hostedZoneIds=<name>=<id>,<name>=<id>` context CI passes to synth. */
export function parseZoneIds(context: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (context ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, id, ...rest] = pair.split('=');
    if (!name || !id || rest.length || !DOMAIN.test(name) || !ZONE_ID.test(id)) throw new Error(`hostedZoneIds: "${pair}" is not <zone name>=<zone ID>`);
    out[name] = id;
  }
  return out;
}

/**
 * The environment with every `"lookup"` zone replaced by its ID from `zoneIds`. A zone missing
 * there becomes `ZONE_ID_PLACEHOLDER` (synth without AWS credentials still works), or, with
 * `strict` (CI builds that will be deployed), an error.
 */
export function resolveZoneIds(env: EnvConfig, zoneIds: Record<string, string>, strict = false): EnvConfig {
  const resolve = <Z extends { rootDomain: string; hostedZoneId: string; hostedZoneName?: string }>(z: Z): Z => {
    if (z.hostedZoneId !== ZONE_LOOKUP) return z;
    const name = z.hostedZoneName ?? z.rootDomain;
    const id = zoneIds[name];
    if (!id && strict) throw new Error(`No zone ID for ${name}: pass -c hostedZoneIds=${name}=<id> (CI looks it up with scripts/lookup-zones.mjs)`);
    return { ...z, hostedZoneId: id ?? ZONE_ID_PLACEHOLDER };
  };
  return { ...resolve(env), ...(env.legacyRedirects ? { legacyRedirects: env.legacyRedirects.map(resolve) } : {}) };
}

/** Short environment tag used in every resource name, so IAM can scope by prefix. */
export const envTag = (env: EnvName) => (env === 'production' ? 'prod' : 'test');

/** `stacks-prod-app-book-club`, `stacks-test-platform`, ... */
export function stackName(env: EnvName, kind: 'app' | 'platform' | 'ci' | 'legacy-redirect', slug?: string): string {
  if (kind === 'ci') return 'stacks-ci';
  if (kind === 'legacy-redirect') return `stacks-${envTag(env)}-legacy-redirect`;
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
