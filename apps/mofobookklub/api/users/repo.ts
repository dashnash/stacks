import { appMembers, getPeople as sdkGetPeople, type Person } from '@stacks/api';
import type { Deps } from '../utils/deps.js';
import type { Role, User } from '../utils/model.js';

export type { Person };

/**
 * Members come from the platform now (it owns grants). `name` and `displayName` are both the
 * display name the platform gives, so `shownName()` keeps working unchanged.
 */
const toUser = (m: { id: string; email: string; name: string; pictureUrl?: string; role: string }): User => ({
  id: m.id,
  email: m.email,
  name: m.name,
  displayName: m.name,
  pictureUrl: m.pictureUrl,
  role: m.role as Role,
  createdAt: '',
});

export async function getUser(deps: Deps, id: string): Promise<User | undefined> {
  const m = (await appMembers(deps)).find((x) => x.id === id);
  return m ? toUser(m) : undefined;
}

/** Members, admins and owners, sorted by the name the site shows. */
export async function listApprovedUsers(deps: Deps): Promise<User[]> {
  return (await appMembers(deps)).map(toUser).sort((a, b) => a.name.localeCompare(b.name));
}

export function person(user: User | undefined, fallbackId: string): Person {
  return user
    ? { id: user.id, name: user.displayName ?? user.name, ...(user.pictureUrl ? { pictureUrl: user.pictureUrl } : {}) }
    : // Someone who lost access (their posts stay).
      { id: fallbackId, name: 'Former member' };
}

export const getPeople = (deps: Deps, ids: string[]) => sdkGetPeople(deps, ids);
