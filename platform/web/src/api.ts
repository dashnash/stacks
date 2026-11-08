import { createClient, type Client } from '@stacks/web';

export interface Me {
  user: { email: string; name: string; displayName: string | null; googleName: string; pictureUrl: string | null; isPlatformAdmin: boolean };
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
  users: { email: string; name: string; pictureUrl: string | null }[];
  grants: { app: string; email: string; role: string; requestedAt: string | null; grantedAt: string | null }[];
}

export interface AuditEvent {
  id: string;
  at: string;
  app: string;
  actorEmail: string;
  actorName: string;
  action: string;
  label?: string;
  details?: Record<string, unknown>;
}

/** The Platform API, typed. */
export function createPortalApi(client: Client = createClient()) {
  return {
    client,
    config: () => client.get<{ googleClientId: string; rootDomain: string }>('/config'),
    me: () => client.get<Me>('/me'),
    signInWithGoogle: (credential: string) => client.post<{ user: Me['user'] }>('/auth/google', { credential }),
    signOut: () => client.post('/auth/logout'),
    updateProfile: (displayName: string | null) => client.patch<{ user: Me['user'] }>('/me', { displayName }),
    catalog: () => client.get<{ apps: CatalogApp[]; recent: string[] }>('/catalog'),
    publicCatalog: () => client.get<{ apps: CatalogApp[] }>('/public/catalog'),
    requestAccess: (slug: string) => client.post<{ access: string }>(`/apps/${encodeURIComponent(slug)}/request`),
    setFavorite: (slug: string, on: boolean) => (on ? client.put(`/me/favorites/${encodeURIComponent(slug)}`, {}) : client.del(`/me/favorites/${encodeURIComponent(slug)}`)),
    notifications: () => client.get<{ notifications: Notification[] }>('/notifications'),
    markRead: () => client.post('/notifications/read'),
    grid: () => client.get<Grid>('/admin/access'),
    setRole: (slug: string, email: string, role: string | null) => client.put(`/admin/access/${encodeURIComponent(slug)}/${encodeURIComponent(email)}`, { role }),
    audit: (q: { app?: string; actor?: string; action?: string; before?: string }) => {
      const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
      return client.get<{ events: AuditEvent[]; nextBefore: string | null }>(`/admin/audit${qs ? `?${qs}` : ''}`);
    },
  };
}
export type PortalApi = ReturnType<typeof createPortalApi>;
