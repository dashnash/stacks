import { randomToken, sha256Hex } from './crypto';
import type { AppDeps, StacksUser } from './model';
import type { Item } from './store';

/**
 * App sessions live in the app's own table. Each is an opaque 256-bit token in a host-only
 * HttpOnly cookie; only its SHA-256 is stored. The platform deletes a user's sessions here when
 * their grant changes (via the USERSESSIONS# index), so a revoked user is out on their next request.
 */
export const SESSION_COOKIE = '__Host-stacks-session';
export const SESSION_PREFIX = 'stk_';
/** A session ends after this long without use (refreshed at most once a day). */
export const SESSION_IDLE_DAYS = 90;
const DAY_MS = 86_400_000;

export interface SessionRecord {
  user: StacksUser;
  role: string;
  createdAt: string;
  lastUsedAt: string;
  /** DynamoDB TTL, epoch seconds. */
  expiresAt: number;
}
type SessionItem = Item & SessionRecord;

const sessionKey = async (token: string) => ({ PK: `SESSION#${await sha256Hex(token)}`, SK: 'SESSION' });
export const userSessionsKey = (email: string) => `USERSESSIONS#${email.toLowerCase()}`;
const expiryFor = (at: Date) => Math.floor((at.getTime() + SESSION_IDLE_DAYS * DAY_MS) / 1000);

export async function createSession(deps: AppDeps, user: StacksUser, role: string): Promise<string> {
  const token = randomToken(SESSION_PREFIX);
  const now = deps.now();
  const record: SessionRecord = {
    user,
    role,
    createdAt: now.toISOString(),
    lastUsedAt: now.toISOString(),
    expiresAt: expiryFor(now),
  };
  await deps.store.put({
    ...(await sessionKey(token)),
    GSI1PK: userSessionsKey(user.email),
    GSI1SK: record.createdAt,
    ...record,
  });
  return token;
}

/** The live session for a token, or null. Refreshes its expiry at most once a day. */
export async function readSession(deps: AppDeps, token: string | undefined): Promise<SessionRecord | null> {
  if (!token || !token.startsWith(SESSION_PREFIX)) return null;
  const { PK, SK } = await sessionKey(token);
  const item = await deps.store.get<SessionItem>(PK, SK);
  if (!item) return null;
  const now = deps.now();
  const idle = now.getTime() - new Date(item.lastUsedAt).getTime();
  if (idle > SESSION_IDLE_DAYS * DAY_MS) {
    await deps.store.delete(PK, SK);
    return null;
  }
  if (idle > DAY_MS) await deps.store.put({ ...item, lastUsedAt: now.toISOString(), expiresAt: expiryFor(now) });
  return { user: item.user, role: item.role, createdAt: item.createdAt, lastUsedAt: item.lastUsedAt, expiresAt: item.expiresAt };
}

export async function endSession(deps: AppDeps, token: string | undefined): Promise<void> {
  if (!token || !token.startsWith(SESSION_PREFIX)) return;
  const { PK, SK } = await sessionKey(token);
  await deps.store.delete(PK, SK);
}

/** End every session a user has in this app (role changed, access revoked, removed). */
export async function endUserSessions(deps: AppDeps, email: string): Promise<number> {
  const items = await deps.store.queryGsi1<SessionItem>(userSessionsKey(email));
  await Promise.all(items.map((i) => deps.store.delete(i.PK, i.SK)));
  return items.length;
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export const sessionCookie = (token: string) => cookie(SESSION_COOKIE, token, SESSION_IDLE_DAYS * 86_400);
export const clearCookie = (name: string) => cookie(name, '', 0);
