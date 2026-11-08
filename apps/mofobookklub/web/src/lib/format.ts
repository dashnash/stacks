/** "Thursday, Oct 24 @ 7:00 PM PST", in the viewer's own time zone. */
export function formatMeetingDate(iso: string, locale?: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString(locale, { weekday: 'long', month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return `${day} @ ${time}`;
}

export function formatShortDate(iso: string, locale?: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** ISO string -> value for <input type="datetime-local"> in local time. */
export function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value (local time) -> ISO string. */
export function fromLocalInputValue(value: string): string {
  return new Date(value).toISOString();
}

/** True when the input looks like an ISBN rather than a title (mirrors the backend heuristic). */
export function looksLikeIsbn(input: string): boolean {
  return /^[\d\s-]{9,17}[\dXx]?$/.test(input.trim());
}

export interface PosterDate {
  weekday: string;
  month: string;
  day: string;
  /** "7pm" / "7:30pm" */
  time: string;
  /** Short time-zone name, e.g. "PST". */
  zone: string;
}

/** The pieces of a meeting date for the poster headline ("THU NOV 19", "7pm PST"). */
export function posterDate(iso: string, locale = 'en-US'): PosterDate {
  const d = new Date(iso);
  const part = (opts: Intl.DateTimeFormatOptions, type: Intl.DateTimeFormatPartTypes) =>
    new Intl.DateTimeFormat(locale, opts).formatToParts(d).find((p) => p.type === type)?.value ?? '';
  const minutes = d.getMinutes();
  const hour = d.getHours() % 12 || 12;
  return {
    weekday: part({ weekday: 'short' }, 'weekday'),
    month: part({ month: 'short' }, 'month'),
    day: String(d.getDate()),
    time: `${hour}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}${d.getHours() < 12 ? 'am' : 'pm'}`,
    zone: part({ timeZoneName: 'short' }, 'timeZoneName'),
  };
}

/** Whole calendar days from `now` until the date (0 = today, negative = past), in local time. */
export function daysUntil(iso: string, now = new Date()): number {
  const target = new Date(iso);
  const a = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86_400_000);
}

/** "just now", "5m ago", "3h ago", "2d ago", then a short date. */
export function timeAgo(iso: string, now = new Date()): string {
  const seconds = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`;
  return formatShortDate(iso);
}

/** "OCT ’26" style month stamp for the shelf. */
export function monthStamp(iso: string, locale = 'en-US'): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(locale, { month: 'short' })} ’${String(d.getFullYear()).slice(-2)}`;
}

/** "May 4, 2021" for ISO-style dates ("2021", "2021-05", "2021-05-04"); anything else as given. */
export function formatPublished(date: string, locale = 'en-US'): string {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date.trim());
  if (!m) return date;
  const [, y, mo, d] = m;
  if (!mo) return y!;
  const value = new Date(Date.UTC(Number(y), Number(mo) - 1, d ? Number(d) : 1));
  return value.toLocaleDateString(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    month: d ? 'short' : 'long',
    ...(d ? { day: 'numeric' } : {}),
  });
}
