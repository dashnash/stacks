import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../lib/auth';
import type { AuditEvent, Person } from '../lib/types';
import { ErrorNote, Spinner } from './ui';

/** Kinds of action to filter by: an action name prefix and its label. */
export const ACTION_FILTERS: [string, string][] = [
  ['', 'Everything'],
  ['auth', 'Sign-ins & sign-outs'],
  ['comment', 'Comments'],
  ['vote', 'Votes'],
  ['nomination', 'Nominations'],
  ['book', 'Book edits'],
  ['meeting', 'Meetings'],
  ['member', 'Member changes'],
];

const FIELD_NAMES: Record<string, string> = {
  title: 'title',
  author: 'author',
  publisher: 'publisher',
  publishedDate: 'publish date',
  pageCount: 'pages',
  subjects: 'subjects',
  coverUrl: 'cover',
  amazonUrl: 'Amazon link',
  description: 'description',
};

const quote = (text: unknown, max = 80) => {
  if (typeof text !== 'string' || !text) return '';
  return `“${text.length > max ? `${text.slice(0, max)}…` : text}”`;
};

/** One event as a sentence, without the actor's name (shown alongside). */
export function describeEvent(e: AuditEvent): string {
  const what = e.label ?? 'something';
  const d = e.details ?? {};
  const input = (d.input ?? {}) as Record<string, unknown>;
  switch (e.action) {
    case 'auth.login':
      return d.role === 'PENDING' ? 'signed in (waiting for approval)' : 'signed in';
    case 'auth.logout':
      return 'signed out';
    case 'nomination.create':
      return `nominated ${what}`;
    case 'nomination.withdraw':
      return `withdrew ${what} from The Lineup`;
    case 'vote.add':
      return `voted for ${what}`;
    case 'vote.remove':
      return `took back their vote for ${what}`;
    case 'comment.post':
      return `${input.parentId ? 'replied' : 'commented'} on ${what}: ${quote(input.body)}`;
    case 'comment.edit':
      return `edited a comment on ${what}: ${quote(input.body)}`;
    case 'comment.delete':
      return d.byAdmin
        ? `deleted ${String(d.author)}'s comment on ${what}: ${quote(d.text)}`
        : `deleted their comment on ${what}: ${quote(d.text)}`;
    case 'book.edit': {
      const fields = Object.keys((d.changes ?? {}) as object).map((f) => FIELD_NAMES[f] ?? f);
      return `edited ${what}${fields.length ? `: ${fields.join(', ')}` : ''}`;
    }
    case 'meeting.create':
      return `scheduled ${what}`;
    case 'meeting.edit':
      return `edited the meeting ${what}`;
    case 'meeting.pick_book':
      return `picked ${what} for the next meeting`;
    case 'meeting.clear_book':
      return `un-picked the book for ${what}`;
    case 'meeting.complete':
      return `wrapped up ${what}`;
    case 'member.approve':
      if (d.fromRole === 'PENDING') return `approved ${what}${d.toRole === 'ADMIN' ? ' as an admin' : ''}`;
      return d.toRole === 'ADMIN' ? `made ${what} an admin` : `made ${what} a member (no longer admin)`;
    case 'member.reject':
      return `dismissed ${what}'s sign-up`;
    case 'member.remove':
      return `removed ${what} from the site`;
    case 'member.rename':
      return `changed their display name to ${what}`;
    default:
      return `${e.action}${e.label ? ` · ${e.label}` : ''}`;
  }
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Everything recorded about an event, for when the sentence isn't enough. */
function EventDetails({ e }: { e: AuditEvent }) {
  const d = { ...(e.details ?? {}) };
  const changes = d.changes as Record<string, { from: unknown; to: unknown } | string> | undefined;
  delete d.changes;
  const rows: [string, string][] = [
    ['Who', `${e.actorName} (${e.actorEmail})`],
    ['When', new Date(e.at).toLocaleString()],
    ['Action', e.action],
    ...Object.entries(e.params ?? {}).map(([k, v]): [string, string] => [k, v]),
    ...Object.entries(d).map(([k, v]): [string, string] => [k, show(v)]),
  ];
  return (
    <div className="mt-2 space-y-2 border-l-2 border-ink/20 pl-3 text-xs">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-semibold text-ink/60">{k}</dt>
            <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{v}</dd>
          </div>
        ))}
      </dl>
      {changes && Object.keys(changes).length > 0 && (
        <table className="w-full text-left">
          <thead>
            <tr className="text-ink/60">
              <th className="pr-3 font-semibold">Field</th>
              <th className="pr-3 font-semibold">Before</th>
              <th className="font-semibold">After</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(changes).map(([field, change]) => (
              <tr key={field} className="align-top">
                <td className="pr-3">{FIELD_NAMES[field] ?? field}</td>
                <td className="pr-3 [overflow-wrap:anywhere]">
                  {typeof change === 'string' ? '…' : show(change.from)}
                </td>
                <td className="[overflow-wrap:anywhere]">{typeof change === 'string' ? change : show(change.to)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Group label for a day: "Today", "Yesterday" or a date. */
function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The admins' audit trail: every sign-in and change on the site, newest first, filterable by
 * person and kind of action. Each entry expands to everything that was recorded.
 */
export function AuditLog({ people }: { people: Person[] }) {
  const api = useApi();
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = await api.auditLog({ actor, action, before, limit: 100 });
        setEvents((prev) => (before ? [...prev, ...page.events] : page.events));
        setNextBefore(page.nextBefore);
      } catch (err) {
        setError(err as Error);
      } finally {
        setLoading(false);
      }
    },
    [api, actor, action],
  );

  useEffect(() => {
    void load();
  }, [load]);

  let lastDay = '';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="kicker">Person</span>
          <select className="input mt-1 !w-auto !py-2" value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.email} value={p.email}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="kicker">What</span>
          <select className="input mt-1 !w-auto !py-2" value={action} onChange={(e) => setAction(e.target.value)}>
            {ACTION_FILTERS.map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-ghost !px-4 !py-2" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      <ErrorNote error={error} />
      {!loading && events.length === 0 && !error && (
        <p className="voice text-xl text-ink/70">Nothing recorded{actor || action ? ' for this filter' : ' yet'}.</p>
      )}

      <ol aria-label="Activity" className="border-t-2 border-ink">
        {events.map((e) => {
          const day = dayLabel(e.at);
          const heading = day !== lastDay ? day : null;
          lastDay = day;
          return (
            <li key={e.id}>
              {heading && <p className="kicker border-b border-ink/15 bg-ink/5 px-2 py-1.5">{heading}</p>}
              <details className="group border-b border-ink/15 px-2 py-2.5">
                <summary className="flex cursor-pointer list-none gap-3 text-sm">
                  <span className="w-16 shrink-0 tabular-nums text-ink/60">
                    {new Date(e.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </span>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <strong>{e.actorName}</strong> {describeEvent(e)}
                  </span>
                  <span aria-hidden className="text-ink/40 group-open:rotate-90">
                    ›
                  </span>
                </summary>
                <EventDetails e={e} />
              </details>
            </li>
          );
        })}
      </ol>

      {loading && <Spinner label="Loading activity" />}
      {!loading && nextBefore && (
        <button type="button" className="btn-ghost" onClick={() => void load(nextBefore)}>
          Load older
        </button>
      )}
      <p className="text-xs text-ink/60">
        Every sign-in, sign-out and change is recorded: comments, votes, nominations, book edits, meetings and member
        changes. Reading pages isn&apos;t.
      </p>
    </div>
  );
}
