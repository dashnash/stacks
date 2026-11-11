import { roleDef, type AppManifest } from '@stacks/manifest';
import { badRequest, conflict, forbidden, randomToken, sha256Hex, type Item } from '@stacks/api';
import {
  audit,
  getUser,
  getUserRecord,
  getGrant,
  grantsForApp,
  grantsForUser,
  identityItem,
  linkIdentity,
  listApps,
  listIdentities,
  saveUser,
  signOutEverywhere,
  userIdForEmail,
} from './core';
import { BLOCKED, holdsRole, isPlatformAdmin, keys, PENDING, shownName, type GoogleIdentity, type Grant, type IdentityItem, type NotificationItem, type PlatformDeps, type PlatformUser } from './model';

/**
 * Settings › Sign-in methods (spec: Identity v2, "Self-serve merge"). A signed-in person links
 * another Google account; if that account already has a Stacks account, they are offered a merge
 * of it into the one they are signed in to. Merged accounts become aliases: apps resolve their old
 * ids to the person through `formerIds`, so no app data is rewritten.
 */

const TICKET_TTL_MS = 10 * 60_000;

export interface MergePlanApp {
  slug: string;
  name: string;
  /** Role ids, "PENDING", "BLOCKED" or null, before and after. */
  yours: string | null;
  theirs: string | null;
  result: string | null;
  resultLabel: string | null;
}

export interface MergePlan {
  other: { name: string; email: string };
  apps: MergePlanApp[];
  /** Why this merge can't happen from Settings; empty when it can. */
  problems: string[];
}

/**
 * One app's grant after a merge: a block on either side wins (a merge can't escape a block); else
 * the stronger role (listed earlier in the manifest); else a pending request; else nothing.
 */
export function mergedRole(manifest: AppManifest, a: string | null, b: string | null): string | null {
  if (a === BLOCKED || b === BLOCKED) return BLOCKED;
  const rank = (r: string | null) => (holdsRole(r) ? manifest.roles.findIndex((x) => x.id === r) : -1);
  if (holdsRole(a) || holdsRole(b)) {
    if (!holdsRole(b)) return a;
    if (!holdsRole(a)) return b;
    return rank(a) <= rank(b) ? a : b;
  }
  return a === PENDING || b === PENDING ? PENDING : null;
}

const label = (manifest: AppManifest, role: string | null) =>
  role === null ? null : role === PENDING ? 'Requested' : role === BLOCKED ? 'Blocked' : (roleDef(manifest, role)?.label ?? role);

/** What merging `from` into `into` would do, app by app, and anything that stops it. */
export async function planMerge(deps: PlatformDeps, into: PlatformUser, from: PlatformUser): Promise<MergePlan> {
  const problems: string[] = [];
  if (into.id === from.id) problems.push('That is the account you are signed in to.');
  if (into.mergedInto || from.mergedInto) problems.push('One of these accounts was already merged.');
  if (isPlatformAdmin(deps, into) || isPlatformAdmin(deps, from)) problems.push('Platform admin accounts can only be merged by a platform admin.');

  const theirs = await grantsForUser(deps, from.id);
  const apps: MergePlanApp[] = [];
  for (const app of await listApps(deps, { includeArchived: true })) {
    const m = app.manifest;
    const b = theirs.find((g) => g.app === m.slug)?.role ?? null;
    const a = (await getGrant(deps, m.slug, into.id))?.role ?? null;
    if (a === null && b === null) continue;
    const result = mergedRole(m, a, b);
    apps.push({ slug: m.slug, name: m.name, yours: a, theirs: b, result, resultLabel: label(m, result) });
    // Every app keeps at least one holder of its top role.
    if ((a === m.topRole || b === m.topRole) && result !== m.topRole) {
      const others = (await grantsForApp(deps, m.slug)).filter((g) => g.role === m.topRole && g.userId !== into.id && g.userId !== from.id);
      if (!others.length) problems.push(`${m.name} would lose its last ${roleDef(m, m.topRole)?.label ?? m.topRole}.`);
    }
  }
  return { other: { name: shownName(from), email: from.email }, apps: apps.sort((x, y) => x.name.localeCompare(y.name)), problems };
}

