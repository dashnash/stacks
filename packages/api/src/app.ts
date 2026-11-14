import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { canManageAccess, hasModule, type AppManifest } from '@stacks/manifest';
import { listAudit, recordAudit, sanitize } from './audit';
import { codeChallenge, randomToken } from './crypto';
import { badRequest, forbidden, HttpError, maintenance, MAINTENANCE_OPEN_PATHS, unauthorized, type RouteResult } from './http';
import { log, logClientError, setLogApp, setLogUser } from './log';
import { appMembers, forgetMembers } from './people';
import { PlatformError } from './platform';
import { ChannelRegistry, parseTokenRequest, realtimeOff, signRealtimeToken, TOKEN_TTL_SECONDS, type RealtimeChannels, type RealtimeTokenResponse } from './realtime';
import type { AppDeps, Viewer } from './model';
import { Router, type HttpMethod, type RequestContext } from './router';
import { clearCookie, cookie, createSession, endSession, readSession, SESSION_COOKIE, sessionCookie } from './session';

/** Facts a handler adds to its activity-log entry. */
export interface AuditFacts {
  /** What the action touched, as people know it: a title, a person's name. */
  label?: string;
  [fact: string]: unknown;
}

export interface HandlerResult extends RouteResult {
  /** For audited routes: the label and any extra facts for the activity log. */
  audit?: AuditFacts;
}

export type SignedInHandler<D extends AppDeps> = (req: RequestContext, viewer: Viewer<D>) => Promise<HandlerResult>;

export interface PublicContext<D extends AppDeps> {
  deps: D;
  manifest: AppManifest;
  /** The caller if they are signed in to this app, else null. Never throws. */
  viewer(): Promise<Viewer<D> | null>;
}
export type PublicHandler<D extends AppDeps> = (req: RequestContext, ctx: PublicContext<D>) => Promise<RouteResult>;

export interface RouteOptions {
  /** Record successful calls in the activity log under this action name, e.g. "greeting.post". */
  audit?: string;
}

/** How an app declares its routes. All paths are relative to `/api`. */
export interface AppRoutes<D extends AppDeps> {
  /** No sign-in needed (the app's public footprint). */
  public(method: HttpMethod, path: string, handler: PublicHandler<D>): AppRoutes<D>;
  /** Anyone with a role in this app. */
  member(method: HttpMethod, path: string, handler: SignedInHandler<D>, opts?: RouteOptions): AppRoutes<D>;
  /** Only the listed roles (manifest role ids). */
  role(roles: string[], method: HttpMethod, path: string, handler: SignedInHandler<D>, opts?: RouteOptions): AppRoutes<D>;
  /** Only roles the manifest marks `canManageAccess`. */
  approver(method: HttpMethod, path: string, handler: SignedInHandler<D>, opts?: RouteOptions): AppRoutes<D>;
  /**
   * Realtime channels (manifest module `realtime`). Every channel a browser may use is declared
   * here with guards; anything else is refused: `api.realtime.channel('room/*', { subscribe: (v, id) => true, publish: (v) => true })`.
   */
  realtime: RealtimeChannels<Viewer<D>>;
}

export interface StacksAppOptions<D extends AppDeps> {
  manifest: AppManifest;
  deps: D;
  routes: (api: AppRoutes<D>) => void;
}

/** Header the web SDK adds to every call; required on state-changing requests (CSRF). */
export const CSRF_HEADER = 'x-stacks-request';
const LOGIN_COOKIE = '__Host-stacks-login';
const LOGIN_TTL_SECONDS = 600;

/** A same-app path to return to after sign-in; anything else becomes "/". */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value.slice(0, 2000);
}

/**
 * Build an app's API: the routes it declares plus the shared ones every app gets
 * (`/auth/login`, `/auth/callback`, `/auth/session`, `/auth/logout`, `/admin/audit`, `/health`,
 * `/stacks/client-error`). Every request is logged as one line (see `log.ts`).
 */
