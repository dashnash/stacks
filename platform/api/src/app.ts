import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { roleDef } from '@stacks/manifest';
import {
  badRequest,
  base64url,
  clearCookie,
  cookie,
  forbidden,
  maintenance,
  MAINTENANCE_OPEN_PATHS,
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
  listIdentities,
  listNotifications,
  managesApp,
  markNotificationsRead,
  notify,
  PORTAL_COOKIE,
  PORTAL_IDLE_DAYS,
  readPortalSession,
  requestAccess,
  saveUser,
  setGrant,
  signOutEverywhere,
  storeAudit,
  userForIdentity,
  userIdForEmail,
} from './core';
import { linkGoogle, linkProvider, mergeWithTicket, unlinkIdentity } from './merge';
import { badges, deviceView, handlePushAction, listDevices, notificationSettings, registerDevice, removeDevice } from './push';
import { appOrigin, BLOCKED, holdsRole, isPlatformAdmin, MAX_DISPLAY_NAME, PENDING, shownName, type PlatformAuditEvent, type PlatformDeps, type PlatformUser, type RegisteredApp } from './model';

const CSRF_HEADER = 'x-stacks-request';
/** The bridge protocol the web speaks to the iOS app (native/protocol). */
export const NATIVE_PROTOCOL = 1;
const CODE_TTL_MS = 60_000;

type AppEntry = RegisteredApp & { status: 'live' | 'archived' };

