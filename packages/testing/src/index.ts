import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import {
  createSession,
  createStacksApp,
  MemoryStore,
  SESSION_COOKIE,
  type AppDeps,
  type AppRoutes,
  type AuditEvent,
  type PlatformClient,
  type PortalBarData,
  type AppAccess,
  type AppMember,
  type StacksUser,
} from '@stacks/api';
import type { AppManifest } from '@stacks/manifest';

/** A stand-in for the platform: hands out sign-in codes and collects mirrored audit events. */
export class FakePlatform implements PlatformClient {
  readonly audit: AuditEvent[] = [];
  private readonly codes = new Map<string, { user: StacksUser; role: string; redirectUri?: string }>();
  private next = 0;

  /** What the platform would do at step 7: remember who signed in and return a one-time code. */
  issueCode(user: StacksUser, role: string): string {
    const code = `code-${++this.next}`;
    this.codes.set(code, { user, role });
    return code;
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }) {
    const grant = this.codes.get(input.code);
    if (!grant) throw new Error('unknown or used code');
    this.codes.delete(input.code);
    return { user: grant.user, role: grant.role };
  }

  async recordAudit(event: AuditEvent): Promise<void> {
    this.audit.push(event);
  }

  /** People with access, as the platform would report them; tests can edit this directly. */
  members: AppMember[] = [];
  pending: AppMember[] = [];
  notifications: { email: string; text: string; link?: string }[] = [];
  async access(): Promise<AppAccess> {
    return { members: [...this.members], pending: [...this.pending] };
  }
  async setAccess(_actor: string, email: string, role: string | null): Promise<void> {
    const current = [...this.members, ...this.pending].find((m) => m.email === email);
    this.members = this.members.filter((m) => m.email !== email);
    this.pending = this.pending.filter((m) => m.email !== email);
    if (role) this.members.push({ email, name: current?.name ?? email.split('@')[0]!, role });
  }
  async notify(email: string, text: string, link?: string): Promise<void> {
    this.notifications.push({ email, text, link });
  }

  /** Set what portalBar() returns. */
  bar: PortalBarData = { portalUrl: 'https://auth.stacks.test', unread: 0, apps: [] };
  async portalBar(): Promise<PortalBarData> {
    return this.bar;
  }
}

export interface CallOptions {
  /** Call as this signed-in user (a session is created on the fly). */
  as?: string | StacksUser;
  /** Their role in the app; defaults to the manifest's defaultRole, else its last role. */
  role?: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  /** Leave out the CSRF header the web SDK always sends (to test the check). */
  noCsrf?: boolean;
}

export interface CallResult {
  status: number;
  body: any;
  headers: Record<string, string>;
  /** `Set-Cookie` values. */
  cookies: string[];
}

/** A user for tests: the name is the part of the email before "@". */
export const userFor = (email: string): StacksUser => ({ email, name: email.split('@')[0]! });

/**
 * Run an app's real API in memory: a {@link MemoryStore}, a {@link FakePlatform}, a clock that
 * ticks a second per read, and sequential ids.
 *
 *   const t = createTestHarness({ manifest, routes });
 *   const res = await t.call('POST', '/greetings', { as: 'alice@test', body: { text: 'hi' } });
 */
export function createTestHarness<D extends AppDeps = AppDeps>(opts: {
  manifest: AppManifest;
  routes: (api: AppRoutes<D>) => void;
  extend?: (base: AppDeps) => D;
  appOrigin?: string;
  authOrigin?: string;
}) {
  const store = new MemoryStore();
  const platform = new FakePlatform();
  let id = 0;
  let clock = new Date('2026-01-01T00:00:00Z').getTime();
  const base: AppDeps = {
    store,
    platform,
    config: {
      appOrigin: opts.appOrigin ?? `https://${opts.manifest.slug}.stacks.test`,
      authOrigin: opts.authOrigin ?? 'https://auth.stacks.test',
    },
    now: () => new Date((clock += 1000)),
    newId: () => `id${++id}`,
  };
  const deps = opts.extend ? opts.extend(base) : (base as D);
  const app = createStacksApp({ manifest: opts.manifest, deps, routes: opts.routes });
  const defaultRole = opts.manifest.defaultRole ?? opts.manifest.roles.at(-1)!.id;

  /** A session token for a user, as if they had just come through the handshake. */
  async function sessionFor(who: string | StacksUser, role = defaultRole): Promise<string> {
    return createSession(deps, typeof who === 'string' ? userFor(who) : who, role);
  }

  async function call(method: string, path: string, callOpts: CallOptions = {}): Promise<CallResult> {
    const cookies = { ...callOpts.cookies };
    if (callOpts.as) cookies[SESSION_COOKIE] = await sessionFor(callOpts.as, callOpts.role);
    const headers: Record<string, string> = { ...callOpts.headers };
    if (method !== 'GET' && !callOpts.noCsrf) headers['X-Stacks-Request'] = '1';
    const event = {
      rawPath: `/api${path}`,
      requestContext: { http: { method } },
      headers,
      cookies: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`),
      queryStringParameters: callOpts.query,
      body: callOpts.body === undefined ? undefined : JSON.stringify(callOpts.body),
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2;
    const res = (await app(event)) as { statusCode: number; body?: string; headers?: Record<string, string>; cookies?: string[] };
    return {
      status: res.statusCode,
      body: res.body ? JSON.parse(res.body) : undefined,
      headers: res.headers ?? {},
      cookies: res.cookies ?? [],
    };
  }

  /** Move the clock forward, e.g. to let a session go idle. */
  const advance = (ms: number) => {
    clock += ms;
  };

  return { app, call, deps, store, platform, sessionFor, advance };
}

/** The value a `Set-Cookie` header sets for `name`, or undefined. */
export function cookieValue(setCookies: string[], name: string): string | undefined {
  const c = setCookies.find((s) => s.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.slice(name.length + 1).split(';')[0]!) : undefined;
}