export function createStacksApp<D extends AppDeps>(opts: StacksAppOptions<D>) {
  const { manifest, deps } = opts;
  const realtimeOn = hasModule(manifest, 'realtime');
  // Callers that predate the module (or leave it out) get the "turn it on" stand-in.
  (deps as AppDeps).realtime ??= realtimeOff(manifest.slug);
  const channels = new ChannelRegistry<Viewer<D>>();
  const knownRoles = new Set(manifest.roles.map((r) => r.id));
  setLogApp(manifest.slug);
  const router = new Router({ app: manifest.slug }).before((_method, path) => {
    if (deps.config.maintenance && !MAINTENANCE_OPEN_PATHS.has(path)) throw maintenance();
  });

  async function viewerFor(req: RequestContext): Promise<Viewer<D> | null> {
    const session = await readSession(deps, req.cookies[SESSION_COOKIE]);
    if (!session) return null;
    // A role the manifest no longer declares grants nothing.
    if (!knownRoles.has(session.role)) return null;
    setLogUser(session.user.id);
    // Names and photos follow the platform profile (cached ~30 s), so a rename shows without signing in again.
    let user = session.user;
    try {
      const member = (await appMembers(deps)).find((m) => m.id === user.id);
      if (member)
        user = {
          id: user.id,
          ...(member.email ? { email: member.email } : {}),
          name: member.name,
          ...(member.pictureUrl ? { pictureUrl: member.pictureUrl } : {}),
          ...(member.formerIds?.length ? { formerIds: member.formerIds } : {}),
        };
    } catch {
      // Platform unreachable: keep the name from sign-in.
    }
    return { user, role: session.role, canManageAccess: canManageAccess(manifest, session.role), deps, manifest };
  }

  const signedIn =
    (check: (v: Viewer<D>) => void, handler: SignedInHandler<D>, routeOpts: RouteOptions = {}) =>
    async (req: RequestContext): Promise<RouteResult> => {
      if (req.method !== 'GET' && req.headers[CSRF_HEADER] !== '1') throw forbidden('Missing request header', 'CSRF');
      const viewer = await viewerFor(req);
      if (!viewer) throw unauthorized();
      check(viewer);
      const { audit, ...result } = await handler(req, viewer);
      if (routeOpts.audit) {
        const { label, ...facts } = audit ?? {};
        const input = sanitize(req.body) as Record<string, unknown>;
        await recordAudit(deps, viewer.user, {
          action: routeOpts.audit,
          label,
          params: req.params,
          details: { ...(Object.keys(input).length ? { input } : {}), ...facts },
        });
      }
      return result;
    };

  const requireRoles = (roles: string[]) => {
    for (const r of roles) if (!knownRoles.has(r)) throw new Error(`Route uses role "${r}", which ${manifest.slug}'s manifest does not declare`);
    return (v: Viewer<D>) => {
      if (!roles.includes(v.role)) throw forbidden('Your role cannot do this');
    };
  };

  const api: AppRoutes<D> = {
    public(method, path, handler) {
      router.add(method, path, async (req) => {
        if (req.method !== 'GET' && req.headers[CSRF_HEADER] !== '1') throw forbidden('Missing request header', 'CSRF');
        let cached: Promise<Viewer<D> | null> | undefined;
        return handler(req, { deps, manifest, viewer: () => (cached ??= viewerFor(req).catch(() => null)) });
      });
      return api;
    },
    member(method, path, handler, routeOpts) {
      router.add(method, path, signedIn(() => undefined, handler, routeOpts));
      return api;
    },
    role(roles, method, path, handler, routeOpts) {
      router.add(method, path, signedIn(requireRoles(roles), handler, routeOpts));
      return api;
    },
    approver(method, path, handler, routeOpts) {
      router.add(
        method,
        path,
        signedIn(
          (v) => {
            if (!v.canManageAccess) throw forbidden('Only people who manage access can do this');
          },
          handler,
          routeOpts,
        ),
      );
      return api;
    },
    realtime: {
      channel(pattern, guards) {
        if (!realtimeOn) throw new Error(`realtime.channel("${pattern}"): add "realtime" to "modules" in ${manifest.slug}'s app.manifest.json`);
        channels.channel(pattern, guards);
        return api.realtime;
      },
    },
  };

  const redirectUri = `${deps.config.appOrigin}/api/auth/callback`;

  /** A PKCE login: state + verifier kept in a short-lived HttpOnly cookie, challenge sent to the platform. */
  async function startLogin(platformPath: string, ret: string) {
    const state = randomToken();
    const verifier = randomToken();
    const url = new URL(platformPath, deps.config.authOrigin);
    url.search = new URLSearchParams({
      app: manifest.slug,
      state,
      redirect_uri: redirectUri,
      code_challenge: await codeChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), state, loginCookie: cookie(LOGIN_COOKIE, btoa(JSON.stringify({ state, verifier, ret })), LOGIN_TTL_SECONDS) };
  }

  /** Check the state, swap the code (with the verifier) for the user, start an app session. */
  async function finishLogin(loginCookieValue: string | undefined, state: string, code: string) {
    let pending: { state?: string; verifier?: string } = {};
    try {
      pending = JSON.parse(atob(loginCookieValue ?? '')) as typeof pending;
    } catch {
      // missing or malformed: refused below
    }
    if (!pending.state || !pending.verifier || state !== pending.state || !code) {
      throw badRequest('Sign-in expired or was started in another browser. Please try again.');
    }
    const { user, role } = await deps.platform.exchangeCode({ code, codeVerifier: pending.verifier, redirectUri });
    if (!knownRoles.has(role)) throw forbidden(`The platform granted an unknown role "${role}"`);
    const token = await createSession(deps, user, role);
    await recordAudit(deps, user, { action: 'auth.login', details: { role } });
    return { token, user, role };
  }

  router
    .add('GET', '/health', async () => {
      // Required secrets that nobody has set yet (names only, never values).
      const required = (manifest.secrets ?? []).filter((s) => !s.optional).map((s) => s.name);
      const missing: string[] = [];
      if (required.length && deps.secret) {
        for (const name of required) if (!(await deps.secret(name).catch(() => undefined))) missing.push(name);
      }
      return { body: { ok: true, app: manifest.slug, ...(missing.length ? { missingSecrets: missing } : {}) } };
    })
    // Step 2 of the handshake: send the browser to the platform with a PKCE challenge.
    .add('GET', '/auth/login', async (req) => {
      const { url, loginCookie } = await startLogin('/authorize', safeReturnPath(req.query.return));
      return { redirect: url, cookies: [loginCookie] };
    })
    // Silent sign-in, step 1: the page gets a URL to ask the platform with (fetch, portal cookie).
    .add('GET', '/auth/silent-start', async () => {
      const { url, state, loginCookie } = await startLogin('/api/silent-authorize', '/');
      return { body: { url, state }, cookies: [loginCookie] };
    })
    // Silent sign-in, step 2: the page hands over the platform's code; same checks as the callback.
    .add('POST', '/auth/silent-finish', async (req) => {
      if (req.headers[CSRF_HEADER] !== '1') throw forbidden('Missing request header', 'CSRF');
      const { token, user, role } = await finishLogin(req.cookies[LOGIN_COOKIE], String(req.body.state ?? ''), String(req.body.code ?? ''));
      return {
        body: { user, role, canManageAccess: canManageAccess(manifest, role) },
        cookies: [clearCookie(LOGIN_COOKIE), sessionCookie(token)],
      };
    })
    // Steps 8-9: swap the one-time code for the user, start an app session, go back to the deep link.
    .add('GET', '/auth/callback', async (req) => {
      let pending: { ret?: string; state?: string; verifier?: string } = {};
      try {
        pending = JSON.parse(atob(req.cookies[LOGIN_COOKIE] ?? '')) as typeof pending;
      } catch {
        // missing or malformed: handled below
      }
      const clear = clearCookie(LOGIN_COOKIE);
      const ret = safeReturnPath(pending.ret);
      if (req.query.error) {
        // e.g. access_pending (a request was filed) or access_denied: the app's public view explains.
        const code = req.query.error.replace(/[^a-z_]/g, '').slice(0, 40);
        return { redirect: `/?stacks_access=${code}`, cookies: [clear] };
      }
      // Started in another browser, or expired (e.g. a sign-in begun in Chrome that iOS finished in
      // the app): the code is never used, and the person lands on the app, which signs them in
      // silently when it can, instead of on a dead-end error page.
      if (!pending.state || !pending.verifier || req.query.state !== pending.state || !req.query.code) {
        return { redirect: '/', cookies: [clear] };
      }
      const { token } = await finishLogin(req.cookies[LOGIN_COOKIE], req.query.state ?? '', req.query.code ?? '');
      return { redirect: ret, cookies: [clear, sessionCookie(token)] };
    })
    .add('GET', '/auth/session', async (req) => {
      const viewer = await viewerFor(req);
      if (!viewer) throw unauthorized();
      return { body: { user: viewer.user, role: viewer.role, canManageAccess: viewer.canManageAccess } };
    })
    .add('POST', '/auth/logout', async (req) => {
      if (req.headers[CSRF_HEADER] !== '1') throw forbidden('Missing request header', 'CSRF');
      const viewer = await viewerFor(req).catch(() => null);
      await endSession(deps, req.cookies[SESSION_COOKIE]);
      if (viewer) await recordAudit(deps, viewer.user, { action: 'auth.logout' });
      // The web SDK then visits the platform's logout, which ends the master session everywhere.
      return { body: { ok: true, platformLogoutUrl: new URL('/logout', deps.config.authOrigin).toString() }, cookies: [clearCookie(SESSION_COOKIE)] };
    });

  // The account menu: who you are here, your other apps, inbox and approvals (from the platform).
  api.member('GET', '/stacks/account', async (_req, v) => {
    try {
      return { body: await v.deps.platform.account(v.user.id) };
    } catch (err) {
      log.warn('Account details unavailable', err);
      const portal = new URL('/', v.deps.config.authOrigin).toString();
      const label = manifest.roles.find((r) => r.id === v.role)?.label ?? v.role;
      return {
        body: {
          portalUrl: `${portal}#/`,
          profileUrl: `${portal}#/profile?from=${manifest.slug}`,
          inboxUrl: `${portal}#/notifications?from=${manifest.slug}`,
          unread: 0,
          app: { slug: manifest.slug, name: manifest.name, roleLabel: label },
          apps: [],
          manage: null,
        },
      };
    }
  });

  // Browser errors, sent by @stacks/web from every app (signed in or out). Logged, never stored.
  api.public('POST', '/stacks/client-error', async (req, ctx) => {
    await ctx.viewer();
    if (!logClientError(req.body)) throw badRequest('Error report is too large');
    return { status: 204 };
  });

  // Everyone with a role here (names for pickers and credits). Members only.
  api.member('GET', '/stacks/members', async (_req, v) => ({ body: { members: (await v.deps.platform.access()).members } }));
  // The app's own access page: same rules as the portal's grid (the platform checks them).
  api.approver('GET', '/stacks/access', async (_req, v) => ({
    body: { ...(await v.deps.platform.access()), roles: manifest.roles, topRole: manifest.topRole, defaultRole: manifest.defaultRole ?? null },
  }));
  api.approver(
    'PUT',
    '/stacks/access/:userId',
    async (req, v) => {
      const role = req.body.role;
      if (role !== null && typeof role !== 'string') throw badRequest('"role" must be a role id or null');
      const userId = req.params.userId!;
      let label = userId;
      try {
        const { members, pending, blocked } = await v.deps.platform.access();
        label = [...members, ...pending, ...blocked].find((m) => m.id === userId)?.name ?? userId;
        await v.deps.platform.setAccess(v.user.id, userId, role);
        forgetMembers(v.deps);
      } catch (err) {
        if (err instanceof PlatformError) throw new HttpError(err.status, err.message, err.code);
        throw err;
      }
      return { body: { ok: true }, audit: { label, userId, to: role } };
    },
    { audit: 'access.set' },
  );

  api.approver('GET', '/admin/audit', async (req, v) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    return { body: await listAudit(v.deps, { before: req.query.before, actor: req.query.actor, action: req.query.action, limit }) };
  });

  // Realtime: a short-lived token for exactly the channels asked for, each checked against the
  // app's declarations. The Event API's authorizer then allows only those channels.
  if (realtimeOn) {
    api.member('POST', '/realtime/token', async (req, v) => {
      const request = parseTokenRequest(req.body);
      await channels.check(v, request);
      const connection = await v.deps.realtime.connection();
      const exp = Math.floor(v.deps.now().getTime() / 1000) + TOKEN_TTL_SECONDS;
      const token = await signRealtimeToken(connection.key, { v: 1, u: v.user.id, s: request.subscribe, p: request.publish, exp });
      const body: RealtimeTokenResponse = {
        token,
        expiresAt: new Date(exp * 1000).toISOString(),
        endpoint: connection.endpoint,
        host: connection.host,
        namespace: connection.namespace,
      };
      return { body };
    });
  }

  opts.routes(api);

  return (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => router.handle(event);
}
