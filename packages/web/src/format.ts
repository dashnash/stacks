/** "just now", "5m ago", "3h ago", "2d ago", then a short date. */
export function timeAgo(iso: string, now = new Date(), locale?: string): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)}d ago`;
  return formatShortDate(iso, locale);
}

export function formatShortDate(iso: string, locale?: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(iso: string, locale?: string): string {
  return new Date(iso).toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The first word of a name, for friendly greetings. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
