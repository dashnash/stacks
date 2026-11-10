import { canManageAccess, roleDef, type AppManifest } from '@stacks/manifest';
import { conflict, forbidden, notFound, randomToken, sanitize, sha256Hex, badRequest, type Item, ConditionFailedError } from '@stacks/api';
import {
  isPlatformAdmin,
  keys,
  BLOCKED,
  holdsRole,
  PENDING,
  shownName,
  type AppItem,
  type EmailItem,
  type GoogleIdentity,
  type Grant,
  type GrantItem,
  type IdentityItem,
  type Notification,
  type NotificationItem,
  type PlatformAuditEvent,
  type PlatformDeps,
  type PlatformUser,
  type RegisteredApp,
  type UserItem,
} from './model';

const DAY_MS = 86_400_000;

/* ---------- Users ---------- */

const stripUser = (item: UserItem): PlatformUser => {
  const { PK: _a, SK: _b, GSI1PK: _c, GSI1SK: _d, ...user } = item;
  return user as PlatformUser;
};

export async function getUser(deps: PlatformDeps, id: string): Promise<PlatformUser | null> {
  if (!id) return null;
  const k = keys.user(id);
  const item = await deps.store.get<UserItem>(k.PK, k.SK);
  return item ? stripUser(item) : null;
}

/** The id of whoever has this email (primary or linked), or null. */
export async function userIdForEmail(deps: PlatformDeps, email: string): Promise<string | null> {
  const k = keys.email(email);
  return (await deps.store.get<EmailItem>(k.PK, k.SK))?.userId ?? null;
}

export async function getUserByEmail(deps: PlatformDeps, email: string): Promise<PlatformUser | null> {
  const id = await userIdForEmail(deps, email);
  return id ? getUser(deps, id) : null;
}

export async function saveUser(deps: PlatformDeps, user: PlatformUser): Promise<void> {
  await deps.store.put({ ...keys.user(user.id), ...user });
}

/** A fresh user id from the platform's id source: `u_` + 24 lower-case characters. */
export const mintUserId = (deps: PlatformDeps) => `u_${deps.newId().replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 24)}`;

/**
 * Create a user for an email nobody has yet. The `EMAIL#` item is written first (conditionally), so
 * two sign-ins racing for the same email end up with one user.
 */
async function createUser(deps: PlatformDeps, profile: { email: string; name: string; picture?: string }): Promise<PlatformUser> {
  const email = profile.email.toLowerCase();
  const user: PlatformUser = { id: mintUserId(deps), email, name: profile.name, ...(profile.picture ? { pictureUrl: profile.picture } : {}), createdAt: deps.now().toISOString() };
  try {
    await deps.store.put({ ...keys.email(email), userId: user.id }, { ifNotExists: true });
  } catch (err) {
    if (!(err instanceof ConditionFailedError)) throw err;
    const existing = await getUserByEmail(deps, email);
    if (existing) return existing;
    throw err;
  }
  await saveUser(deps, user);
  return user;
}

/** The user who has this email, created (with a name from the address) if nobody does: for manifest owners. */
export async function ensureUserForEmail(deps: PlatformDeps, email: string): Promise<PlatformUser> {
  return (await getUserByEmail(deps, email)) ?? createUser(deps, { email, name: email.split('@')[0]! });
}

async function linkIdentity(deps: PlatformDeps, user: PlatformUser, provider: string, identity: GoogleIdentity): Promise<void> {
  try {
    await deps.store.put(
      { ...keys.identity(provider, identity.sub), userId: user.id, provider, sub: identity.sub, email: identity.email, linkedAt: deps.now().toISOString() },
      { ifNotExists: true },
    );
  } catch (err) {
    if (!(err instanceof ConditionFailedError)) throw err; // a concurrent sign-in linked it first
  }
}

/** Move a user's primary email (their Google email changed), unless someone else already has the new one. */
async function moveEmail(deps: PlatformDeps, user: PlatformUser, email: string): Promise<PlatformUser> {
  try {
    await deps.store.put({ ...keys.email(email), userId: user.id }, { ifNotExists: true });
  } catch (err) {
    if (!(err instanceof ConditionFailedError)) throw err;
    if ((await userIdForEmail(deps, email)) !== user.id) return user;
  }
  const old = keys.email(user.email);
  await deps.store.delete(old.PK, old.SK);
  return { ...user, email };
}