type TicketItem = Item & { into: string; from: string; provider: string; sub: string; email: string; notAfter: number; expiresAt: number };

const PROVIDER_LABEL: Record<string, string> = { google: 'Google account', apple: 'Apple ID' };

/** Link another Google account to `user` (see {@link linkProvider}). */
export const linkGoogle = (deps: PlatformDeps, user: PlatformUser, identity: GoogleIdentity) => linkProvider(deps, user, 'google', identity);

/**
 * Link another sign-in (a Google account, an Apple ID) to `user`. Returns `linked` when it was
 * nobody's, or a merge offer (a single-use ticket valid for ten minutes, plus the plan) when it
 * already belongs to another account.
 */
export async function linkProvider(
  deps: PlatformDeps,
  user: PlatformUser,
  provider: string,
  identity: Pick<GoogleIdentity, 'sub' | 'email' | 'name'> & { picture?: string },
): Promise<{ linked: true } | { linked: false; ticket: string; plan: MergePlan }> {
  const email = (identity.email ?? '').toLowerCase();
  const k = keys.identity(provider, identity.sub);
  const existing = await deps.store.get<IdentityItem>(k.PK, k.SK);
  const owner = existing ? await getUser(deps, existing.userId) : null;
  if (owner?.id === user.id) throw conflict(`That ${PROVIDER_LABEL[provider] ?? 'account'} is already one of your sign-in methods.`);
  if (!owner && !email) throw badRequest('Share an email address (it can be hidden) to link it');
  const other = owner ?? (await getUser(deps, (await userIdForEmail(deps, email)) ?? ''));
  if (other && other.id !== user.id) {
    const ticket = randomToken('stm_');
    const now = deps.now().getTime();
    await deps.store.put({
      ...keys.mergeTicket(await sha256Hex(ticket)),
      into: user.id,
      from: other.id,
      provider,
      sub: identity.sub,
      email,
      notAfter: now + TICKET_TTL_MS,
      expiresAt: Math.floor(now / 1000) + 3600,
    } satisfies TicketItem);
    return { linked: false, ticket, plan: await planMerge(deps, user, other) };
  }
  // Nobody has it (or the email is already this account's): just link it.
  await linkIdentity(deps, user, provider, { ...identity, email });
  if (other?.id !== user.id) {
    try {
      await deps.store.put({ ...keys.email(email), userId: user.id }, { ifNotExists: true });
      await saveUser(deps, { ...user, emails: [...new Set([...(user.emails ?? []), email])] });
    } catch {
      // Someone took the address in between: the identity is still linked, the email isn't.
    }
  }
  await audit(deps, user, 'platform', { action: 'identity.link', label: email, details: { provider } });
  return { linked: true };
}

/** Carry out a merge offer: everything of the other account moves to `user`, which it becomes an alias of. */
export async function mergeWithTicket(deps: PlatformDeps, user: PlatformUser, ticket: string): Promise<PlatformUser> {
  const k = keys.mergeTicket(await sha256Hex(String(ticket)));
  const t = await deps.store.get<TicketItem>(k.PK, k.SK);
  if (t) await deps.store.delete(k.PK, k.SK); // single use
  if (!t || t.into !== user.id || t.notAfter < deps.now().getTime()) throw badRequest('That merge offer has expired. Link the account again.');
  const from = await getUserRecord(deps, t.from);
  if (!from) throw badRequest('That account no longer exists.');
  const plan = await planMerge(deps, user, from);
  if (plan.problems.length) throw forbidden(plan.problems.join(' '));
  return mergeUsers(deps, user, from, plan, { provider: t.provider, sub: t.sub, email: t.email });
}