/** The Platform API: portal sign-in, the app handshake (`/authorize`, `/token`), catalog, access grid, audit. */
export function createPlatformApp(deps: PlatformDeps) {
  const router = new Router().before((_method, path) => {
    if (deps.config.maintenance && !MAINTENANCE_OPEN_PATHS.has(path)) throw maintenance();
  });
  const portalUrl = (hash = '/') => `${deps.config.authOrigin}/#${hash}`;

  /** `{ credential, name? }` from the page, verified with Apple; the name only counts on a first sign-in. */
  async function verifyApple(body: Record<string, unknown>) {
    const credential = body.credential;
    if (typeof credential !== 'string' || !credential) throw badRequest('"credential" is required');
    if (!deps.verifyApple) throw unauthorized('Sign in with Apple is not set up here');
    const identity = await deps.verifyApple(credential);
    const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    return { ...identity, name: identity.name || name };
  }

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

  async function accountFor(app: AppEntry, userId: string): Promise<RouteResult> {
    const user = await getUser(deps, userId);
    if (!user) throw notFound('No such user');
    const slug = app.manifest.slug;
    const grants = (await grantsForUser(deps, user.id)).filter((g) => holdsRole(g.role));
    const apps = (await listApps(deps)).filter((a) => grants.some((g) => g.app === a.manifest.slug));
    const unread = (await listNotifications(deps, user.id)).filter((n) => !n.read).length;
    const role = grants.find((g) => g.app === slug)?.role;
    const { manages } = await managesApp(deps, user, app.manifest);
    const pending = manages ? (await grantsForApp(deps, slug)).filter((g) => g.role === PENDING).length : 0;
    return {
      body: {
        portalUrl: portalUrl('/'),
        profileUrl: portalUrl(`/profile?from=${encodeURIComponent(slug)}`),
        inboxUrl: portalUrl(`/notifications?from=${encodeURIComponent(slug)}`),
        unread,
        app: { slug, name: app.manifest.name, roleLabel: role ? (roleDef(app.manifest, role)?.label ?? role) : null },
        apps: apps.map((a) => ({ slug: a.manifest.slug, name: a.manifest.name, url: `${appOrigin(deps.config, a.manifest.slug)}/` })),
        manage: manages ? { pending, href: portalUrl(`/admin/access?app=${encodeURIComponent(slug)}`) } : null,
      },
    };
  }

  /** A single-use, 60-second code for this user and app, bound to the redirect URI and PKCE challenge. */
  async function issueCode(user: PlatformUser, slug: string, redirectUri: string, challenge: string): Promise<string> {
    const code = randomToken('stc_');
    const now = deps.now();
    await deps.store.put({
      PK: `CODE#${await sha256Hex(code)}`,
      SK: 'CODE',
      app: slug,
      userId: user.id,
      redirectUri,
      challenge,
      notAfter: now.getTime() + CODE_TTL_MS,
      expiresAt: Math.floor(now.getTime() / 1000) + 300,
    });
    const recent = [slug, ...(user.recent ?? []).filter((s) => s !== slug)].slice(0, 8);
    if (recent.join() !== (user.recent ?? []).join()) await saveUser(deps, { ...user, recent });
    return code;
  }

  /** Where to land after signing out: a page of a registered app or the portal; anything else is refused. */
  async function safeLogoutReturn(raw: string): Promise<string | null> {
    if (!raw) return null;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:') return null;
    if (url.origin === new URL(deps.config.authOrigin).origin) return url.toString();
    const apps = await listApps(deps);
    return apps.some((a) => appOrigin(deps.config, a.manifest.slug) === url.origin) ? url.toString() : null;
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
    accessLabel: holdsRole(access) ? (roleDef(app.manifest, access)?.label ?? access) : null,
    favorite,
  });

  router
    .add('GET', '/health', async () => ({ body: { ok: true, platform: true } }))
    .add('GET', '/config', async () => ({
      body: { googleClientId: deps.config.googleClientId, rootDomain: deps.config.rootDomain, appleServicesId: deps.config.appleServicesId ?? null },
    }))
    // For the iOS app (docs/NATIVE_APP_SPEC.md): which hosts open inside it, and the oldest app
    // version the web still supports. Public and cacheable; works during maintenance.
    .add('GET', '/native/config', async () => ({
      headers: { 'Cache-Control': 'public, max-age=300' },
      body: {
        protocol: NATIVE_PROTOCOL,
        minShellVersion: deps.config.minShellVersion ?? '1.0.0',
        authHost: new URL(deps.config.authOrigin).host,
        apps: (await listApps(deps)).map((a) => ({ slug: a.manifest.slug, name: a.manifest.name, host: new URL(appOrigin(deps.config, a.manifest.slug)).host })),
      },
    }))

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
    // Sign in with Apple: Apple JS on the portal (web) or the iOS app's native sheet. Apple puts no
    // name in the token, and gives one only on the very first sign-in: the page passes it along.
    .add('POST', '/auth/apple', async (req) => {
      csrf(req);
      const identity = await verifyApple(req.body);
      const user = await userForIdentity(deps, identity, 'apple');
      const token = await createPortalSession(deps, user);
      await audit(deps, user, 'platform', { action: 'auth.login', details: { provider: 'apple' } });
      return { body: { user: meView(deps, user) }, cookies: [cookie(PORTAL_COOKIE, token, PORTAL_IDLE_DAYS * 86_400)] };
    })
    .add('POST', '/auth/logout', async (req) => {
      csrf(req);
      const user = await readPortalSession(deps, req.cookies[PORTAL_COOKIE]);
      await endPortalSession(deps, req.cookies[PORTAL_COOKIE]);
      if (user) {
        await signOutEverywhere(deps, user.id);
        await audit(deps, user, 'platform', { action: 'auth.logout' });
      }
      return { body: { ok: true }, cookies: [clearCookie(PORTAL_COOKIE)] };
    })
    // Apps send people here after ending their own session; this ends everything else.
    .add('GET', '/logout', async (req) => {
      const user = await readPortalSession(deps, req.cookies[PORTAL_COOKIE]);
      await endPortalSession(deps, req.cookies[PORTAL_COOKIE]);
      if (user) {
        await signOutEverywhere(deps, user.id);
        await audit(deps, user, 'platform', { action: 'auth.logout' });
      }
      // Back to where they signed out: an app page (it then shows its signed-out view), else the portal.
      const ret = await safeLogoutReturn(String(req.query.return ?? ''));
      return { redirect: ret ?? portalUrl('/?signedOut=1'), cookies: [clearCookie(PORTAL_COOKIE)] };
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
      let grant = await getGrant(deps, slug, user.id);
      if (!grant) grant = await requestAccess(deps, user, app.manifest); // public: default role; private: pending request
      if (grant.role === BLOCKED) return back({ error: 'access_denied' });
      if (grant.role === PENDING) return back({ error: 'access_pending' });
      const code = await issueCode(user, slug, redirectUri, challenge);
      return back({ code });
    })
    // Silent sign-in: an app page asks (fetch, with the portal cookie) whether the person is already
    // signed in to the platform. Never redirects, never files a request: a private app the person
    // has no role in answers access_required, and the app offers "Request access".
    .add('GET', '/silent-authorize', async (req) => {
      const { app: slug, state, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: method } = req.query;
      const app = slug ? await getApp(deps, slug).catch(() => null) : null;
      const origin = app ? appOrigin(deps.config, app.manifest.slug) : null;
      // CORS: only the app's own origin may read the answer (with the cookie).
      if (!app || !origin || req.headers.origin !== origin) throw forbidden('Not allowed from this origin');
      const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' };
      const answer = (body: Record<string, unknown>, status = 200) => ({ status, body, headers: cors });
      if (!state || !challenge || method !== 'S256' || redirectUri !== `${origin}/api/auth/callback`) return answer({ error: 'invalid_request' }, 400);
      const user = await readPortalSession(deps, req.cookies[PORTAL_COOKIE]);
      if (!user) return answer({ error: 'login_required' });
      let grant = await getGrant(deps, app.manifest.slug, user.id);
      if (!grant && app.manifest.visibility === 'public') grant = await requestAccess(deps, user, app.manifest);
      if (!grant) return answer({ error: 'access_required' });
      if (grant.role === BLOCKED) return answer({ error: 'access_denied' });
      if (grant.role === PENDING) return answer({ error: 'access_pending' });
      return answer({ code: await issueCode(user, app.manifest.slug, redirectUri!, challenge), state });
    })
    // Step 8: the app's server swaps the code for the user and their role.
    .add('POST', '/apps/:slug/token', async (req) => {
      const app = await requireAppCaller(req);
      const code = String(req.body.code ?? '');
      const verifier = String(req.body.codeVerifier ?? '');
      const key = { PK: `CODE#${await sha256Hex(code)}`, SK: 'CODE' };
      const stored = await deps.store.get<Item & { app: string; userId: string; redirectUri: string; challenge: string; notAfter: number }>(key.PK, key.SK);
      if (stored) await deps.store.delete(key.PK, key.SK); // single use, even when the checks below fail
      const invalid = () => badRequest('Invalid or expired sign-in code');
      if (!stored || stored.app !== app.manifest.slug || stored.notAfter < deps.now().getTime() || stored.redirectUri !== req.body.redirectUri) throw invalid();
      if (base64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))) !== stored.challenge) throw invalid();
      const user = await getUser(deps, stored.userId);
      const grant = user && (await getGrant(deps, app.manifest.slug, user.id));
      if (!user || !grant || !holdsRole(grant.role)) throw forbidden('No access to this app');
      return { body: { user: appView(user, app.manifest), role: grant.role } };
    })
    .add('POST', '/apps/:slug/audit', async (req) => {
      const app = await requireAppCaller(req);
      const e = req.body as Partial<PlatformAuditEvent>;
      if (typeof e.action !== 'string' || typeof e.actorId !== 'string') throw badRequest('Not an audit event');
      await storeAudit(deps, {
        id: String(e.id ?? deps.newId()),
        at: typeof e.at === 'string' ? e.at : deps.now().toISOString(),
        app: app.manifest.slug,
        actorId: e.actorId.slice(0, 64),
        actorName: String(e.actorName ?? e.actorId).slice(0, 80),
        action: e.action.slice(0, 80),
        ...(typeof e.label === 'string' ? { label: e.label.slice(0, 300) } : {}),
        ...(e.params && typeof e.params === 'object' ? { params: e.params } : {}),
        ...(e.details && typeof e.details === 'object' ? { details: e.details } : {}),
      });
      return { body: { ok: true } };
    })
    // For the account menu inside apps: who you are here, your other apps, inbox, approvals.
    .add('GET', '/apps/:slug/account', async (req) => accountFor(await requireAppCaller(req), String(req.query.user ?? '')))

    // Who has a role in this app (for pickers and names), and who is waiting.
    .add('GET', '/apps/:slug/access', async (req) => {
      const app = await requireAppCaller(req);
      const grants = await grantsForApp(deps, app.manifest.slug);
      const people = await Promise.all(grants.map(async (g) => ({ g, u: await getUser(deps, g.userId) })));
      const view = people
        .filter((p) => p.u)
        .map(({ g, u }) => ({ ...appView(u!, app.manifest), role: g.role, requestedAt: g.requestedAt ?? null, grantedAt: g.grantedAt ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { body: { members: view.filter((p) => holdsRole(p.role)), pending: view.filter((p) => p.role === PENDING), blocked: view.filter((p) => p.role === BLOCKED) } };
    })
    // An app's own admin page changing a grant. The app vouches for the actor (from its session);
    // the platform still checks that the actor manages this app, with the same rules as the grid.
    .add('PUT', '/apps/:slug/access/:userId', async (req) => {
      const app = await requireAppCaller(req);
      const actor = await getUser(deps, String(req.body.actorId ?? ''));
      if (!actor) throw forbidden('Unknown actor');
      const role = req.body.role;
      if (role !== null && typeof role !== 'string') throw badRequest('"role" must be a role id or null');
      return { body: { grant: await setGrant(deps, actor, app.manifest, req.params.userId!, role) } };
    })
    .add('POST', '/apps/:slug/notify', async (req) => {
      const app = await requireAppCaller(req);
      const userId = String(req.body.userId ?? '');
      const text = String(req.body.text ?? '').slice(0, 300);
      if (!userId || !text) throw badRequest('"userId" and "text" are required');
      const grant = await getGrant(deps, app.manifest.slug, userId);
      if (!grant || !holdsRole(grant.role)) throw forbidden('Apps can only notify their own members');
      const link = typeof req.body.link === 'string' && req.body.link.startsWith(appOrigin(deps.config, app.manifest.slug)) ? req.body.link : `${appOrigin(deps.config, app.manifest.slug)}/`;
      await notify(deps, userId, { text, link, app: app.manifest.slug });
      return { body: { ok: true } };
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
    /* ---------- Settings › Sign-in methods (link another account, self-serve merge) ---------- */
    .add(
      'GET',
      '/me/identities',
      signedIn(async (_req, user) => ({
        body: {
          identities: (await listIdentities(deps, user.id)).map((i) => ({
            provider: i.provider,
            sub: i.sub,
            email: i.email,
            linkedAt: i.linkedAt,
            primary: user.primaryIdentity === `${i.provider}#${i.sub}`,
          })),
          emails: [user.email, ...(user.emails ?? [])],
        },
      })),
    )
    .add(
      'POST',
      '/me/identities/google',
      signedIn(async (req, user) => {
        const credential = req.body.credential;
        if (typeof credential !== 'string' || !credential) throw badRequest('"credential" is required');
        return { body: await linkGoogle(deps, user, await deps.verifyGoogle(credential)) };
      }),
    )
    .add(
      'POST',
      '/me/identities/apple',
      signedIn(async (req, user) => ({ body: await linkProvider(deps, user, 'apple', await verifyApple(req.body)) })),
    )
    .add(
      'DELETE',
      '/me/identities/:provider/:sub',
      signedIn(async (req, user) => {
        await unlinkIdentity(deps, user, req.params.provider!, req.params.sub!);
        return { body: { ok: true } };
      }),
    )
    .add(
      'POST',
      '/me/merge',
      signedIn(async (req, user) => {
        const merged = await mergeWithTicket(deps, user, String(req.body.ticket ?? ''));
        return { body: { user: meView(deps, merged) } };
      }),
    )
    .add('GET', '/public/catalog', async () => ({ body: { apps: (await listApps(deps)).map((a) => catalogEntry(a, null, false)) } }))
    .add(
      'GET',
      '/catalog',
      signedIn(async (_req, user) => {
        const grants = await grantsForUser(deps, user.id);
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
    .add('GET', '/notifications', signedIn(async (_req, user) => ({ body: { notifications: await listNotifications(deps, user.id) } })))

    /* ---------- Push: this person's devices (the iOS app) and Settings › Notifications ---------- */
    // The app hands the portal page its APNs token; the page registers it with its own session.
    .add(
      'POST',
      '/devices',
      signedIn(async (req, user) => {
        const { device, secret } = await registerDevice(deps, user, req.body);
        // The app refreshes its registration on every launch; only a new device is worth a line.
        if (device.createdAt === device.lastSeenAt) await audit(deps, user, 'platform', { action: 'device.register', label: device.deviceName, details: { deviceId: device.id, env: device.env } });
        return { body: { device: deviceView(device), secret } };
      }),
    )
    .add('GET', '/devices', signedIn(async (_req, user) => ({ body: { devices: (await listDevices(deps, user.id)).map(deviceView) } })))
    .add(
      'DELETE',
      '/devices/:id',
      signedIn(async (req, user) => {
        await removeDevice(deps, user.id, req.params.id!);
        await audit(deps, user, 'platform', { action: 'device.remove', details: { deviceId: req.params.id } });
        return { body: { ok: true } };
      }),
    )
    // A button on a notification (Approve / Deny), sent by the app itself: no session, the device's
    // secret instead (the app keeps it in the Keychain).
    .add('POST', '/devices/:id/actions', async (req) => ({ body: { ok: true, ...(await handlePushAction(deps, req.params.id!, req.body)) } }))
    .add('GET', '/me/notification-settings', signedIn(async (_req, user) => ({ body: { apps: await notificationSettings(deps, user) } })))
    .add(
      'PUT',
      '/me/muted/:slug',
      signedIn(async (req, user) => {
        const slug = req.params.slug!;
        await getApp(deps, slug);
        const mutedApps = [...new Set([...(user.mutedApps ?? []), slug])];
        await saveUser(deps, { ...user, mutedApps });
        return { body: { mutedApps } };
      }),
    )
    .add(
      'DELETE',
      '/me/muted/:slug',
      signedIn(async (req, user) => {
        const mutedApps = (user.mutedApps ?? []).filter((s) => s !== req.params.slug);
        await saveUser(deps, { ...user, mutedApps });
        return { body: { mutedApps } };
      }),
    )
    .add(
      'POST',
      '/notifications/read',
      signedIn(async (_req, user) => {
        await markNotificationsRead(deps, user.id);
        return { body: { ok: true } };
      }),
    )

    /* ---------- Access grid ---------- */
    .add(
      'GET',
      '/admin/access',
      signedIn(async (_req, user) => {
        const admin = isPlatformAdmin(deps, user);
        const apps: AppEntry[] = [];
        for (const a of await listApps(deps, { includeArchived: admin })) if ((await managesApp(deps, user, a.manifest)).manages) apps.push(a);
        if (!apps.length) throw forbidden('You do not manage access to any app');
        const grants = (await Promise.all(apps.map((a) => grantsForApp(deps, a.manifest.slug)))).flat();
        // Super-admins see every user; approvers see the people who have (or asked for) their apps.
        const ids = admin ? (await deps.store.queryGsi1<Item & { id: string }>('USERS')).map((u) => u.id) : [...new Set(grants.map((g) => g.userId))];
        const users = (await Promise.all(ids.map((id) => getUser(deps, id)))).filter((u): u is PlatformUser => !!u);
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
                canManageApprovers: (await managesApp(deps, user, a.manifest)).managesApprovers,
              })),
            ),
            users: users.map((u) => ({ id: u.id, email: u.email, name: shownName(u), pictureUrl: u.pictureUrl ?? null })).sort((a, b) => a.name.localeCompare(b.name)),
            grants: grants.map((g) => ({ app: g.app, userId: g.userId, role: g.role, requestedAt: g.requestedAt ?? null, grantedAt: g.grantedAt ?? null })),
          },
        };
      }),
    )
    .add(
      'PUT',
      '/admin/access/:slug/:userId',
      signedIn(async (req, user) => {
        const app = await getApp(deps, req.params.slug!, { includeArchived: true });
        const role = req.body.role;
        if (role !== null && typeof role !== 'string') throw badRequest('"role" must be a role id or null');
        const grant = await setGrant(deps, user, app.manifest, req.params.userId!, role);
        return { body: { grant } };
      }),
    )
    .add(
      'PUT',
      '/admin/apps/:slug/status',
      signedIn(async (req, user) => {
        if (!isPlatformAdmin(deps, user)) throw forbidden('Platform admins only');
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
        const admin = isPlatformAdmin(deps, user);
        let apps: Set<string> | 'all' = 'all';
        if (!admin) {
          apps = new Set();
          for (const a of await listApps(deps)) if ((await managesApp(deps, user, a.manifest)).manages) apps.add(a.manifest.slug);
          if (!apps.size) throw forbidden('You do not manage any app');
        }
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        // The grid's filter takes an email or an id; events name actors by id, so show their current email too.
        const actor = req.query.actor?.includes('@') ? ((await userIdForEmail(deps, req.query.actor)) ?? 'nobody') : req.query.actor;
        const page = await listAudit(deps, { apps, app: req.query.app, actor, action: req.query.action, before: req.query.before, limit });
        const emails = new Map<string, string>();
        for (const id of new Set(page.events.map((e) => e.actorId))) {
          const u = await getUser(deps, id);
          if (u) emails.set(id, u.email);
        }
        return { body: { ...page, events: page.events.map((e) => (emails.has(e.actorId) ? { ...e, actorEmail: emails.get(e.actorId) } : e)) } };
      }),
    );

  return (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => router.handle(event);
}

function meView(deps: PlatformDeps, u: PlatformUser) {
  return {
    id: u.id,
    email: u.email,
    name: shownName(u),
    displayName: u.displayName ?? null,
    googleName: u.name,
    pictureUrl: u.pictureUrl ?? null,
    isPlatformAdmin: isPlatformAdmin(deps, u),
  };
}

/** Compare secrets without leaking their contents through timing. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  if (!b) return false;
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