/**
 * Find or create the portal account for a verified Google identity: by Google's `sub` first, then
 * by the verified email (linking the identity), else a new user. Name, picture and email follow Google.
 */
export async function userForIdentity(deps: PlatformDeps, identity: GoogleIdentity, provider = 'google'): Promise<PlatformUser> {
  const email = identity.email.toLowerCase();
  const k = keys.identity(provider, identity.sub);
  const linked = await deps.store.get<IdentityItem>(k.PK, k.SK);
  let user = linked ? await getUser(deps, linked.userId) : null;
  if (!user) {
    user = (await getUserByEmail(deps, email)) ?? (await createUser(deps, { email, name: identity.name, picture: identity.picture }));
    await linkIdentity(deps, user, provider, { ...identity, email });
  }
  let next = user;
  if (next.email !== email) next = await moveEmail(deps, next, email);
  if (next.name !== identity.name || next.pictureUrl !== identity.picture) {
    next = { ...next, name: identity.name, ...(identity.picture ? { pictureUrl: identity.picture } : {}) };
    if (!identity.picture) delete next.pictureUrl;
  }
  if (next !== user) await saveUser(deps, next);
  return next;
}

/** What an app sees of a user: id, display name and avatar; the email only if its manifest has `needsEmail`. */
export const appView = (u: PlatformUser, manifest: Pick<AppManifest, 'needsEmail'>) => ({
  id: u.id,
  ...(manifest.needsEmail ? { email: u.email } : {}),
  name: shownName(u),
  ...(u.pictureUrl ? { pictureUrl: u.pictureUrl } : {}),
});

/* ---------- Master sessions (the portal's own, on auth.<domain>) ---------- */

export const PORTAL_COOKIE = '__Host-stacks-portal';
const PORTAL_PREFIX = 'stp_';
export const PORTAL_IDLE_DAYS = 90;
const expiryFor = (at: Date) => Math.floor((at.getTime() + PORTAL_IDLE_DAYS * DAY_MS) / 1000);
const sessionKey = async (token: string) => ({ PK: `SESSION#${await sha256Hex(token)}`, SK: 'SESSION' });

export async function createPortalSession(deps: PlatformDeps, user: PlatformUser): Promise<string> {
  const token = randomToken(PORTAL_PREFIX);
  const now = deps.now();
  await deps.store.put({
    ...(await sessionKey(token)),
    GSI1PK: `USERSESSIONS#${user.id}`,
    GSI1SK: now.toISOString(),
    userId: user.id,
    userCreatedAt: user.createdAt,
    lastUsedAt: now.toISOString(),
    expiresAt: expiryFor(now),
  });
  return token;
}

/** The signed-in portal user for a session token, or null. Ends sessions of deleted users. */
export async function readPortalSession(deps: PlatformDeps, token: string | undefined): Promise<PlatformUser | null> {
  if (!token?.startsWith(PORTAL_PREFIX)) return null;
  const { PK, SK } = await sessionKey(token);
  const s = await deps.store.get<Item & { userId: string; userCreatedAt: string; lastUsedAt: string }>(PK, SK);
  if (!s) return null;
  const now = deps.now();
  const idle = now.getTime() - new Date(s.lastUsedAt).getTime();
  const user = await getUser(deps, s.userId);
  if (idle > PORTAL_IDLE_DAYS * DAY_MS || !user || user.createdAt !== s.userCreatedAt) {
    await deps.store.delete(PK, SK);
    return null;
  }
  if (idle > DAY_MS) await deps.store.put({ ...s, lastUsedAt: now.toISOString(), expiresAt: expiryFor(now) });
  return user;
}

export async function endPortalSession(deps: PlatformDeps, token: string | undefined): Promise<void> {
  if (!token?.startsWith(PORTAL_PREFIX)) return;
  const { PK, SK } = await sessionKey(token);
  await deps.store.delete(PK, SK);
}

