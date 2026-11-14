import { log } from './log';
import type { AppDeps, StacksUser } from './model';
import type { Item } from './store';

/** One thing someone did in an app, for its activity log and the platform's central feed. */
export interface AuditEvent {
  id: string;
  /** ISO date-time. */
  at: string;
  /** The actor's platform user id. */
  actorId: string;
  actorName: string;
  /** e.g. "greeting.post", "auth.login". */
  action: string;
  /** What it was done to, as people know it: a title, a person's name. */
  label?: string;
  /** The route's ids. */
  params?: Record<string, string>;
  /** What was sent (credentials removed, long text shortened) and anything the handler adds. */
  details?: Record<string, unknown>;
}

type AuditItem = Item & AuditEvent;

/** One partition per month, sorted by time, so the log reads newest first cheaply. */
const monthKey = (iso: string) => `AUDIT#${iso.slice(0, 7)}`;

const SECRET_KEYS = new Set(['credential', 'token', 'password', 'secret', 'code', 'codeVerifier']);
const MAX_TEXT = 300;

/** Input as it is safe and useful to keep: no credentials, long text shortened. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object' && depth < 3) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEYS.has(k))
        .map(([k, v]) => [k, sanitize(v, depth + 1)]),
    );
  }
  return value;
}

/**
 * Record an event in the app's table and mirror it to the platform. Logging never breaks the
 * action it records: failures are reported to the console and otherwise ignored.
 */
export async function recordAudit(
  deps: AppDeps,
  actor: Pick<StacksUser, 'id' | 'name'>,
  event: Pick<AuditEvent, 'action' | 'label' | 'params' | 'details'>,
): Promise<void> {
  const at = deps.now().toISOString();
  const id = deps.newId();
  const record: AuditEvent = {
    id,
    at,
    actorId: actor.id,
    actorName: actor.name,
    action: event.action,
    ...(event.label ? { label: event.label } : {}),
    ...(event.params && Object.keys(event.params).length ? { params: event.params } : {}),
    ...(event.details && Object.keys(event.details).length ? { details: event.details } : {}),
  };
  await Promise.all([
    deps.store.put({ PK: monthKey(at), SK: `${at}#${id}`, ...record }).catch((err) => log.error('Could not record audit event', err)),
    deps.platform.recordAudit(record).catch((err) => log.error('Could not mirror audit event to the platform', err)),
  ]);
}

function previousMonth(iso: string): string {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString();
}

/**
 * Newest events first, before `before` (exclusive), optionally for one person and/or one kind of
 * action (a prefix such as "comment" matches all comment actions). Walks back a month at a time.
 */
export async function listAudit(
  deps: AppDeps,
  opts: { before?: string; limit?: number; actor?: string; action?: string; maxMonths?: number } = {},
): Promise<{ events: AuditEvent[]; nextBefore: string | null }> {
  const limit = Number.isFinite(opts.limit) ? Math.min(Math.max(Math.floor(opts.limit!), 1), 500) : 100;
  const before = opts.before ?? new Date(deps.now().getTime() + 1000).toISOString();
  const matches = (e: AuditEvent) =>
    e.at < before &&
    (!opts.actor || e.actorId === opts.actor) &&
    (!opts.action || e.action === opts.action || e.action.startsWith(opts.action.endsWith('.') ? opts.action : `${opts.action}.`));

  const events: AuditEvent[] = [];
  let month = before;
  for (let i = 0; i < (opts.maxMonths ?? 24); i++) {
    const items = await deps.store.query<AuditItem>(monthKey(month));
    const found = items
      .map(({ PK: _pk, SK: _sk, ...e }) => e as AuditEvent)
      .filter(matches)
      .sort((a, b) => (b.at === a.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));
    for (const e of found) {
      events.push(e);
      if (events.length === limit) return { events, nextBefore: e.at };
    }
    month = previousMonth(month);
  }
  return { events, nextBefore: null };
}
