import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { roleDef } from '@stacks/manifest';
import {
  badRequest,
  base64url,
  clearCookie,
  cookie,
  forbidden,
  notFound,
  optionalString,
  randomToken,
  Router,
  sha256Hex,
  unauthorized,
  type Item,
  type RequestContext,
  type RouteResult,
} from '@stacks/api';
import {
  appView,
  audit,
  createPortalSession,
  endPortalSession,
  getApp,
  getGrant,
  getUser,
  grantsForApp,
  grantsForUser,
  listApps,
  listAudit,
  listNotifications,
  managesApp,
  markNotificationsRead,
  PORTAL_COOKIE,
  PORTAL_IDLE_DAYS,
  readPortalSession,
  requestAccess,
  saveUser,
  setGrant,
  signOutEverywhere,
  storeAudit,
  userForIdentity,
} from './core';
import { appOrigin, isPlatformAdmin, MAX_DISPLAY_NAME, PENDING, shownName, type PlatformAuditEvent, type PlatformDeps, type PlatformUser, type RegisteredApp } from './model';

const CSRF_HEADER = 'x-stacks-request';
const CODE_TTL_MS = 60_000;

type AppEntry = RegisteredApp & { status: 'live' | 'archived' };

/** The Platform API: portal sign-in, the app handshake (`/authorize`, `/token`), catalog, access grid, audit. */
export function createPlatformApp(deps: PlatformDeps) {
  const router = new Router();
  const portalUrl = (hash = '/') => `${deps.config.authOrigin}/#${hash}`;

  const csrf = (req: RequestContext) => {
    if (req.method !== 'GET' && req.headers[CSRF_HEADER] !== '1') throw forbidden('Missing request header', 'CSRF');
  };
  async function requireUser(req: RequestContext): Promise<PlatformUser> {
    csrf(req);
    const user = await readPortalSession(deps, req.cookies[PORTAL_COOKIE]);
    if (!user) throw unauthorized();
    return user;
  }
  const signedIn = (handler: (req: RequestContext, user: PlatformUser) => Promise<RouteResult>) => async (req: RequestContext) =>
    handler(req, await requireUser(req));

  /** Apps call the platform with their credential as a Bearer token. */
  async function requireAppCaller(req: RequestContext): Promise<AppEntry> {
    const app = await getApp(deps, req.params.slug!, { includeArchived: true }).catch(() => null);
    const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!app || !presented || !(await sameSecret(presented, await app.credential()))) throw unauthorized('Unknown app or bad credential');
    return app;
  }

  const catalogEntry = (app: AppEntry, access: string | null, favorite: boolean) => ({
    slug: app.manifest.slug,
    name: app.manifest.name,
    tagline: app.manifest.tagline,
    description: app.manifest.description,
    category: app.manifest.category ?? null,
    visibility: app.manifest.visibility,
    url: `${appOrigin(deps.config, app.manifest.slug)}/`,
    status: app.status,
    access,
    accessLabel: access && access !== PENDING ? (roleDef(app.manifest, access)?.label ?? access) : null,
    favorite,
  });

  router
    .add('GET', '/health', async () => ({ body: { ok: true, platform: true } }))
    .add('GET', '/config', async () => ({ body: { googleClientId: deps.config.googleClientId, rootDomain: deps.config.rootDomain } }))

    /* ---------- Portal sign-in ---------- */
    .add('POST', '/auth/google', async (req) => {
      csrf(req);
      const credential = req.body.credential;
      if (typeof credential !== 'string' || !credential) throw badRequest('"credential" is required');
      const user = await userForIdentity(deps, await deps.verifyGoogle(credential));
      const token = await createPortalSession(deps, user);
      await audit(deps, user, 'platform', { action: 'auth.login' });
      return { body: { user: meView(deps, user) }, cookies: [cookie(PORTAL_COOKIE, token, PORTAL_IDLE_DAYS * 86_400)] };
    })
    .add('POST', '/auth/logout', async (req) => {
      csrf(req);
      const user = await readPortalSession(deps, req.cookies[PORTAL_COOKIE]);
      await endPortalSession(deps, req.cookies[PORTAL_COOKIE]);
      if (user) {
        await signOutEverywhere(deps, user.email);
        await audit(deps, user, 'platform', { action: 'auth.logout' });
      }
      return { body: { ok: true }, cookies: [clearCookie(PORTAL_COOKIE)] };
    })
    // Apps send people here after ending their own session; this ends everything else.
    .add('GET', '/logout', async (req) => {
      const user = await readPortalSession(deps, req.cookies[PORTAL_COOKIE]);
      await endPortalSession(deps, req.cookies[PORTAL_COOKIE]);
      if (user) {
        await signOutEverywhere(deps, user.email);
        await audit(deps, user, 'platform', { action: 'auth.logout' });
      }
      return { redirect: portalUrl('/?signedOut=1'), cookies: [clearCookie(PORTAL_COOKIE)] };
    })

    /* ---------- The handshake: steps 3-7 ---------- */
    .add('GET', '/authorize', async (req) => {
      const { app: slug, state, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: method } = req.query;
      if (!slug || !state || !redirectUri || !challenge || method !== 'S256') throw badRequest('Missing or invalid sign-in parameters');
      const app = await getApp(deps, slug).catch(() => null);
      if (!app) throw notFound(`No app "${slug}"`);
      if (redirectUri !== `${appOrigin(deps.config, slug)}/api/auth/callback`) throw badRequest('redirect_uri does not belong to this app');
      const back = (params: Record<string, string>) => ({ redirect: `${redirectUri}?${new URLSearchParams({ ...params, state })}` });

      const user = await readPortalSession(deps, req.cookies[PORTAL_COOKIE]);
      if (!user) {
        // Step 4: Google sign-in on the portal, then straight back here.
        const next = `/authorize?${new URLSearchParams(req.query)}`;
        return { redirect: portalUrl(`/signin?next=${encodeURIComponent(next)}`) };
      }
      let grant = await getGrant(deps, slug, user.email);
      if (!grant) grant = await requestAccess(deps, user, app.manifest); // public: default role; private: pending request
      if (grant.role === PENDING) return back({ error: 'access_pending' });

      const code = randomToken('stc_');
      const now = deps.now();
      await deps.store.put({
        PK: `CODE#${await sha256Hex(code)}`,
        SK: 'CODE',
        app: slug,
        email: user.email,
        redirectUri,
        challenge,
        notAfter: now.getTime() + CODE_TTL_MS,
        expiresAt: Math.floor(now.getTime() / 1000) + 300,
      });
      const recent = [slug, ...(user.recent ?? []).filter((s) => s !== slug)].slice(0, 8);
      if (recent.join() !== (user.recent ?? []).join()) await saveUser(deps, { ...user, recent });
      return back({ code });
    })
    // Step 8: the app's server swaps the code for the user and their role.
    .add('POST', '/apps/:slug/token', async (req) => {
      const app = await requireAppCaller(req);
      const code = String(req.body.code ?? '');
      const verifier = String(req.body.codeVerifier ?? '');
      const key = { PK: `CODE#${await sha256Hex(code)}`, SK: 'CODE' };
      const stored = await deps.store.get<Item & { app: string; email: string; redirectUri: string; challenge: string; notAfter: number }>(key.PK, key.SK);
      if (stored) await deps.store.delete(key.PK, key.SK); // single use, even when the checks below fail
      const invalid = () => badRequest('Invalid or expired sign-in code');
      if (!stored || stored.app !== app.manifest.slug || stored.notAfter < deps.now().getTime() || stored.redirectUri !== req.body.redirectUri) throw invalid();
      if (base64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))) !== stored.challenge) throw invalid();
      const user = await getUser(deps, stored.email);
      const grant = user && (await getGrant(deps, app.manifest.slug, user.email));
      if (!user || !grant || grant.role === PENDING) throw forbidden('No access to this app');
      return { body: { user: appView(user), role: grant.role } };
    })
    .add('POST', '/apps/:slug/audit', async (req) => {
      const app = await requireAppCaller(req);
      const e = req.body as Partial<PlatformAuditEvent>;
      if (typeof e.action !== 'string' || typeof e.actorEmail !== 'string') throw badRequest('Not an audit event');
      await storeAudit(deps, {
        id: String(e.id ?? deps.newId()),
        at: typeof e.at === 'string' ? e.at : deps.now().toISOString(),
        app: app.manifest.slug,
        actorEmail: e.actorEmail,
        actorName: String(e.actorName ?? e.actorEmail),
        action: e.action.slice(0, 80),
        ...(typeof e.label === 'string' ? { label: e.label.slice(0, 300) } : {}),
        ...(e.params && typeof e.params === 'object' ? { params: e.params } : {}),
        ...(e.details && typeof e.details === 'object' ? { details: e.details } : {}),
      });
      return { body: { ok: true } };
    })
    // For the portal bar inside apps: the user's apps and unread count (fetched by the app's server).
    .add('GET', '/apps/:slug/bar', async (req) => {
      await requireAppCaller(req);
      const email = String(req.query.email ?? '').toLowerCase();
      const grants = (await grantsForUser(deps, email)).filter((g) => g.role !== PENDING);
      const apps = (await listApps(deps)).filter((a) => grants.some((g) => g.app === a.manifest.slug));
      const unread = (await listNotifications(deps, email)).filter((n) => !n.read).length;
      return {
        body: { portalUrl: portalUrl('/'), unread, apps: apps.map((a) => ({ slug: a.manifest.slug, name: a.manifest.name, url: `${appOrigin(deps.config, a.manifest.slug)}/` })) },
      };
    })

    /* ---------- Portal: me, catalog, requests, notifications ---------- */
    .add('GET', '/me', signedIn(async (_req, user) => ({ body: { user: meView(deps, user), ...(await badges(deps, user)) } })))
    .add(
      'PATCH',
      '/me',
      signedIn(async (req, user) => {
        const displayName = optionalString(req.body, 'displayName', MAX_DISPLAY_NAME);
        const updated = { ...user, displayName };
        await saveUser(deps, updated);
        return { body: { user: meView(deps, updated) } };
      }),
    )
    .add('GET', '/public/catalog', async () => ({ body: { apps: (await listApps(deps)).map((a) => catalogEntry(a, null, false)) } }))
    .add(
      'GET',
      '/catalog',
      signedIn(async (_req, user) => {
        const grants = await grantsForUser(deps, user.email);
        const apps = await listApps(deps);
        return {
          body: {
            apps: apps.map((a) => catalogEntry(a, grants.find((g) => g.app === a.manifest.slug)?.role ?? null, user.favorites?.includes(a.manifest.slug) ?? false)),
            recent: user.recent ?? [],
          },
        };
      }),
    )
    .add(
      'POST',
      '/apps/:slug/request',
      signedIn(async (req, user) => {
        const app = await getApp(deps, req.params.slug!);
        const grant = await requestAccess(deps, user, app.manifest);
        return { body: { access: grant.role } };
      }),
    )
    .add(
      'PUT',
      '/me/favorites/:slug',
      signedIn(async (req, user) => {
        const slug = req.params.slug!;
        await getApp(deps, slug);
        const favorites = [...new Set([...(user.favorites ?? []), slug])];
        await saveUser(deps, { ...user, favorites });
        return { body: { favorites } };
      }),
    )
    .add(
      'DELETE',
      '/me/favorites/:slug',
      signedIn(async (req, user) => {
        const favorites = (user.favorites ?? []).filter((s) => s !== req.params.slug);
        await saveUser(deps, { ...user, favorites });
        return { body: { favorites } };
      }),
    )
    .add('GET', '/notifications', signedIn(async (_req, user) => ({ body: { notifications: await listNotifications(deps, user.email) } })))
    .add(
      'POST',
      '/notifications/read',
      signedIn(async (_req, user) => {
        await markNotificationsRead(deps, user.email);
        return { body: { ok: true } };
      }),
    )

    /* ---------- Access grid ---------- */
    .add(
      'GET',
      '/admin/access',
      signedIn(async (_req, user) => {
        const admin = isPlatformAdmin(deps, user.email);
        const apps: AppEntry[] = [];
        for (const a of await listApps(deps, { includeArchived: admin })) if ((await managesApp(deps, user.email, a.manifest)).manages) apps.push(a);
        if (!apps.length) throw forbidden('You do not manage access to any app');
        const grants = (await Promise.all(apps.map((a) => grantsForApp(deps, a.manifest.slug)))).flat();
        // Super-admins see every user; approvers see the people who have (or asked for) their apps.
        const emails = admin ? (await deps.store.queryGsi1<Item & { email: string }>('USERS')).map((u) => u.email) : [...new Set(grants.map((g) => g.email))];
        const users = (await Promise.all(emails.map((e) => getUser(deps, e)))).filter((u): u is PlatformUser => !!u);
        return {
          body: {
            isPlatformAdmin: admin,
            apps: await Promise.all(
              apps.map(async (a) => ({
                slug: a.manifest.slug,
                name: a.manifest.name,
                status: a.status,
                topRole: a.manifest.topRole,
                defaultRole: a.manifest.defaultRole ?? null,
                roles: a.manifest.roles.map((r) => ({ id: r.id, label: r.label, canManageAccess: !!r.canManageAccess })),
                canManageApprovers: (await managesApp(deps, user.email, a.manifest)).managesApprovers,
              })),
            ),
            users: users.map((u) => ({ email: u.email, name: shownName(u), pictureUrl: u.pictureUrl ?? null })).sort((a, b) => a.name.localeCompare(b.name)),
            grants: grants.map((g) => ({ app: g.app, email: g.email, role: g.role, requestedAt: g.requestedAt ?? null, grantedAt: g.grantedAt ?? null })),
          },
        };
      }),
    )
    .add(
      'PUT',
      '/admin/access/:slug/:email',
      signedIn(async (req, user) => {
        const app = await getApp(deps, req.params.slug!, { includeArchived: true });
        const role = req.body.role;
        if (role !== null && typeof role !== 'string') throw badRequest('"role" must be a role id or null');
        const grant = await setGrant(deps, user, app.manifest, req.params.email!, role);
        return { body: { grant } };
      }),
    )
    .add(
      'PUT',
      '/admin/apps/:slug/status',
      signedIn(async (req, user) => {
        if (!isPlatformAdmin(deps, user.email)) throw forbidden('Platform admins only');
        const status = req.body.status;
        if (status !== 'live' && status !== 'archived') throw badRequest('"status" must be "live" or "archived"');
        const app = await getApp(deps, req.params.slug!, { includeArchived: true });
        await deps.store.put({ PK: `APP#${app.manifest.slug}`, SK: 'APP', slug: app.manifest.slug, status, registeredAt: deps.now().toISOString() });
        await audit(deps, user, app.manifest.slug, { action: `app.${status === 'live' ? 'restore' : 'archive'}`, label: app.manifest.name });
        return { body: { status } };
      }),
    )
    .add(
      'GET',
      '/admin/audit',
      signedIn(async (req, user) => {
        const admin = isPlatformAdmin(deps, user.email);
        let apps: Set<string> | 'all' = 'all';
        if (!admin) {
          apps = new Set();
          for (const a of await listApps(deps)) if ((await managesApp(deps, user.email, a.manifest)).manages) apps.add(a.manifest.slug);
          if (!apps.size) throw forbidden('You do not manage any app');
        }
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        return { body: await listAudit(deps, { apps, app: req.query.app, actor: req.query.actor, action: req.query.action, before: req.query.before, limit }) };
      }),
    );

  return (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => router.handle(event);
}

function meView(deps: PlatformDeps, u: PlatformUser) {
  return {
    email: u.email,
    name: shownName(u),
    displayName: u.displayName ?? null,
    googleName: u.name,
    pictureUrl: u.pictureUrl ?? null,
    isPlatformAdmin: isPlatformAdmin(deps, u.email),
  };
}

/** Unread notifications, and requests waiting on this person. */
async function badges(deps: PlatformDeps, user: PlatformUser): Promise<{ unread: number; pendingRequests: number; managesApps: number }> {
  const unread = (await listNotifications(deps, user.email)).filter((n) => !n.read).length;
  let pendingRequests = 0;
  let managesApps = 0;
  for (const a of await listApps(deps)) {
    if (!(await managesApp(deps, user.email, a.manifest)).manages) continue;
    managesApps++;
    pendingRequests += (await grantsForApp(deps, a.manifest.slug)).filter((g) => g.role === PENDING).length;
  }
  return { unread, pendingRequests, managesApps };
}

/** Compare secrets without leaking their contents through timing. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  if (!b) return false;
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

