import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import {
  createSession,
  createStacksApp,
  MemoryStore,
  SESSION_COOKIE,
  type AppDeps,
  type AppRoutes,
  type AuditEvent,
  type Item,
  type PlatformClient,
  type AccountData,
  type AppAccess,
  type StacksUser,
} from '@stacks/api';
import type { AppManifest } from '@stacks/manifest';
import { createClient, type Client, type Navigator } from '@stacks/web';

export interface Persona {
  email: string;
  name: string;
  /** One of the manifest's role ids. */
  role: string;
  /** One line on who they are, shown in the persona switcher. */
  blurb?: string;
  pictureUrl?: string;
}

export interface DemoOptions<D extends AppDeps> {
  manifest: AppManifest;
  routes: (api: AppRoutes<D>) => void;
  extend?: (base: AppDeps) => D;
  /** People to try the app as; the first is used when "Sign in" is pressed. Usually one per role. */
  personas: Persona[];
  /** People waiting for approval, shown on the app's access page. */
  pending?: { email: string; name: string }[];
  /** Sample data, written on first load (and after a reset). */
  seed?: (deps: D) => Promise<void>;
  /** Where changes are kept between visits; set false to keep nothing. Default `stacks-demo:<slug>`. */
  storageKey?: string | false;
}

/** The platform as the demo plays it: no real sign-in, and the activity log just stays local. */
class DemoPlatform implements PlatformClient {
  readonly audit: AuditEvent[] = [];
  async exchangeCode(): Promise<{ user: StacksUser; role: string }> {
    throw new Error('The demo signs personas in directly');
  }
  async recordAudit(event: AuditEvent): Promise<void> {
    this.audit.push(event);
  }
  readonly notifications: { email: string; text: string; link?: string }[] = [];
  constructor(
    private readonly self: { slug: string; name: string },
    private readonly roles: { id: string; label: string; canManageAccess?: boolean }[],
    /** Shared with the demo: role changes here change who each persona signs in as. */
    private readonly personas: Persona[],
    private pendingPeople: { email: string; name: string }[],
  ) {}
  /** Set by the demo when someone signs in, so the menu shows their role. */
  current: Persona | null = null;
  async account(): Promise<AccountData> {
    const persona = this.current;
    const def = persona ? this.roles.find((r) => r.id === persona.role) : undefined;
    return {
      portalUrl: '#/',
      profileUrl: '#/',
      inboxUrl: '#/',
      unread: 2,
      app: { ...this.self, roleLabel: def?.label ?? null },
      apps: [{ ...this.self, url: '#/' }, { slug: 'other', name: 'Another app (demo)', url: '#/' }],
      manage: def?.canManageAccess ? { pending: this.pendingPeople.length, href: '#/' } : null,
    };
  }
  async access(): Promise<AppAccess> {
    return {
      members: this.personas.filter((p) => p.role).map((p) => ({ email: p.email, name: p.name, role: p.role, ...(p.pictureUrl ? { pictureUrl: p.pictureUrl } : {}) })),
      pending: this.pendingPeople.map((p) => ({ ...p, role: 'PENDING', requestedAt: '2026-11-01T12:00:00.000Z' })),
    };
  }
  async setAccess(_actor: string, email: string, role: string | null): Promise<void> {
    const waiting = this.pendingPeople.find((p) => p.email === email);
    this.pendingPeople = this.pendingPeople.filter((p) => p.email !== email);
    const persona = this.personas.find((p) => p.email === email);
    if (persona) persona.role = role ?? '';
    else if (waiting && role) this.personas.push({ ...waiting, role, blurb: 'just approved' });
  }
  async notify(email: string, text: string, link?: string): Promise<void> {
    this.notifications.push({ email, text, link });
  }
}

export interface Demo {
  /** Pass to `<StacksProvider client navigator>` (DemoApp does this). */
  client: Client;
  navigator: Navigator;
  personas: Persona[];
  current(): Persona | null;
  signInAs(email: string | null): Promise<void>;
  /** Wipe changes and re-seed. */
  reset(): Promise<void>;
  /** Called after sign-in changes, so the UI can re-read the session. */
  subscribe(listener: () => void): () => void;
  /** Wait until seeding has finished. */
  ready: Promise<void>;
}

