import type { AuditEvent } from './audit';
import type { StacksUser } from './model';

/**
 * How an app talks to the platform. Apps never read the platform's table: they call its API with
 * their own credential. Tests and the demo use a fake.
 */
export interface PlatformClient {
  /** Swap a one-time sign-in code (step 8 of the handshake) for the user and their role here. */
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ user: StacksUser; role: string }>;
  /** Mirror an activity-log event into the platform's central feed. */
  recordAudit(event: AuditEvent): Promise<void>;
  /** What the account menu shows a user: their apps, inbox, role here, and approvals waiting. */
  account(userId: string): Promise<AccountData>;
  /** Everyone with a role in this app, pending requests, and blocked people. Names are display names. */
  access(): Promise<AppAccess>;
  /** Change a grant on behalf of `actorId` (the platform checks they manage this app). `role: null` removes; `"BLOCKED"` blocks. */
  setAccess(actorId: string, userId: string, role: string | null): Promise<void>;
  /** Put a message in a member's platform inbox (badge in the portal bar). */
  notify(userId: string, text: string, link?: string): Promise<void>;
}

export interface AppMember {
  /** Platform user id: what to store and look people up by. */
  id: string;
  /** Only for apps whose manifest has `needsEmail`. */
  email?: string;
  name: string;
  /** Ids of accounts merged into this one (see `StacksUser.formerIds`). */
  formerIds?: string[];
  pictureUrl?: string;
  /** A manifest role id; "PENDING" in `pending`; "BLOCKED" in `blocked`. */
  role: string;
  requestedAt?: string | null;
  grantedAt?: string | null;
}

export interface AppAccess {
  members: AppMember[];
  pending: AppMember[];
  /** People kept out: no auto-grant (public apps) and no new requests (private apps). */
  blocked: AppMember[];
}

export interface AccountData {
  /** The portal's catalog. */
  portalUrl: string;
  /** Platform profile (display name), with a way back to this app. */
  profileUrl: string;
  /** Platform inbox. */
  inboxUrl: string;
  unread: number;
  /** This app, and the viewer's role label in it. */
  app: { slug: string; name: string; roleLabel: string | null };
  /** Every app the viewer has a role in (this one included). */
  apps: { slug: string; name: string; url: string }[];
  /** For people who manage access here: requests waiting, and the portal grid for this app. */
  manage: { pending: number; href: string } | null;
}

export class PlatformError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export interface HttpPlatformClientOptions {
  /** The Platform API base URL, e.g. `https://auth.example.com/api`. */
  baseUrl: string;
  appSlug: string;
  /** The app's credential for the Platform API (from Secrets Manager); fetched lazily. */
  credential: () => Promise<string>;
  fetch?: typeof fetch;
}

/** The real {@link PlatformClient}: JSON over HTTPS to the Platform API. */
export class HttpPlatformClient implements PlatformClient {
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: HttpPlatformClientOptions) {
    this.doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(body === undefined ? 'GET' : 'POST', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${this.opts.baseUrl}/apps/${encodeURIComponent(this.opts.appSlug)}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await this.opts.credential()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok) throw new PlatformError(res.status, data.error ?? `Platform request failed (${res.status})`, data.code);
    return data as T;
  }

  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }) {
    return this.post<{ user: StacksUser; role: string }>('/token', input);
  }

  async recordAudit(event: AuditEvent): Promise<void> {
    await this.post('/audit', event);
  }

  account(userId: string): Promise<AccountData> {
    return this.post<AccountData>(`/account?user=${encodeURIComponent(userId)}`);
  }

  access(): Promise<AppAccess> {
    return this.post<AppAccess>('/access');
  }

  async setAccess(actorId: string, userId: string, role: string | null): Promise<void> {
    await this.request('PUT', `/access/${encodeURIComponent(userId)}`, { actorId, role });
  }

  async notify(userId: string, text: string, link?: string): Promise<void> {
    await this.post('/notify', { userId, text, link });
  }
}