/** Sign a user out everywhere: every portal session and their sessions in every app they can use. */
export async function signOutEverywhere(deps: PlatformDeps, userId: string): Promise<void> {
  const sessions = await deps.store.queryGsi1(`USERSESSIONS#${userId}`);
  await Promise.all(sessions.map((s) => deps.store.delete(s.PK, s.SK)));
  const grants = await grantsForUser(deps, userId);
  await Promise.all(grants.filter((g) => holdsRole(g.role)).map((g) => deps.appSessions.endUserSessions(g.app, userId).catch((err) => console.error(`Could not end ${g.app} sessions`, err))));
}

/* ---------- Apps ---------- */

/**
 * Live apps from the registry. The first time an app is seen it is registered: its owners get the
 * manifest's top role (spec: the creator becomes the app's top role).
 */
export async function listApps(deps: PlatformDeps, opts: { includeArchived?: boolean } = {}): Promise<(RegisteredApp & { status: 'live' | 'archived' })[]> {
  const registered = await deps.registry.list();
  const out: (RegisteredApp & { status: 'live' | 'archived' })[] = [];
  for (const app of registered) {
    const record = await ensureRegistered(deps, app.manifest);
    if (record.status === 'live' || opts.includeArchived) out.push({ ...app, status: record.status });
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

async function ensureRegistered(deps: PlatformDeps, manifest: AppManifest): Promise<AppItem> {
  const k = keys.app(manifest.slug);
  const existing = await deps.store.get<AppItem>(k.PK, k.SK);
  if (existing) return existing;
  const now = deps.now().toISOString();
  const record: AppItem = { ...k, slug: manifest.slug, status: 'live', registeredAt: now };
  try {
    await deps.store.put(record, { ifNotExists: true });
  } catch (err) {
    if (err instanceof ConditionFailedError) return (await deps.store.get<AppItem>(k.PK, k.SK))!;
    throw err;
  }
  for (const owner of manifest.owners) {
    const user = await ensureUserForEmail(deps, owner);
    await putGrant(deps, { app: manifest.slug, userId: user.id, role: manifest.topRole, grantedBy: 'platform', grantedAt: now });
  }
  await audit(deps, PLATFORM_ACTOR, manifest.slug, { action: 'app.register', label: manifest.name, details: { owners: manifest.owners } });
  return record;
}

export async function getApp(deps: PlatformDeps, slug: string, opts: { includeArchived?: boolean } = {}) {
  const app = (await listApps(deps, opts)).find((a) => a.manifest.slug === slug);
  if (!app) throw notFound(`No app "${slug}"`);
  return app;
}

/* ---------- Grants ---------- */

const stripGrant = (g: GrantItem): Grant => {
  const { PK: _a, SK: _b, GSI1PK: _c, GSI1SK: _d, ...rest } = g;
  return rest as Grant;
};

export async function getGrant(deps: PlatformDeps, slug: string, userId: string): Promise<Grant | null> {
  const k = keys.grant(slug, userId);
  const g = await deps.store.get<GrantItem>(k.PK, k.SK);
  return g ? stripGrant(g) : null;
}

export async function grantsForApp(deps: PlatformDeps, slug: string): Promise<Grant[]> {
  return (await deps.store.query<GrantItem>(`APP#${slug}`, 'GRANT#')).map(stripGrant);
}

export async function grantsForUser(deps: PlatformDeps, userId: string): Promise<Grant[]> {
  return (await deps.store.queryGsi1<GrantItem>(`USERGRANTS#${userId}`)).map(stripGrant);
}

async function putGrant(deps: PlatformDeps, grant: Grant): Promise<void> {
  await deps.store.put({ ...keys.grant(grant.app, grant.userId), ...grant });
}

/** Can `viewer` approve requests and set roles in this app? */
export async function managesApp(deps: PlatformDeps, viewer: PlatformUser, manifest: AppManifest): Promise<{ manages: boolean; managesApprovers: boolean }> {
  if (isPlatformAdmin(deps, viewer)) return { manages: true, managesApprovers: true };
  const g = await getGrant(deps, manifest.slug, viewer.id);
  const def = g && holdsRole(g.role) ? roleDef(manifest, g.role) : undefined;
  return { manages: !!def?.canManageAccess, managesApprovers: !!def?.canManageApprovers };
}

/**
 * Everything that changes a grant goes through here, from the central grid or an app's own
 * admin page. `role: null` removes access (or dismisses a request); `role: "BLOCKED"` keeps the
 * person out (public apps stop auto-granting, private apps stop taking their requests) until
 * someone sets a role or `null`.
 */
export async function setGrant(
  deps: PlatformDeps,
  actor: PlatformUser,
  manifest: AppManifest,
  userId: string,
  role: string | null,
): Promise<Grant | null> {
  const { manages, managesApprovers } = await managesApp(deps, actor, manifest);
  if (!manages) throw forbidden('You do not manage access to this app');
  if (role !== null && role !== BLOCKED && !roleDef(manifest, role)) throw badRequest(`"${role}" is not a role in ${manifest.name}`);
  const target = await getUser(deps, userId);
  if (!target) throw notFound('No such user');
  if (role === BLOCKED && isPlatformAdmin(deps, target)) throw conflict('Platform admins cannot be blocked');

  const current = await getGrant(deps, manifest.slug, userId);
  const from = current?.role ?? null;
  if (from === role) return current;
  const touchesApprovers = (r: string | null) => holdsRole(r) && canManageAccess(manifest, r);
  if ((touchesApprovers(from) || touchesApprovers(role)) && !managesApprovers) {
    throw forbidden('Only people who manage approvers can grant or remove that role');
  }
  if (from === manifest.topRole && role !== manifest.topRole) {
    const holders = (await grantsForApp(deps, manifest.slug)).filter((g) => g.role === manifest.topRole);
    if (holders.length <= 1) throw conflict(`${manifest.name} must keep at least one ${roleDef(manifest, manifest.topRole)!.label}`);
  }

  const now = deps.now().toISOString();
  let next: Grant | null = null;
  if (role === null) {
    const k = keys.grant(manifest.slug, userId);
    await deps.store.delete(k.PK, k.SK);
  } else {
    next = { app: manifest.slug, userId, role, grantedBy: actor.id, grantedAt: now, ...(current?.requestedAt ? { requestedAt: current.requestedAt } : {}) };
    await putGrant(deps, next);
  }
  // Their open sessions carry the old role: end them so the next request picks up the new one.
  if (holdsRole(from)) await deps.appSessions.endUserSessions(manifest.slug, userId);
  if (from === PENDING && holdsRole(role)) await notify(deps, userId, { text: `You now have access to ${manifest.name}.`, link: `https://${manifest.slug}.${deps.config.rootDomain}/`, app: manifest.slug });
  const action = role === BLOCKED ? 'grant.block' : from === BLOCKED ? 'grant.unblock' : role === null ? 'grant.remove' : 'grant.set';
  await audit(deps, actor, manifest.slug, { action, label: shownName(target), details: { userId, from, to: role } });
  return next;
}

/**
 * A signed-in user asks to use an app. Public apps grant the default role at once; private apps
 * file a pending request and tell the approvers. Returns the grant; an existing one (including a
 * block) is returned unchanged, so a blocked person neither gets the default role nor files requests.
 */
export async function requestAccess(deps: PlatformDeps, user: PlatformUser, manifest: AppManifest): Promise<Grant> {
  const current = await getGrant(deps, manifest.slug, user.id);
  if (current) return current;
  const now = deps.now().toISOString();
  if (manifest.visibility === 'public') {
    const grant: Grant = { app: manifest.slug, userId: user.id, role: manifest.defaultRole!, grantedBy: 'platform', grantedAt: now };
    await putGrant(deps, grant);
    await audit(deps, user, manifest.slug, { action: 'grant.auto', label: shownName(user), details: { userId: user.id, to: grant.role } });
    return grant;
  }
  const grant: Grant = { app: manifest.slug, userId: user.id, role: PENDING, requestedAt: now };
  await putGrant(deps, grant);
  const approvers = (await grantsForApp(deps, manifest.slug)).filter((g) => holdsRole(g.role) && canManageAccess(manifest, g.role)).map((g) => g.userId);
  const admins = async () => (await Promise.all(deps.config.platformAdmins.map((e) => userIdForEmail(deps, e)))).filter((id): id is string => !!id);
  const recipients = approvers.length ? approvers : await admins();
  for (const id of recipients) {
    await notify(deps, id, { text: `${shownName(user)} (${user.email}) asked for access to ${manifest.name}.`, link: `#/admin/access?app=${manifest.slug}`, app: manifest.slug });
  }
  await audit(deps, user, manifest.slug, { action: 'grant.request', label: shownName(user), details: { userId: user.id } });
  return grant;
}

/* ---------- Notifications ---------- */

export async function notify(deps: PlatformDeps, userId: string, n: Pick<Notification, 'text' | 'link' | 'app'>): Promise<void> {
  const at = deps.now().toISOString();
  const id = deps.newId();
  await deps.store.put({ ...keys.notification(userId, at, id), id, at, read: false, ...n });
}

export async function listNotifications(deps: PlatformDeps, userId: string, limit = 50): Promise<Notification[]> {
  const items = await deps.store.query<NotificationItem>(`NOTIF#${userId}`);
  return items
    .reverse()
    .slice(0, limit)
    .map(({ PK: _a, SK: _b, ...n }) => n as Notification);
}

export async function markNotificationsRead(deps: PlatformDeps, userId: string): Promise<void> {
  const items = await deps.store.query<NotificationItem>(`NOTIF#${userId}`);
  await Promise.all(items.filter((i) => !i.read).map((i) => deps.store.put({ ...i, read: true })));
}

/* ---------- Central audit feed ---------- */

const monthKey = (iso: string) => `AUDIT#${iso.slice(0, 7)}`;

/** The actor for things the platform does by itself (registering an app). */
export const PLATFORM_ACTOR = { id: 'platform', name: 'Platform' } as const;

export async function audit(
  deps: PlatformDeps,
  actor: PlatformUser | { id: string; name: string },
  app: string,
  event: Pick<PlatformAuditEvent, 'action' | 'label' | 'params' | 'details'>,
): Promise<void> {
  const at = deps.now().toISOString();
  const id = deps.newId();
  const actorName = 'createdAt' in actor ? shownName(actor) : actor.name;
  await storeAudit(deps, { id, at, app, actorId: actor.id, actorName, ...event });
}

export async function storeAudit(deps: PlatformDeps, e: PlatformAuditEvent): Promise<void> {
  try {
    const clean = { ...e, details: e.details ? (sanitize(e.details) as Record<string, unknown>) : undefined };
    await deps.store.put({ PK: monthKey(e.at), SK: `${e.at}#${e.app}#${e.id}`, ...clean });
  } catch (err) {
    console.error('Could not record audit event', err);
  }
}

function previousMonth(iso: string): string {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString();
}

/** Newest first; filtered to `apps` (the ones the viewer may see) and optional app/actor/action. */
export async function listAudit(
  deps: PlatformDeps,
  opts: { apps: Set<string> | 'all'; app?: string; actor?: string; action?: string; before?: string; limit?: number },
): Promise<{ events: PlatformAuditEvent[]; nextBefore: string | null }> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 100), 1), 500);
  const before = opts.before ?? new Date(deps.now().getTime() + 1000).toISOString();
  const ok = (e: PlatformAuditEvent) =>
    e.at < before &&
    (opts.apps === 'all' || opts.apps.has(e.app)) &&
    (!opts.app || e.app === opts.app) &&
    (!opts.actor || e.actorId === opts.actor) &&
    (!opts.action || e.action === opts.action || e.action.startsWith(`${opts.action.replace(/\.$/, '')}.`));
  const events: PlatformAuditEvent[] = [];
  let month = before;
  for (let i = 0; i < 24; i++) {
    const found = (await deps.store.query<Item & PlatformAuditEvent>(monthKey(month)))
      .map(({ PK: _a, SK: _b, ...e }) => e as PlatformAuditEvent)
      .filter(ok)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    for (const e of found) {
      events.push(e);
      if (events.length === limit) return { events, nextBefore: e.at };
    }
    month = previousMonth(month);
  }
  return { events, nextBefore: null };
}
