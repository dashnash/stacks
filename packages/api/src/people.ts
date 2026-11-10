import type { AppDeps } from './model';
import type { AppMember } from './platform';

/** A person as apps show them in lists and credits. */
export interface Person {
  /** Platform user id. */
  id: string;
  name: string;
  pictureUrl?: string;
}

const TTL_MS = 30_000;
const cache = new WeakMap<object, { at: number; members: Promise<AppMember[]> }>();

/** Current members of this app (from the platform), cached for 30 seconds per Lambda container. */
export function appMembers(deps: AppDeps): Promise<AppMember[]> {
  const hit = cache.get(deps.platform);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.members;
  const members = deps.platform.access().then((a) => a.members);
  members.catch(() => cache.delete(deps.platform));
  cache.set(deps.platform, { at: Date.now(), members });
  return members;
}

/** Forget cached members (after changing access). */
export function forgetMembers(deps: AppDeps): void {
  cache.delete(deps.platform);
}

/**
 * Names for a set of user ids. People who no longer have access show as "Former member", so their
 * old posts never reveal who they were.
 */
export async function getPeople(deps: AppDeps, ids: string[]): Promise<Map<string, Person>> {
  const members = await appMembers(deps);
  // A merged person's old ids resolve to them, so their old posts show their name.
  const byId = new Map(members.flatMap((m) => [m.id, ...(m.formerIds ?? [])].map((id) => [id, m] as const)));
  return new Map(
    [...new Set(ids)].map((id) => {
      const m = byId.get(id);
      return [id, m ? { id: m.id, name: m.name, ...(m.pictureUrl ? { pictureUrl: m.pictureUrl } : {}) } : { id, name: 'Former member' }];
    }),
  );
}

/**
 * Is `storedId` this person? True for their id and for the ids of accounts they merged into it
 * (`formerIds`). Use it for every "is this mine?" check on stored data.
 */
export function isUser(user: { id: string; formerIds?: string[] }, storedId: string | null | undefined): boolean {
  return !!storedId && (storedId === user.id || !!user.formerIds?.includes(storedId));
}

/** Every id this person's data may be stored under: theirs, then any merged into it. */
export const userIds = (user: { id: string; formerIds?: string[] }): string[] => [user.id, ...(user.formerIds ?? [])];
