import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { canManageAccess, type AppManifest } from '@stacks/manifest';
import { listAudit, recordAudit, sanitize } from './audit';
import { codeChallenge, randomToken } from './crypto';
import { badRequest, forbidden, unauthorized, type RouteResult } from './http';
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
 * (`/auth/login`, `/auth/callback`, `/auth/session`, `/auth/logout`, `/admin/audit`, `/health`).
 */
export function createStacksApp<D extends AppDeps>(opts: StacksAppOptions<D>) {
  const { manifest, deps } = opts;
  const knownRoles = new Set(manifest.roles.map((r) => r.id));
  const router = new Router();

  async function viewerFor(req: RequestContext): Promise<Viewer<D> | null> {
    const session = await readSession(deps, req.cookies[SESSION_COOKIE]);
    if (!session) return null;
    // A role the manifest no longer declares grants nothing.
    if (!knownRoles.has(session.role)) return null;
    return { user: session.user, role: session.role, canManageAccess: canManageAccess(manifest, session.role), deps, manifest };
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
  };

  const redirectUri = `${deps.config.appOrigin}/api/auth/callback`;

  router
    .add('GET', '/health', async () => ({ body: { ok: true, app: manifest.slug } }))
    // Step 2 of the handshake: send the browser to the platform with a PKCE challenge.
    .add('GET', '/auth/login', async (req) => {
      const state = randomToken();
      const verifier = randomToken();
      const ret = safeReturnPath(req.query.return);
      const login = btoa(JSON.stringify({ state, verifier, ret }));
      const url = new URL('/authorize', deps.config.authOrigin);
      url.search = new URLSearchParams({
        app: manifest.slug,
        state,
        redirect_uri: redirectUri,
        code_challenge: await codeChallenge(verifier),
        code_challenge_method: 'S256',
      }).toString();
      return { redirect: url.toString(), cookies: [cookie(LOGIN_COOKIE, login, LOGIN_TTL_SECONDS)] };
    })
    // Steps 8-9: swap the one-time code for the user, start an app session, go back to the deep link.
    .add('GET', '/auth/callback', async (req) => {
      let pending: { state?: string; verifier?: string; ret?: string } = {};
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
      if (!pending.state || !pending.verifier || req.query.state !== pending.state || !req.query.code) {
        throw badRequest('Sign-in expired or was started in another browser. Please try again.');
      }
      const { user, role } = await deps.platform.exchangeCode({ code: req.query.code, codeVerifier: pending.verifier, redirectUri });
      if (!knownRoles.has(role)) throw forbidden(`The platform granted an unknown role "${role}"`);
      const token = await createSession(deps, user, role);
      await recordAudit(deps, user, { action: 'auth.login', details: { role } });
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

  // The portal bar: the viewer's other apps and unread count, fetched from the platform server-side.
  api.member('GET', '/stacks/bar', async (_req, v) => {
    try {
      return { body: await v.deps.platform.portalBar(v.user.email) };
    } catch (err) {
      console.error('Portal bar unavailable', err);
      return { body: { portalUrl: v.deps.config.authOrigin, unread: 0, apps: [] } };
    }
  });

  api.approver('GET', '/admin/audit', async (req, v) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    return { body: await listAudit(v.deps, { before: req.query.before, actor: req.query.actor, action: req.query.action, limit }) };
  });

  opts.routes(api);

  return (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => router.handle(event);
}
