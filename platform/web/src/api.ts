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
    config: () => client.get<{ googleClientId: string; rootDomain: string; appleServicesId: string | null }>('/config'),
    me: () => client.get<Me>('/me'),
    signInWithGoogle: (credential: string) => client.post<{ user: Me['user'] }>('/auth/google', { credential }),
    signInWithApple: (credential: string, name?: string) => client.post<{ user: Me['user'] }>('/auth/apple', { credential, ...(name ? { name } : {}) }),
    signOut: () => client.post('/auth/logout'),
    signInMethods: () => client.get<{ identities: SignInMethod[]; emails: string[] }>('/me/identities'),
    linkGoogle: (credential: string) => client.post<LinkResult>('/me/identities/google', { credential }),
    linkApple: (credential: string, name?: string) => client.post<LinkResult>('/me/identities/apple', { credential, ...(name ? { name } : {}) }),
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
    monitoringMetrics: (range: MonitoringRange) => client.get<MonitoringMetrics>(`/admin/monitoring/metrics?range=${range}`),
    monitoringQuery: (body: QueryRequest) => client.post<QueryAnswer>('/admin/monitoring/query', body),
    monitoringQueryResult: (queryId: string) => client.get<QueryAnswer>(`/admin/monitoring/query/${encodeURIComponent(queryId)}`),
    stopMonitoringQuery: (queryId: string) => client.del(`/admin/monitoring/query/${encodeURIComponent(queryId)}`),
  };
}
export type PortalApi = ReturnType<typeof createPortalApi>;

/* ---------- Monitoring (#81) ---------- */

export type MonitoringRange = '1h' | '24h' | '7d' | '30d';
export type MonitoringQueryId = 'latestErrors' | 'slowestRequests' | 'browserErrors' | 'findByRef' | 'userTrail' | 'appRequests';

export interface AppHealth {
  app: string;
  requests: number;
  serverErrors: number;
  unhandled: number;
  clientErrors: number;
  p95Ms: number | null;
}
export interface MonitoringGraph {
  id: string;
  title: string;
  unit: 'count' | 'ms';
  /** `app` is the app the line belongs to (null for an AWS resource of no app). Points: [epoch ms, value]. */
  series: { label: string; app: string | null; points: [number, number][] }[];
}
export interface MonitoringMetrics {
  env: string;
  range: MonitoringRange;
  from: string;
  to: string;
  periodSeconds: number;
  logRetentionDays: number;
  consoleUrl: string;
  apps: AppHealth[];
  graphs: MonitoringGraph[];
}
/** A Logs Insights row with `message.` dropped: `ts`, `app`, `type`, `route`, `ref`, `userId`, `error`, `stack`, … */
export type LogRow = Record<string, string | undefined>;
export interface QueryAnswer {
  queryId: string | null;
  status: string;
  rows?: LogRow[];
  people?: Record<string, { name: string; email: string }>;
  /** The saved query's limit was reached: there may be more. */
  limited?: boolean;
  /** How far back the search went (the range, capped at the apps' log retention). */
  searchedDays?: number;
  /** The log retention cut the chosen range short. */
  capped?: boolean;
}
export interface QueryRequest {
  query: MonitoringQueryId;
  range: MonitoringRange;
  ref?: string;
  userId?: string;
  app?: string;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts a saved query and polls until it is done (at most a minute). */
export async function runQuery(api: PortalApi, body: QueryRequest, o: { pollMs?: number; maxMs?: number; signal?: AbortSignal } = {}): Promise<Required<Pick<QueryAnswer, 'rows' | 'people'>> & QueryAnswer> {
  const started = Date.now();
  let res = await api.monitoringQuery(body);
  const stop = (id: string | null) => id && void api.stopMonitoringQuery(id).catch(() => undefined);
  while ((res.status === 'Running' || res.status === 'Scheduled') && res.queryId) {
    const id = res.queryId;
    if (Date.now() - started > (o.maxMs ?? 60_000)) {
      stop(id);
      throw new Error('The query took too long; try a shorter range.');
    }
    await wait(o.pollMs ?? 1000);
    // Logs Insights runs a limited number of queries at once: stop the one nobody waits for.
    if (o.signal?.aborted) {
      stop(id);
      throw new DOMException('Stopped', 'AbortError');
    }
    try {
      res = await api.monitoringQueryResult(id);
    } catch (err) {
      stop(id);
      throw err;
    }
  }
  if (res.status !== 'Complete') throw new Error(`The query ended ${res.status.toLowerCase()}; try again.`);
  return { ...res, rows: res.rows ?? [], people: res.people ?? {} };
}
