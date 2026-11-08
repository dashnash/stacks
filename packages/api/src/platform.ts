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

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.doFetch(`${this.opts.baseUrl}/apps/${encodeURIComponent(this.opts.appSlug)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await this.opts.credential()}` },
      body: JSON.stringify(body),
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
}
