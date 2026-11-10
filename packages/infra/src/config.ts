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
