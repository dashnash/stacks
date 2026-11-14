import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import {
  createSession,
  createStacksApp,
  fixtureUserId,
  envelope,
  eventsOf,
  isChannelName,
  MemoryStore,
  realtimeOff,
  REALTIME_NAMESPACE,
  SERVER_SENDER,
  SESSION_COOKIE,
  setLogSink,
  type AppDeps,
  type AppRoutes,
  type AuditEvent,
  type LogLine,
  type PlatformClient,
  type AccountData,
  type AppAccess,
  type AppMember,
  type Realtime,
  type RealtimeConnection,
  type StacksUser,
} from '@stacks/api';
import { hasModule, type AppManifest } from '@stacks/manifest';

/**
 * `deps.realtime` for API tests: records what the server publishes, with the same checks as the
 * real one (channel names, the 4 KB limit). `published` has one entry per event.
 */
export class FakeRealtime implements Realtime {
  readonly published: { channel: string; data: unknown }[] = [];
  /** The key tokens are signed with here (to check them with `verifyRealtimeToken`). */
  readonly key = 'test-realtime-key';
  async publish(channel: string, data: unknown): Promise<void> {
    if (!isChannelName(channel)) throw new Error(`"${channel}" is not a channel name`);
    const events = eventsOf(data);
    for (const d of events) envelope(d, SERVER_SENDER);
    for (const d of events) this.published.push({ channel, data: d });
  }
  async connection(): Promise<RealtimeConnection> {
    return { key: this.key, endpoint: 'wss://realtime.stacks.test/event/realtime', host: 'events.stacks.test', namespace: REALTIME_NAMESPACE };
  }
  /** The data published on one channel, oldest first. */
  on(channel: string): unknown[] {
    return this.published.filter((p) => p.channel === channel).map((p) => p.data);
  }
}

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
  blocked: AppMember[] = [];
  notifications: { userId: string; text: string; link?: string }[] = [];
  /** Like the platform: members come without emails unless the manifest has `needsEmail` (the harness sets this). */
  needsEmail = false;
  async access(): Promise<AppAccess> {
    const view = (list: AppMember[]) => list.map(({ email, ...m }) => (this.needsEmail && email ? { ...m, email } : m));
    return { members: view(this.members), pending: view(this.pending), blocked: view(this.blocked) };
  }
  async setAccess(_actor: string, userId: string, role: string | null): Promise<void> {
    const current = [...this.members, ...this.pending, ...this.blocked].find((m) => m.id === userId);
    this.members = this.members.filter((m) => m.id !== userId);
    this.pending = this.pending.filter((m) => m.id !== userId);
    this.blocked = this.blocked.filter((m) => m.id !== userId);
    if (role) this.members.push({ id: userId, email: current?.email ?? `${userId}@test`, name: current?.name ?? userId, role });
  }
  async notify(userId: string, text: string, link?: string): Promise<void> {
    this.notifications.push({ userId, text, link });
  }

  /** Set what account() returns. */
  accountData: AccountData = {
    portalUrl: 'https://auth.stacks.test/#/',
    profileUrl: 'https://auth.stacks.test/#/profile',
    inboxUrl: 'https://auth.stacks.test/#/notifications',
    unread: 0,
    app: { slug: 'app', name: 'App', roleLabel: null },
    apps: [],
    manage: null,
  };
  async account(): Promise<AccountData> {
    return this.accountData;
  }
}

export interface CallOptions {
  /** Call as this signed-in user (a session is created on the fly). */
  as?: string | PersonLike;
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

/** The user id tests give an email: deterministic, so tests can name people by email (`alice@test` → `u_alice_test`). */
export const testUserId = (email: string): string => fixtureUserId(email);

/** A user for tests: the id comes from {@link testUserId}, the name is the part of the email before "@". */
export const userFor = (email: string): StacksUser => ({ id: testUserId(email), email, name: email.split('@')[0]! });

/** Someone to act as: an email, or a user whose id defaults to {@link testUserId} of their email. */
export type PersonLike = StacksUser | (Omit<StacksUser, 'id' | 'email'> & { email: string; id?: string });
const asUser = (who: string | PersonLike): StacksUser =>
  typeof who === 'string' ? userFor(who) : { ...who, id: who.id ?? testUserId(who.email ?? '') };

/** An app member for tests (for `FakePlatform.members`). */
export const memberFor = (email: string, role: string, name = email.split('@')[0]!): AppMember => ({ id: testUserId(email), email, name, role });

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
  /** Values for the manifest's `secrets` (anything not listed reads as not set). */
  secrets?: Record<string, string>;
}) {
  const store = new MemoryStore();
  const platform = new FakePlatform();
  const realtime = new FakeRealtime();
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
    realtime: hasModule(opts.manifest, 'realtime') ? realtime : realtimeOff(opts.manifest.slug),
    ...(opts.manifest.secrets?.length ? { secret: async (name: string) => opts.secrets?.[name] } : {}),
  };
  const deps = opts.extend ? opts.extend(base) : (base as D);
  const app = createStacksApp({ manifest: opts.manifest, deps, routes: opts.routes });
  const defaultRole = opts.manifest.defaultRole ?? opts.manifest.roles.at(-1)!.id;

  platform.needsEmail = !!opts.manifest.needsEmail;

  /** A session token for a user, as if they had just come through the handshake (no email unless `needsEmail`). */
  async function sessionFor(who: string | PersonLike, role = defaultRole): Promise<string> {
    const { email, ...user } = asUser(who);
    return createSession(deps, opts.manifest.needsEmail ? { ...user, email } : user, role);
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

  return { app, call, deps, store, platform, realtime, sessionFor, advance };
}

/** The value a `Set-Cookie` header sets for `name`, or undefined. */
export function cookieValue(setCookies: string[], name: string): string | undefined {
  const c = setCookies.find((s) => s.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.slice(name.length + 1).split(';')[0]!) : undefined;
}

/**
 * Collect the log lines written from here on (request lines, errors, the app's own `log.info`),
 * instead of printing them. Call `stop()` when done.
 *
 *   const logs = captureLogs();
 *   await t.call('GET', '/notes', { as: 'ann@test' });
 *   expect(logs.lines.at(-1)).toMatchObject({ type: 'request', route: '/api/notes', status: 200 });
 *   logs.stop();
 */
export function captureLogs(): { lines: LogLine[]; stop: () => void } {
  const lines: LogLine[] = [];
  const stop = setLogSink((_level, line) => void lines.push(line));
  return { lines, stop };
}
