import { appMembers, getPeople as sdkGetPeople, type Person } from '@stacks/api';
import type { Deps } from '../utils/deps.js';
import type { Role, User } from '../utils/model.js';

export type { Person };

/**
 * Members come from the platform now (it owns grants). `name` and `displayName` are both the
 * display name the platform gives, so `shownName()` keeps working unchanged.
 */
const toUser = (m: { email: string; name: string; pictureUrl?: string; role: string }): User => ({
  email: m.email,
  name: m.name,
  displayName: m.name,
  pictureUrl: m.pictureUrl,
  role: m.role as Role,
  createdAt: '',
});

export async function getUser(deps: Deps, email: string): Promise<User | undefined> {
  const m = (await appMembers(deps)).find((x) => x.email === email.toLowerCase());
  return m ? toUser(m) : undefined;
}

/** Members, admins and owners, sorted by the name the site shows. */
export async function listApprovedUsers(deps: Deps): Promise<User[]> {
  return (await appMembers(deps)).map(toUser).sort((a, b) => a.name.localeCompare(b.name));
}

export function person(user: User | undefined, fallbackEmail: string): Person {
  return user
    ? { email: user.email, name: user.displayName ?? user.name, ...(user.pictureUrl ? { pictureUrl: user.pictureUrl } : {}) }
    : // Someone who lost access (their posts stay): don't show their email address instead.
      { email: fallbackEmail, name: 'Former member' };
}

export const getPeople = (deps: Deps, emails: string[]) => sdkGetPeople(deps, emails);
