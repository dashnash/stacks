import type { AppManifest } from '@stacks/manifest';
import type { Item, Store } from '@stacks/api';

/** A person with a portal account. Anyone with a verified Google account can have one. */
export interface PlatformUser {
  /** Stable internal id (`u_…`): what grants, sessions, notifications and app data key on. */
  id: string;
  /** Primary contact email (from Google). Can change; never a key outside the `EMAIL#` index. */
  email: string;
  /** Full Google name: stored, never sent to apps. */
  name: string;
  /** Chosen display name (30 characters); empty means their first name. */
  displayName?: string;
  pictureUrl?: string;
  createdAt: string;
  favorites?: string[];
  /** The sign-in identity (`google#<sub>`) whose name, photo and email the profile follows. Others are linked. */
  primaryIdentity?: string;
  /** Other emails linked to this account (their `EMAIL#` items point here). */
  emails?: string[];
  /** Ids of accounts merged into this one: apps resolve them to this person (`formerIds`). */
  mergedFrom?: string[];
  /** Set on an account merged into another: it is only an alias from then on. */
  mergedInto?: string;
  mergedAt?: string;
  /** Slugs, most recent first (at most 8). */
  recent?: string[];
  /** Apps whose notifications don't reach this person's devices (they still fill the inbox). */
  mutedApps?: string[];
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
  userId: string;
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

/** A phone or tablet that gets this person's notifications (the iOS app, docs/NATIVE_APP_SPEC.md). */
export interface Device {
  id: string;
  userId: string;
  /** The APNs device token (hex). */
  token: string;
  /** `sandbox` for builds run from Xcode, `production` for TestFlight and the App Store. */
  env: 'sandbox' | 'production';
  bundleId: string;
  deviceName: string;
  createdAt: string;
  lastSeenAt: string;
  /** SHA-256 of the device secret the app keeps (for acting on notifications, N3b). */
  secretHash: string;
}

/** What a push says; the sender adds the device's token and topic. */
export interface PushMessage {
  /** Omitted for a badge-only update. */
  alert?: { title: string; body: string };
  badge: number;
  /** Absolute URL the app opens when the notification is tapped. */
  url?: string;
  /** Groups notifications per app on the lock screen. */
  threadId?: string;
}

/** Delivers to Apple. `gone`: the token is no longer valid (APNs 410 or BadDeviceToken). */
export interface PushSender {
  send(device: Pick<Device, 'token' | 'env' | 'bundleId'>, message: PushMessage): Promise<'ok' | 'gone' | 'failed'>;
}

export interface PlatformAuditEvent {
  id: string;
  at: string;
  /** App slug, or "platform" for the portal itself. */
  app: string;
  /** A user id, or "platform" for the platform itself. */
  actorId: string;
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
  endUserSessions(slug: string, userId: string): Promise<void>;
}

export interface GoogleIdentity {
  /** Google's stable account id (the ID token's `sub`). */
  sub: string;
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
  /** While true, every route but /health and /config answers 503 (the user-id cut-over). */
  maintenance?: boolean;
  /** The iOS app: the oldest version the web still supports (default 1.0.0). */
  minShellVersion?: string;
  /** The iOS app's bundle ID (the APNs topic); devices of other apps are refused. */
  iosBundleId?: string;
}

export interface PlatformDeps {
  store: Store;
  config: PlatformConfig;
  registry: AppRegistry;
  appSessions: AppSessionRevoker;
  verifyGoogle(credential: string): Promise<GoogleIdentity>;
  /** Push to the iOS app; without it (tests, before setup) notifications only fill the inbox. */
  push?: PushSender;
  now(): Date;
  newId(): string;
}

export const appOrigin = (config: PlatformConfig, slug: string) => `https://${slug}.${config.rootDomain}`;
/** Platform admins are configured by email (`stacks.config.json`), matched against the user's current email. */
export const isPlatformAdmin = (deps: PlatformDeps, user: Pick<PlatformUser, 'email'> | null | undefined) =>
  !!user && deps.config.platformAdmins.includes(user.email.toLowerCase());

/** User ids look like `u_` + 24 lower-case hex characters (96 random bits). */
export const USER_ID = /^u_[a-z0-9_]{6,40}$/;
export function newUserId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return `u_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export const keys = {
  user: (id: string) => ({ PK: `USER#${id}`, SK: 'PROFILE', GSI1PK: 'USERS', GSI1SK: id }),
  /** Unique lookup from an email (lower case) to the user who has it. */
  email: (email: string) => ({ PK: `EMAIL#${email.toLowerCase()}`, SK: 'EMAIL' }),
  /** Unique lookup from a sign-in identity (`google`, later `apple`) to its user. */
  identity: (provider: string, sub: string) => ({ PK: `IDENTITY#${provider}#${sub}`, SK: 'IDENTITY' }),
  /** GSI1 on identity items: a user's sign-in methods. */
  userIdentities: (userId: string) => `USERIDENTITIES#${userId}`,
  /** A single-use, short-lived offer to merge two accounts, keyed by the ticket's hash. */
  mergeTicket: (hash: string) => ({ PK: `MERGE#${hash}`, SK: 'MERGE' }),
  app: (slug: string) => ({ PK: `APP#${slug}`, SK: 'APP' }),
  grant: (slug: string, userId: string) => ({ PK: `APP#${slug}`, SK: `GRANT#${userId}`, GSI1PK: `USERGRANTS#${userId}`, GSI1SK: slug }),
  notification: (userId: string, at: string, id: string) => ({ PK: `NOTIF#${userId}`, SK: `${at}#${id}` }),
  /** A device, findable by id (acting on a notification) and, through GSI1, by its person. */
  device: (id: string, userId: string) => ({ PK: `DEVICE#${id}`, SK: 'DEVICE', GSI1PK: `USERDEVICES#${userId}`, GSI1SK: id }),
  /** Unique lookup from an APNs token to the device that has it (a phone signs in as someone else). */
  pushToken: (tokenHash: string) => ({ PK: `PUSHTOKEN#${tokenHash}`, SK: 'PUSHTOKEN' }),
};

export type EmailItem = Item & { userId: string };
export type IdentityItem = Item & { userId: string; provider: string; sub: string; email: string; linkedAt: string };

export type UserItem = Item & PlatformUser;
export type GrantItem = Item & Grant;
export type AppItem = Item & AppRecord;
export type NotificationItem = Item & Notification;
export type DeviceItem = Item & Device;
