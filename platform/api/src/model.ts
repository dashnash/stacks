import type { AppManifest } from '@stacks/manifest';
import type { Item, Store } from '@stacks/api';

/** A person with a portal account. Anyone with a verified Google account can have one. */
export interface PlatformUser {
  email: string;
  /** Full Google name: stored, never sent to apps. */
  name: string;
  /** Chosen display name (30 characters); empty means their first name. */
  displayName?: string;
  pictureUrl?: string;
  createdAt: string;
  favorites?: string[];
  /** Slugs, most recent first (at most 8). */
  recent?: string[];
}

/** The name apps and other people see: the chosen display name, else the first word of the Google name. */
export function shownName(u: Pick<PlatformUser, 'name' | 'displayName' | 'email'>): string {
  return u.displayName?.trim() || u.name.trim().split(/\s+/)[0] || u.email.split('@')[0]!;
}

export const MAX_DISPLAY_NAME = 30;
export const PENDING = 'PENDING';
/** Kept out of the app: no role, no auto-grant on a public app, no new requests on a private one. */
export const BLOCKED = 'BLOCKED';

/** Does this grant give access (a manifest role), rather than a pending request or a block? */
export function holdsRole(role: string | null | undefined): role is string {
  return !!role && role !== PENDING && role !== BLOCKED;
}

/** One user's access to one app: a manifest role, a pending request, or a block. */
export interface Grant {
  app: string;
  email: string;
  role: string;
  grantedBy?: string;
  grantedAt?: string;
  requestedAt?: string;
}

/** The platform's own record of an app (the manifest comes from the registry). */
export interface AppRecord {
  slug: string;
  status: 'live' | 'archived';
  registeredAt: string;
}

export interface Notification {
  id: string;
  at: string;
  text: string;
  /** Where clicking it goes (absolute URL or portal hash route). */
  link?: string;
  app?: string;
  read: boolean;
}

export interface PlatformAuditEvent {
  id: string;
  at: string;
  /** App slug, or "platform" for the portal itself. */
  app: string;
  actorEmail: string;
  actorName: string;
  action: string;
  label?: string;
  params?: Record<string, string>;
  details?: Record<string, unknown>;
}

/** An app the platform knows about from the registry (written by each app stack on deploy). */
export interface RegisteredApp {
  manifest: AppManifest;
  /** The app's credential for calling the Platform API. */
  credential(): Promise<string>;
}

export interface AppRegistry {
  list(): Promise<RegisteredApp[]>;
}

/** Ends a user's sessions inside an app (in that app's own table). */
export interface AppSessionRevoker {
  endUserSessions(slug: string, email: string): Promise<void>;
}

export interface GoogleIdentity {
  email: string;
  name: string;
  picture?: string;
}

export interface PlatformConfig {
  /** Apps live at `<slug>.<rootDomain>`. */
  rootDomain: string;
  /** `https://auth.<rootDomain>`: the portal and sign-in. */
  authOrigin: string;
  googleClientId: string;
  /** Lower-case emails of platform super-admins. */
  platformAdmins: string[];
}

export interface PlatformDeps {
  store: Store;
  config: PlatformConfig;
  registry: AppRegistry;
  appSessions: AppSessionRevoker;
  verifyGoogle(credential: string): Promise<GoogleIdentity>;
  now(): Date;
  newId(): string;
}

export const appOrigin = (config: PlatformConfig, slug: string) => `https://${slug}.${config.rootDomain}`;
export const isPlatformAdmin = (deps: PlatformDeps, email: string) => deps.config.platformAdmins.includes(email.toLowerCase());

export const keys = {
  user: (email: string) => ({ PK: `USER#${email}`, SK: 'PROFILE', GSI1PK: 'USERS', GSI1SK: email }),
  app: (slug: string) => ({ PK: `APP#${slug}`, SK: 'APP' }),
  grant: (slug: string, email: string) => ({ PK: `APP#${slug}`, SK: `GRANT#${email}`, GSI1PK: `USERGRANTS#${email}`, GSI1SK: slug }),
  notification: (email: string, at: string, id: string) => ({ PK: `NOTIF#${email}`, SK: `${at}#${id}` }),
};

export type UserItem = Item & PlatformUser;
export type GrantItem = Item & Grant;
export type AppItem = Item & AppRecord;
export type NotificationItem = Item & Notification;