function load(key: string | false): Item[] | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Item[]) : null;
  } catch {
    return null;
  }
}

function save(key: string | false, store: MemoryStore): void {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify([...store.items.values()]));
  } catch {
    // Storage unavailable or full: the demo keeps working for this visit.
  }
}

/**
 * The app's real API, running in the browser against an in-memory store, with the platform
 * replaced by persona sign-in. Lets anyone try the whole app with no AWS or Google.
 */
export function createDemo<D extends AppDeps = AppDeps>(opts: DemoOptions<D>): Demo {
  const personas: Persona[] = opts.personas.map((p) => ({ ...p }));
  const key = opts.storageKey === undefined ? `stacks-demo:${opts.manifest.slug}` : opts.storageKey;
  const saved = load(key);
  const store = new MemoryStore(saved ?? []);
  const demoPlatform = new DemoPlatform({ slug: opts.manifest.slug, name: opts.manifest.name }, opts.manifest.roles, personas, opts.pending ?? []);
  const base: AppDeps = {
    store,
    platform: demoPlatform,
    config: { appOrigin: globalThis.location?.origin ?? 'https://demo.local', authOrigin: 'https://auth.demo.local' },
    now: () => new Date(),
    newId: () => globalThis.crypto.randomUUID(),
  };
  const deps = opts.extend ? opts.extend(base) : (base as D);
  const app = createStacksApp({ manifest: opts.manifest, deps, routes: opts.routes });
  const roles = new Set(opts.manifest.roles.map((r) => r.id));
  for (const p of personas) if (!roles.has(p.role)) throw new Error(`Demo persona ${p.email} has role "${p.role}", which the manifest does not declare`);

  let sessionToken: string | null = null;
  let persona: Persona | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  const seed = async () => {
    if (opts.seed) await opts.seed(deps);
    save(key, store);
  };
  const ready = saved ? Promise.resolve() : seed();

  const demoFetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    await ready;
    const url = new URL(String(input), 'https://demo.local');
    const method = (init.method ?? 'GET').toUpperCase();
    const event = {
      rawPath: url.pathname,
      requestContext: { http: { method } },
      headers: { ...(init.headers as Record<string, string>) },
      cookies: sessionToken ? [`${SESSION_COOKIE}=${sessionToken}`] : [],
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: typeof init.body === 'string' ? init.body : undefined,
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2;
    const res = (await app(event)) as { statusCode: number; body?: string; headers?: Record<string, string>; cookies?: string[] };
    for (const c of res.cookies ?? []) {
      if (c.startsWith(`${SESSION_COOKIE}=`) && c.includes('Max-Age=0')) {
        sessionToken = null;
        persona = null;
      }
    }
    if (method !== 'GET') save(key, store);
    return new Response(res.body || '{}', { status: res.statusCode, headers: res.headers });
  };

  const signInAs = async (email: string | null) => {
    await ready;
    persona = personas.find((p) => p.email === email && !!p.role) ?? null;
    demoPlatform.current = persona;
    sessionToken = persona
      ? await createSession(deps, { email: persona.email, name: persona.name, ...(persona.pictureUrl ? { pictureUrl: persona.pictureUrl } : {}) }, persona.role)
      : null;
    save(key, store);
    notify();
  };

  const navigator: Navigator = {
    current: () => (typeof window === 'undefined' ? '/' : window.location.hash),
    assign: (url) => {
      // "Sign in" goes through the platform in real life; here the first persona signs in.
      if (url.startsWith('/api/auth/login')) void signInAs(personas.find((p) => p.role)?.email ?? null);
      else if (url.includes('/logout')) void signInAs(null);
      else if (typeof window !== 'undefined') window.location.assign(url);
    },
  };

  return {
    client: createClient({ fetch: demoFetch as typeof fetch }),
    navigator,
    personas,
    current: () => persona,
    signInAs,
    reset: async () => {
      store.items.clear();
      sessionToken = null;
      persona = null;
      await seed();
      notify();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    ready,
  };
}