async function mergeUsers(deps: PlatformDeps, into: PlatformUser, from: PlatformUser, plan: MergePlan, via: { provider: string; sub: string; email: string }): Promise<PlatformUser> {
  const now = deps.now().toISOString();
  // Their sessions end first (this needs their grants to find the apps).
  await signOutEverywhere(deps, from.id);

  // Grants, app by app, as planned.
  for (const p of plan.apps) {

    const fromGrant = await getGrant(deps, p.slug, from.id);
    const intoGrant = await getGrant(deps, p.slug, into.id);
    if (fromGrant) {
      const k = keys.grant(p.slug, from.id);
      await deps.store.delete(k.PK, k.SK);
    }
    if (p.result !== null && p.result !== (intoGrant?.role ?? null)) {
      const requestedAt = intoGrant?.requestedAt ?? fromGrant?.requestedAt;
      const grant: Grant = { app: p.slug, userId: into.id, role: p.result, grantedBy: 'merge', grantedAt: now, ...(requestedAt ? { requestedAt } : {}) };
      await deps.store.put({ ...keys.grant(p.slug, into.id), ...grant });
    }
    if (holdsRole(intoGrant?.role)) await deps.appSessions.endUserSessions(p.slug, into.id).catch((err) => console.error(`Could not end ${p.slug} sessions`, err));
    await audit(deps, into, p.slug, { action: 'user.merge', label: shownName(from), details: { from: from.id, into: into.id, before: { yours: p.yours, theirs: p.theirs }, after: p.result } });
  }

  // Sign-in methods and emails.
  const identities = new Map((await listIdentities(deps, from.id)).map((i) => [`${i.provider}#${i.sub}`, i]));
  if (!identities.has(`${via.provider}#${via.sub}`)) identities.set(`${via.provider}#${via.sub}`, identityItem(from.id, via.provider, via.sub, via.email, now));
  for (const i of identities.values()) await deps.store.put(identityItem(into.id, i.provider, i.sub, i.email, i.linkedAt));
  const emails = [...new Set([from.email, ...(from.emails ?? [])].filter(Boolean).map((e) => e.toLowerCase()))].filter((e) => e !== into.email);
  for (const e of emails) await deps.store.put({ ...keys.email(e), userId: into.id });

  // Inbox.
  for (const n of await deps.store.query<NotificationItem>(`NOTIF#${from.id}`)) {
    await deps.store.put({ ...n, PK: `NOTIF#${into.id}` });
    await deps.store.delete(n.PK, n.SK);
  }

  // Profile: the signed-in account wins; the other only fills gaps.
  const merged: PlatformUser = {
    ...into,
    ...(into.displayName ? {} : from.displayName ? { displayName: from.displayName } : {}),
    ...(into.pictureUrl ? {} : from.pictureUrl ? { pictureUrl: from.pictureUrl } : {}),
    emails: [...new Set([...(into.emails ?? []), ...emails])],
    mergedFrom: [...new Set([...(into.mergedFrom ?? []), from.id, ...(from.mergedFrom ?? [])])],
    favorites: [...new Set([...(into.favorites ?? []), ...(from.favorites ?? [])])],
    recent: [...new Set([...(into.recent ?? []), ...(from.recent ?? [])])].slice(0, 8),
  };
  await saveUser(deps, merged);
  // The other account stays only as an alias (out of the grid's user list: no GSI1).
  const k = keys.user(from.id);
  await deps.store.put({ PK: k.PK, SK: k.SK, id: from.id, email: from.email, name: from.name, createdAt: from.createdAt, mergedInto: into.id, mergedAt: now });
  await audit(deps, into, 'platform', { action: 'user.merge', label: shownName(from), details: { from: from.id, into: into.id } });
  return merged;
}

/** Remove a linked sign-in method; the account must keep at least one, and the primary stays. */
export async function unlinkIdentity(deps: PlatformDeps, user: PlatformUser, provider: string, sub: string): Promise<void> {
  const mine = await listIdentities(deps, user.id);
  const target = mine.find((i) => i.provider === provider && i.sub === sub);
  if (!target) throw badRequest('That is not one of your sign-in methods.');
  if (user.primaryIdentity === `${provider}#${sub}`) throw conflict('That is your main sign-in: its name, photo and email are your profile. It can’t be removed.');
  if (mine.length < 2) throw conflict('You need at least one way to sign in.');
  await deps.store.delete(target.PK, target.SK);
  await audit(deps, user, 'platform', { action: 'identity.unlink', label: target.email, details: { provider } });
}
