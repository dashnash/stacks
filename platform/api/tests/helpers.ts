import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { codeChallenge, MemoryStore, randomToken, unauthorized } from '@stacks/api';
import type { AppManifest } from '@stacks/manifest';
import { createPlatformApp } from '../src/app';
import type { PlatformDeps, RegisteredApp } from '../src/model';

export const privateApp: AppManifest = {
  slug: 'club',
  name: 'Book Club',
  tagline: 'Read together',
  description: 'A private club.',
  visibility: 'private',
  roles: [
    { id: 'OWNER', label: 'Owner', canManageAccess: true, canManageApprovers: true },
    { id: 'ADMIN', label: 'Admin', canManageAccess: true },
    { id: 'MEMBER', label: 'Member' },
  ],
  topRole: 'OWNER',
  defaultRole: 'MEMBER',
  owners: ['owner@test.dev'],
};

export const publicApp: AppManifest = {
  slug: 'hello',
  name: 'Hello Board',
  tagline: 'Say hi',
  description: 'Public.',
  visibility: 'public',
  roles: [
    { id: 'OWNER', label: 'Owner', canManageAccess: true, canManageApprovers: true },
    { id: 'MEMBER', label: 'Member' },
  ],
  topRole: 'OWNER',
  defaultRole: 'MEMBER',
  owners: ['owner@test.dev'],
};

export interface Res {
  status: number;
  body: any;
  location?: string;
  cookies: string[];
}

export function cookieFrom(cookies: string[], name: string): string | undefined {
  const c = cookies.find((s) => s.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.slice(name.length + 1).split(';')[0]!) : undefined;
}

export function event(method: string, path: string, opts: { cookies?: Record<string, string>; body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: { ...(method !== 'GET' ? { 'x-stacks-request': '1' } : {}), ...opts.headers },
    cookies: Object.entries(opts.cookies ?? {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`),
    queryStringParameters: opts.query,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

export function toRes(raw: unknown): Res {
  const r = raw as { statusCode: number; body?: string; headers?: Record<string, string>; cookies?: string[] };
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined, location: r.headers?.Location, cookies: r.cookies ?? [] };
}

/** The platform in memory: fake Google (`test:<email>:<Full Name>`), a fixed registry, a recording revoker. */
export function createPlatformHarness(opts: { apps?: AppManifest[]; admins?: string[]; revoke?: (slug: string, email: string) => Promise<void> } = {}) {
  const store = new MemoryStore();
  const revoked: string[] = [];
  let clock = Date.parse('2026-03-01T00:00:00Z');
  let id = 0;
  const apps: RegisteredApp[] = (opts.apps ?? [privateApp, publicApp]).map((manifest) => ({ manifest, credential: async () => `cred-${manifest.slug}` }));
  const deps: PlatformDeps = {
    store,
    config: { rootDomain: 'stacks.test', authOrigin: 'https://auth.stacks.test', googleClientId: 'gid', platformAdmins: opts.admins ?? ['root@test.dev'] },
    registry: { list: async () => apps },
    appSessions: {
      endUserSessions: async (slug, email) => {
        revoked.push(`${slug}:${email}`);
        await opts.revoke?.(slug, email);
      },
    },
    verifyGoogle: async (credential) => {
      const [scheme, email, name] = credential.split(':');
      if (scheme !== 'test' || !email) throw unauthorized('bad credential');
      return { email, name: name ?? email.split('@')[0]! };
    },
    now: () => new Date((clock += 1000)),
    newId: () => `id${++id}`,
  };
  const app = createPlatformApp(deps);
  const portalTokens = new Map<string, string>();

  async function signIn(email: string, name?: string): Promise<string> {
    const res = toRes(await app(event('POST', '/api/auth/google', { body: { credential: `test:${email}${name ? `:${name}` : ''}` } })));
    if (res.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(res.body)}`);
    const token = cookieFrom(res.cookies, '__Host-stacks-portal')!;
    portalTokens.set(email, token);
    return token;
  }

  async function call(method: string, path: string, o: { as?: string; body?: unknown; query?: Record<string, string>; headers?: Record<string, string>; cookies?: Record<string, string> } = {}): Promise<Res> {
    const cookies = { ...o.cookies };
    if (o.as) cookies['__Host-stacks-portal'] = portalTokens.get(o.as) ?? (await signIn(o.as));
    return toRes(await app(event(method, path, { ...o, cookies })));
  }

  /** Start the handshake the way an app would (step 3). */
  async function authorize(slug: string, as?: string) {
    const verifier = randomToken();
    const state = randomToken();
    const query = {
      app: slug,
      state,
      redirect_uri: `https://${slug}.stacks.test/api/auth/callback`,
      code_challenge: await codeChallenge(verifier),
      code_challenge_method: 'S256',
    };
    const res = await call('GET', '/authorize', { as, query });
    const url = res.location ? new URL(res.location, 'https://auth.stacks.test') : undefined;
    return { res, url, verifier, state, redirectUri: query.redirect_uri, code: url?.searchParams.get('code') ?? undefined };
  }

  const advance = (ms: number) => {
    clock += ms;
  };

  return { app, deps, store, revoked, signIn, call, authorize, advance };
}
