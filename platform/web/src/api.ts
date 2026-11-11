import { createClient, type Client } from '@stacks/web';

export interface Me {
  user: { id: string; email: string; name: string; displayName: string | null; googleName: string; pictureUrl: string | null; isPlatformAdmin: boolean };
  unread: number;
  pendingRequests: number;
  /** How many apps this person manages access to (0 hides the access grid). */
  managesApps: number;
}

export interface CatalogApp {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category: string | null;
  visibility: 'public' | 'private';
  url: string;
  status: 'live' | 'archived';
  /** A role id, "PENDING", "BLOCKED", or null. */
  access: string | null;
  accessLabel: string | null;
  favorite: boolean;
}

export interface Notification {
  id: string;
  at: string;
  text: string;
  link?: string;
  app?: string;
  read: boolean;
}

export interface Grid {
  isPlatformAdmin: boolean;
  apps: { slug: string; name: string; status: string; topRole: string; defaultRole: string | null; roles: { id: string; label: string; canManageAccess: boolean }[]; canManageApprovers: boolean }[];
  users: { id: string; email: string; name: string; pictureUrl: string | null }[];
  grants: { app: string; userId: string; role: string; requestedAt: string | null; grantedAt: string | null }[];
}

export interface AuditEvent {
  id: string;
  at: string;
  app: string;
  actorId: string;
  /** The actor's current email, when the platform still knows them. */
  actorEmail?: string;
  actorName: string;
  action: string;
  label?: string;
  details?: Record<string, unknown>;
}

export interface SignInMethod {
  provider: string;
  sub: string;
  email: string;
  linkedAt: string;
  /** The one whose name, photo and email are the profile; it can't be removed. */
  primary: boolean;
}

export interface MergePlan {
  other: { name: string; email: string };
  apps: { slug: string; name: string; yours: string | null; theirs: string | null; result: string | null; resultLabel: string | null }[];
  /** Why the merge can't happen from Settings; empty when it can. */
  problems: string[];
}

/** A phone or tablet with the iOS app that gets this person's notifications. */
export interface Device {
  id: string;
  deviceName: string;
  env: 'sandbox' | 'production';
  createdAt: string;
  lastSeenAt: string;
}

export type LinkResult = { linked: true } | { linked: false; ticket: string; plan: MergePlan };

/** The Platform API, typed. */
export function createPortalApi(client: Client = createClient()) {
  return {
    client,
    config: () => client.get<{ googleClientId: string; rootDomain: string }>('/config'),
    me: () => client.get<Me>('/me'),
    signInWithGoogle: (credential: string) => client.post<{ user: Me['user'] }>('/auth/google', { credential }),
    signOut: () => client.post('/auth/logout'),
    signInMethods: () => client.get<{ identities: SignInMethod[]; emails: string[] }>('/me/identities'),
    linkGoogle: (credential: string) => client.post<LinkResult>('/me/identities/google', { credential }),
    unlink: (m: Pick<SignInMethod, 'provider' | 'sub'>) => client.del(`/me/identities/${encodeURIComponent(m.provider)}/${encodeURIComponent(m.sub)}`),
    merge: (ticket: string) => client.post<{ user: Me['user'] }>('/me/merge', { ticket }),
    updateProfile: (displayName: string | null) => client.patch<{ user: Me['user'] }>('/me', { displayName }),
    catalog: () => client.get<{ apps: CatalogApp[]; recent: string[] }>('/catalog'),
    publicCatalog: () => client.get<{ apps: CatalogApp[] }>('/public/catalog'),
    requestAccess: (slug: string) => client.post<{ access: string }>(`/apps/${encodeURIComponent(slug)}/request`),
    setFavorite: (slug: string, on: boolean) => (on ? client.put(`/me/favorites/${encodeURIComponent(slug)}`, {}) : client.del(`/me/favorites/${encodeURIComponent(slug)}`)),
    notifications: () => client.get<{ notifications: Notification[] }>('/notifications'),
    markRead: () => client.post('/notifications/read'),
    devices: () => client.get<{ devices: Device[] }>('/devices'),
    registerDevice: (d: { token: string; env: string; bundleId: string; deviceName: string }) => client.post<{ device: Device; secret: string }>('/devices', d),
    removeDevice: (id: string) => client.del(`/devices/${encodeURIComponent(id)}`),
    notificationSettings: () => client.get<{ apps: { slug: string; name: string; muted: boolean }[] }>('/me/notification-settings'),
    setMuted: (slug: string, muted: boolean) => (muted ? client.put(`/me/muted/${encodeURIComponent(slug)}`, {}) : client.del(`/me/muted/${encodeURIComponent(slug)}`)),
    grid: () => client.get<Grid>('/admin/access'),
    setRole: (slug: string, userId: string, role: string | null) => client.put(`/admin/access/${encodeURIComponent(slug)}/${encodeURIComponent(userId)}`, { role }),
    audit: (q: { app?: string; actor?: string; action?: string; before?: string }) => {
      const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
      return client.get<{ events: AuditEvent[]; nextBefore: string | null }>(`/admin/audit${qs ? `?${qs}` : ''}`);
    },
  };
}
export type PortalApi = ReturnType<typeof createPortalApi>;
