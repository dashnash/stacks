import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { MemoryStore, unauthorized, type Item } from '@stacks/api';
import type { AppManifest } from '@stacks/manifest';
import { createPlatformApp, requestAccess, setGrant, userForIdentity, type PlatformDeps } from '@stacks/platform-api';
import { createClient } from '@stacks/web';
import { createPortalApi } from '../api';

const role = (id: string, label: string, manage = false, approvers = false) => ({ id, label, ...(manage ? { canManageAccess: true } : {}), ...(approvers ? { canManageApprovers: true } : {}) });

/** Sample apps the demo platform knows about. */
export const DEMO_APPS: AppManifest[] = [
  {
    slug: 'mofobookklub',
    name: 'MOFO Book Klub',
    tagline: 'Nominate, vote, read, meet.',
    description: "The club's next meeting, The Lineup of nominations and the shelf of past reads.",
    category: 'Clubs',
    visibility: 'private',
    roles: [role('OWNER', 'Owner', true, true), role('ADMIN', 'Admin', true), role('MEMBER', 'Member')],
    topRole: 'OWNER',
    defaultRole: 'MEMBER',
    owners: ['dash@demo.stacks'],
  },
  {
    slug: 'hello',
    name: 'Hello Board',
    tagline: 'Say hello to everyone on the platform.',
    description: 'The reference app: anyone signed in can leave a greeting.',
    category: 'Examples',
    visibility: 'public',
    roles: [role('OWNER', 'Owner', true, true), role('MEMBER', 'Member')],
    topRole: 'OWNER',
    defaultRole: 'MEMBER',
    owners: ['dash@demo.stacks'],
  },
  {
    slug: 'potluck',
    name: 'Potluck',
    tagline: 'Who is bringing what.',
    description: 'Sign-up sheets for dinners and parties, so there are not seven desserts.',
    category: 'Events',
    visibility: 'private',
    roles: [role('HOST', 'Host', true, true), role('GUEST', 'Guest')],
    topRole: 'HOST',
    defaultRole: 'GUEST',
    owners: ['priya@demo.stacks'],
  },
  {
    slug: 'pickup',
    name: 'Pickup Games',
    tagline: 'Find a game this week.',
    description: 'Schedule pickup soccer and basketball, see who is in.',
    category: 'Events',
    visibility: 'public',
    roles: [role('ORGANIZER', 'Organizer', true, true), role('PLAYER', 'Player')],
    topRole: 'ORGANIZER',
    defaultRole: 'PLAYER',
    owners: ['sam@demo.stacks'],
  },
];

export const DEMO_PEOPLE = [
  { email: 'dash@demo.stacks', name: 'Dash Nash', blurb: 'platform super-admin' },
  { email: 'priya@demo.stacks', name: 'Priya Rao', blurb: 'hosts Potluck' },
  { email: 'sam@demo.stacks', name: 'Sam Ortiz', blurb: 'new here' },
];

/** The real Platform API in the browser: in-memory data, persona sign-in instead of Google. */
export function createDemoPortal() {
  const store = new MemoryStore();
  let id = 0;
  const deps: PlatformDeps = {
    store,
    config: { rootDomain: 'demo.stacks', authOrigin: location.origin, googleClientId: 'demo', platformAdmins: ['dash@demo.stacks'] },
    registry: { list: async () => DEMO_APPS.map((manifest) => ({ manifest, credential: async () => 'demo' })) },
    appSessions: { endUserSessions: async () => undefined },
    verifyGoogle: async (credential) => {
      const person = DEMO_PEOPLE.find((p) => `demo:${p.email}` === credential);
      if (!person) throw unauthorized('Unknown demo person');
      return { email: person.email, name: person.name };
    },
    now: () => new Date(),
    newId: () => `d${++id}`,
  };
  const app = createPlatformApp(deps);
  let portalCookie: string | null = null;

  const seeded = (async () => {
    const [dash, priya, sam] = await Promise.all(DEMO_PEOPLE.map((p) => userForIdentity(deps, p)));
    const byApp = Object.fromEntries(DEMO_APPS.map((m) => [m.slug, m]));
    await setGrant(deps, dash!, byApp['mofobookklub']!, 'priya@demo.stacks', 'ADMIN');
    for (const [email, name] of [['kyle@demo.stacks', 'Kyle'], ['joe@demo.stacks', 'Joe'], ['mei@demo.stacks', 'Mei Chen']] as const) {
      const u = await userForIdentity(deps, { email, name });
      await setGrant(deps, dash!, byApp['mofobookklub']!, u.email, 'MEMBER');
      await requestAccess(deps, u, byApp.hello!);
    }
    await requestAccess(deps, sam!, byApp['mofobookklub']!);
    await requestAccess(deps, sam!, byApp.potluck!);
    await requestAccess(deps, priya!, byApp.pickup!);
    // A blocked person on a public app: signing in no longer gives them the default role.
    const troll = await userForIdentity(deps, { email: 'troll@demo.stacks', name: 'Rex Troll' });
    await setGrant(deps, dash!, byApp.hello!, troll.email, 'BLOCKED');
  })();

  const fetchShim = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    await seeded;
    const url = new URL(String(input), location.origin);
    const event = {
      rawPath: url.pathname,
      requestContext: { http: { method: (init.method ?? 'GET').toUpperCase() } },
      headers: { ...(init.headers as Record<string, string>) },
      cookies: portalCookie ? [`__Host-stacks-portal=${portalCookie}`] : [],
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: typeof init.body === 'string' ? init.body : undefined,
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2;
    const res = (await app(event)) as { statusCode: number; body?: string; headers?: Record<string, string>; cookies?: string[] };
    for (const c of res.cookies ?? []) {
      if (!c.startsWith('__Host-stacks-portal=')) continue;
      portalCookie = /Max-Age=0/.test(c) ? null : decodeURIComponent(c.split(';')[0]!.split('=')[1]!);
    }
    return new Response(res.body || '{}', { status: res.statusCode, headers: res.headers });
  };

  return { api: createPortalApi(createClient({ fetch: fetchShim as typeof fetch })), store: store as MemoryStore & { items: Map<string, Item> } };
}
