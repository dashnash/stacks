import { badRequest, HttpError, log, notFound } from '@stacks/api';
import { apiLogRetentionDays, appMetricSearch, awsMetricSearch, dashboardName, queryText, SAVED_QUERIES, type SavedQueryId } from '@stacks/manifest/monitoring';
import { shownName, type PlatformDeps } from './model';
import { getUserRecord } from './core';

/*
 * The portal's Monitoring page (#81, docs/specs/81-admin-monitoring.md): the environment's metrics
 * and saved Logs Insights queries, read from CloudWatch for platform admins. The client never sends
 * query text: it names a saved query and validated values, and this module builds the text.
 */

export type MonitoringRange = '1h' | '24h' | '7d' | '30d';
export const MONITORING_RANGES: Record<MonitoringRange, { ms: number; periodSeconds: number }> = {
  '1h': { ms: 3_600_000, periodSeconds: 60 },
  '24h': { ms: 86_400_000, periodSeconds: 300 },
  '7d': { ms: 7 * 86_400_000, periodSeconds: 3_600 },
  '30d': { ms: 30 * 86_400_000, periodSeconds: 10_800 },
};

/**
 * The apps' API log retention: queries never ask for older logs. (The platform's own group keeps 3
 * months on production; past the apps' retention the console still has those.)
 */
export const logRetentionDays = apiLogRetentionDays;

export interface MetricQuery {
  /** Lower-case first letter, letters, digits and `_` (CloudWatch's rule). */
  id: string;
  expression: string;
  /** A dynamic label such as `${PROP('Dim.app')}`. */
  label: string;
}
export interface MetricSeries {
  id: string;
  label: string;
  /** Ascending, epoch ms. */
  timestamps: number[];
  values: number[];
}
export type QueryStatus = 'Scheduled' | 'Running' | 'Complete' | 'Failed' | 'Cancelled' | 'Timeout' | 'Unknown';

/** What the routes need from CloudWatch (`aws.ts` has the real one; tests use a fake). */
export interface Monitor {
  getMetricData(q: { queries: MetricQuery[]; start: Date; end: Date }): Promise<MetricSeries[]>;
  /** Names of this environment's API log groups (`/stacks/<tag>/<slug>/api`) that exist. */
  listApiLogGroups(): Promise<string[]>;
  /** The query id, or null when none of the log groups exists any more (nothing to search). */
  startQuery(q: { logGroupNames: string[]; queryString: string; start: Date; end: Date }): Promise<string | null>;
  /** Stops a query nobody waits for any more (Logs Insights runs a limited number at once). */
  stopQuery(queryId: string): Promise<void>;
  /** Rows keep Logs Insights' field names (`@timestamp`, `message.route`, …). */
  getQueryResults(queryId: string): Promise<{ status: QueryStatus; rows: Record<string, string>[] }>;
  /**
   * How long `POST /query` keeps polling before handing back the id (default 0: one look, then the
   * client polls). Holding the request open would show up in the platform's own `DurationMs` and
   * Slowest requests.
   */
  waitMs?: number;
}

const DAY_MS = 86_400_000;
/** The shortest zoomed window the metrics route serves. */
export const MIN_WINDOW_MS = 5 * 60_000;
const PERIODS = [60, 300, 900, 3_600, 10_800];

/**
 * The graph period for a window: the finest that keeps a line at most 360 points long (the presets
 * get 60 s, 5 min, 1 h and 3 h). CloudWatch keeps 1-minute points 15 days and 5-minute points 63
 * days, and refuses a finer period for a window starting before that. (Windows start at most 31
 * days ago today; the 63-day floor is there in case that limit grows.)
 */
export function periodFor(ms: number, startAgoMs: number): number {
  const floor = startAgoMs > 63 * DAY_MS ? 3_600 : startAgoMs > 15 * DAY_MS ? 300 : 60;
  return PERIODS.find((p) => p >= floor && ms / 1000 / p <= 360) ?? PERIODS.at(-1)!;
}

const EPOCH_MS = /^\d{1,15}$/;
/**
 * A zoomed window (`from` and `to`, epoch ms), or null when neither is given. `to` is cut at now; the
 * window is at least 5 minutes and starts at most 31 days ago (30d plus slack for a page left open).
 */
export function parseWindow(fromParam: unknown, toParam: unknown, now: Date): { start: Date; end: Date } | null {
  if ((fromParam === undefined || fromParam === '') && (toParam === undefined || toParam === '')) return null;
  if (typeof fromParam !== 'string' || typeof toParam !== 'string' || !EPOCH_MS.test(fromParam) || !EPOCH_MS.test(toParam))
    throw badRequest('"from" and "to" must both be epoch milliseconds');
  const start = Number(fromParam);
  const end = Math.min(Number(toParam), now.getTime());
  if (end - start < MIN_WINDOW_MS) throw badRequest('"from" must be at least 5 minutes before "to" and before now');
  if (start < now.getTime() - 31 * DAY_MS) throw badRequest('"from" can go back at most 31 days');
  return { start: new Date(start), end: new Date(end) };
}

export const parseRange = (value: unknown): MonitoringRange => {
  if (value === undefined || value === null || value === '') return '24h';
  if (typeof value === 'string' && Object.hasOwn(MONITORING_RANGES, value)) return value as MonitoringRange;
  throw badRequest('"range" must be 1h, 24h, 7d or 30d');
};

/**
 * A CloudWatch failure answers 424, not 502: the router logs every request line, and a 5xx would
 * count as a platform server error, turning the platform red on this very page (e.g. on staging
 * before the boundary allows GetMetricData).
 */
const upstream = (err: unknown): never => {
  log.warn('CloudWatch call failed', err);
  const name = err instanceof Error ? err.name : 'Error';
  throw new HttpError(424, `CloudWatch didn't answer: ${name}`, 'UPSTREAM');
};

function monitorOf(deps: PlatformDeps): { monitor: Monitor; tag: string } {
  // 404, not 503: a 5xx request line would count as a platform server error (see `upstream`).
  if (!deps.monitor || !deps.config.envTag) throw new HttpError(404, 'Monitoring is not set up here', 'UNAVAILABLE');
  return { monitor: deps.monitor, tag: deps.config.envTag };
}

/* ---------- metrics ---------- */

interface GraphDef {
  id: string;
  title: string;
  unit: 'count' | 'ms';
  queries: { id: string; build: (tag: string, p: number) => string; label: string }[];
}
const APP_LABEL = "${PROP('Dim.app')}";
const ours = (id: string, metric: string, stat = 'Sum') => ({ id, label: APP_LABEL, build: (tag: string, p: number) => appMetricSearch(tag, metric, stat, p) });
const aws = (id: string, schema: string, metric: string, label: string, stat = 'Sum', suffix = '') => ({
  id,
  label: `${label}${suffix}`,
  build: (tag: string, p: number) => awsMetricSearch(tag, schema, metric, stat, p),
});
const FN = "${PROP('Dim.FunctionName')}";

/** The dashboard's graphs (packages/infra `Monitoring`), in the same order. */
export const GRAPHS: GraphDef[] = [
  { id: 'requests', title: 'Requests per app', unit: 'count', queries: [ours('requests', 'Requests')] },
  { id: 'serverErrors', title: 'Server errors per app (5xx and unhandled)', unit: 'count', queries: [ours('serverErrors', 'ServerErrors'), ours('unhandled', 'UnhandledErrors')] },
  { id: 'clientErrors', title: 'Browser errors per app', unit: 'count', queries: [ours('clientErrors', 'ClientErrors')] },
  { id: 'p95', title: 'Request duration per app (p95)', unit: 'ms', queries: [ours('p95', 'DurationMs', 'p95')] },
  {
    id: 'lambdaErrors',
    title: 'Lambda errors and throttles',
    unit: 'count',
    queries: [aws('lambdaErrors', 'AWS/Lambda,FunctionName', 'Errors', FN, 'Sum', ' errors'), aws('lambdaThrottles', 'AWS/Lambda,FunctionName', 'Throttles', FN, 'Sum', ' throttles')],
  },
  { id: 'lambdaP95', title: 'Lambda duration (p95)', unit: 'ms', queries: [aws('lambdaP95', 'AWS/Lambda,FunctionName', 'Duration', FN, 'p95')] },
  {
    id: 'ddbThrottles',
    title: 'DynamoDB throttled requests',
    unit: 'count',
    queries: [aws('ddbThrottles', 'AWS/DynamoDB,TableName,Operation', 'ThrottledRequests', "${PROP('Dim.TableName')} ${PROP('Dim.Operation')}")],
  },
];

/** The health table's totals: our five metrics with one bucket for the whole range. */
const TOTALS = [ours('tRequests', 'Requests'), ours('tServerErrors', 'ServerErrors'), ours('tUnhandled', 'UnhandledErrors'), ours('tClientErrors', 'ClientErrors'), ours('tP95', 'DurationMs', 'p95')];

/** Which app an AWS resource belongs to: `stacks-<tag>-platform-…` or `stacks-<tag>-app-<slug>-…`. */
export function appOfResource(tag: string, name: string, slugs: string[]): string | undefined {
  if (name.startsWith(`stacks-${tag}-platform-`)) return 'platform';
  const rest = name.startsWith(`stacks-${tag}-app-`) ? name.slice(`stacks-${tag}-app-`.length) : undefined;
  if (rest === undefined) return undefined;
  // The slug, then the CDK logical id (upper case; slugs are lower case), so `sky` never takes
  // `sky-shot-ApiHandler…` of an app no longer registered.
  const whole = [...slugs].sort((a, b) => b.length - a.length).find((s) => rest.startsWith(`${s}-`) && /^[A-Z]/.test(rest.slice(s.length + 1)));
  if (whole) return whole;
  // Generated names are cut at 64 characters, which can cut a long slug: the longest piece before a
  // `-` that starts exactly one slug. Only for names that were cut; a shorter one is another app's.
  // The cut leaves a long piece of the slug (only slugs of 20+ characters get cut); a short piece
  // is another (e.g. retired) app's whole slug.
  if (name.length < 60) return undefined;
  for (let k = rest.lastIndexOf('-'); k >= 12; k = rest.lastIndexOf('-', k - 1)) {
    const matches = slugs.filter((s) => s.startsWith(rest.slice(0, k)));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  return undefined;
}

/**
 * `params.range` is a preset; `params.from` and `params.to` (epoch ms, both or neither) zoom to a
 * window instead, as dragging across a graph does: the answer's `range` is then `custom`.
 */
export async function monitoringMetrics(deps: PlatformDeps, params: { range?: unknown; from?: unknown; to?: unknown }, slugs: string[]) {
  const { monitor, tag } = monitorOf(deps);
  const now = deps.now();
  const window = parseWindow(params.from, params.to, now);
  // `range` is checked even when a window replaces it, so a bad one is always a 400.
  const preset = parseRange(params.range);
  const range: MonitoringRange | 'custom' = window ? 'custom' : preset;
  const end = window ? window.end : now;
  // The start goes on the minute (5 minutes past 15 days), as CloudWatch rounds it down anyway:
  // `from` then matches the first bucket, and the totals cover no minutes before the window. How
  // old the start is gets decided once, from the asked start, for the rounding and the period.
  const asked = window ? window.start.getTime() : now.getTime() - MONITORING_RANGES[range as MonitoringRange].ms;
  const ago = now.getTime() - asked;
  const step = (ago > 15 * DAY_MS ? 300 : 60) * 1000;
  const start = new Date(Math.floor(asked / step) * step);
  const ms = end.getTime() - start.getTime();
  const periodSeconds = window ? periodFor(ms, ago) : MONITORING_RANGES[range as MonitoringRange].periodSeconds;
  // One bucket for the whole window, a multiple of the period (CloudWatch's rule for older starts).
  const totalPeriod = Math.ceil(ms / 1000 / periodSeconds) * periodSeconds;
  const queries: MetricQuery[] = [
    ...GRAPHS.flatMap((g) => g.queries.map((q) => ({ id: q.id, label: q.label, expression: q.build(tag, periodSeconds) }))),
    ...TOTALS.map((q) => ({ id: q.id, label: q.label, expression: q.build(tag, totalPeriod) })),
  ];
  const results = await monitor.getMetricData({ queries, start, end }).catch(upstream);
  const byId = (id: string) => results.filter((r) => r.id === id);

  const known = ['platform', ...slugs];
  const appFor = (graphId: string, label: string) => (GRAPHS.findIndex((g) => g.id === graphId) < 4 ? label : appOfResource(tag, label.split(' ')[0]!, slugs));

  const graphs = GRAPHS.map((g) => ({
    id: g.id,
    title: g.title,
    unit: g.unit,
    series: g.queries.flatMap((q) =>
      byId(q.id)
        // The SEARCH matches the words `stacks` and `<tag>` anywhere; keep this environment's names only.
        .filter((r) => r.timestamps.length && (GRAPHS.findIndex((x) => x.id === g.id) < 4 || r.label.startsWith(`stacks-${tag}-`)))
        .map((r) => {
          // Server errors draw two lines per app; name the unhandled one.
          const label = q.id === 'unhandled' ? `${r.label} unhandled` : r.label;
          return { label, app: appFor(g.id, r.label) ?? null, points: r.timestamps.map((t, i) => [t, r.values[i]!] as [number, number]) };
        }),
    ),
  }));

  const sum = (id: string, app: string) => byId(id).filter((r) => r.label === app).reduce((s, r) => s + r.values.reduce((a, b) => a + b, 0), 0);
  // p95 over the whole range: the first bucket. CloudWatch rounds the start down, so a second,
  // tiny bucket at the end can follow; its p95 says little and must not win.
  const first = (id: string, app: string) => {
    const r = byId(id).find((x) => x.label === app && x.values.length);
    const i = r ? r.timestamps.findIndex((t) => t <= start.getTime() + totalPeriod * 500) : -1;
    return r && i >= 0 ? Math.round(r.values[i]!) : null;
  };
  // Only apps the query route accepts: metrics of an app no longer registered stay in the graphs.
  const apps = [...new Set(known)]
    .sort((a, b) => (a === 'platform' ? -1 : b === 'platform' ? 1 : a.localeCompare(b)))
    .map((app) => ({ app, requests: sum('tRequests', app), serverErrors: sum('tServerErrors', app), unhandled: sum('tUnhandled', app), clientErrors: sum('tClientErrors', app), p95Ms: first('tP95', app) }));

  return {
    env: tag,
    range,
    from: start.toISOString(),
    to: end.toISOString(),
    periodSeconds,
    logRetentionDays: logRetentionDays(tag),
    consoleUrl: `https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards/dashboard/${dashboardName(tag)}`,
    apps,
    graphs,
  };
}

/* ---------- log queries ---------- */

/** The first 8 characters of an API Gateway request id (base64-like: letters, digits, `-_+/=`). */
export const REF = /^[A-Za-z0-9_+/=-]{8}$/;
export const LOG_USER_ID = /^u_[A-Za-z0-9_-]{1,64}$/;
export const QUERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Builds the query text from a saved query and values already validated. */
export function buildQuery(id: SavedQueryId, v: { ref?: string; userId?: string; app?: string }): string {
  const lines: string[] = [...SAVED_QUERIES[id].query];
  if (id === 'findByRef') lines[1] = lines[1]!.replace('PASTE-REF', v.ref!);
  if (id === 'userTrail') lines[1] = lines[1]!.replace('u_PASTE-USER-ID', v.userId!);
  if (id === 'appRequests') lines[1] = lines[1]!.replace('APP-SLUG', v.app!);
  else if (v.app) lines.splice(2, 0, `filter message.app = "${v.app}"`);
  return queryText(lines);
}

/** `@timestamp` → `ts`, `message.route` → `route`, `message.error.stack` → `stack`, … */
function rowOut(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(raw)) {
    if (k === '@ptr') continue;
    const key = k === '@timestamp' ? 'ts' : k === 'message.error.message' ? 'error' : k === 'message.error.name' ? 'errorName' : k === 'message.error.stack' ? 'stack' : k.replace(/^message\./, '');
    out[key] = value;
  }
  return out;
}

async function withPeople(deps: PlatformDeps, rows: Record<string, string>[]) {
  const people: Record<string, { name: string; email: string }> = {};
  const ids = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v && LOG_USER_ID.test(v)))];
  // In parallel: a serial read per person would show up in the platform's own request durations.
  const users = await Promise.all(ids.map((id) => getUserRecord(deps, id).catch(() => null)));
  // The stored record, not the merge survivor: a merged-away id is shown as the id only.
  users.forEach((u, i) => {
    if (u && !u.mergedInto) people[ids[i]!] = { name: shownName(u), email: u.email };
  });
  return people;
}

/** Queries this portal started, so polling and stopping only reach those (1 hour). */
const startedKey = (queryId: string) => ({ PK: `MONQUERY#${queryId}`, SK: 'MONQUERY' });
type StartedQuery = { query: SavedQueryId; notAfter: number; searchedDays?: number; capped?: boolean };
type Searched = { searchedDays?: number; capped?: boolean };

async function startedQuery(deps: PlatformDeps, queryId: string): Promise<StartedQuery> {
  if (!QUERY_ID.test(queryId)) throw badRequest('Not a query id');
  const k = startedKey(queryId);
  const item = await deps.store.get<{ PK: string; SK: string } & StartedQuery>(k.PK, k.SK);
  if (!item || item.notAfter < deps.now().getTime()) throw notFound('No such query');
  return item;
}

const limitOf = (id: SavedQueryId) => Number(/^limit (\d+)$/.exec(SAVED_QUERIES[id].query.at(-1) ?? '')?.[1] ?? 0);

async function answer(deps: PlatformDeps, queryId: string | null, query: SavedQueryId, res: { status: QueryStatus; rows: Record<string, string>[] }, searched: Searched = {}) {
  if (res.status !== 'Complete') return { queryId, status: res.status };
  let rows = res.rows.map(rowOut);
  // The trail is fetched newest first so the limit keeps the latest lines; it reads oldest first.
  if (query === 'userTrail') rows = rows.reverse();
  return { queryId, status: res.status, rows, people: await withPeople(deps, rows), limited: rows.length >= limitOf(query), ...(searched.searchedDays ? { searchedDays: searched.searchedDays, capped: !!searched.capped } : {}) };
}

export async function startMonitoringQuery(deps: PlatformDeps, body: Record<string, unknown>, slugs: string[]) {
  const { monitor, tag } = monitorOf(deps);
  const id = body.query;
  if (typeof id !== 'string' || !Object.hasOwn(SAVED_QUERIES, id)) throw badRequest(`"query" must be one of ${Object.keys(SAVED_QUERIES).join(', ')}`);
  const query = id as SavedQueryId;
  const range = parseRange(body.range);
  const str = (k: string) => (body[k] === undefined || body[k] === null || body[k] === '' ? undefined : typeof body[k] === 'string' ? (body[k] as string) : '\0');
  const ref = str('ref');
  const userId = str('userId');
  const app = str('app');
  if (query === 'findByRef' ? !ref || !REF.test(ref) : ref !== undefined) throw badRequest('"ref" is the 8 characters of a ref, only for findByRef');
  if (query === 'userTrail' ? !userId || !LOG_USER_ID.test(userId) : userId !== undefined) throw badRequest('"userId" is a u_… id, only for userTrail');
  if (query === 'appRequests' ? !app : false) throw badRequest('"app" is required for appRequests');
  if (app !== undefined && app !== 'platform' && !slugs.includes(app)) throw badRequest('"app" must be platform or a registered app');

  const end = deps.now();
  const ms = Math.min(MONITORING_RANGES[range].ms, logRetentionDays(tag) * 86_400_000);
  const start = new Date(end.getTime() - ms);
  const logGroupNames = await monitor.listApiLogGroups().catch(upstream);
  const queryId = logGroupNames.length ? await monitor.startQuery({ logGroupNames, queryString: buildQuery(query, { ref, userId, app }), start, end }).catch(upstream) : null;
  // How far back the search went, and whether the log retention cut the chosen range short.
  const searched = { searchedDays: ms / 86_400_000, capped: ms < MONITORING_RANGES[range].ms };
  if (!queryId) return answer(deps, null, query, { status: 'Complete', rows: [] }, searched);
  try {
    const now = deps.now().getTime();
    await deps.store.put({ ...startedKey(queryId), query, ...searched, notAfter: now + 3_600_000, expiresAt: Math.floor(now / 1000) + 7_200 });
    const deadline = Date.now() + (monitor.waitMs ?? 0);
    for (;;) {
      const res = await monitor.getQueryResults(queryId).catch(upstream);
      if ((res.status !== 'Running' && res.status !== 'Scheduled') || Date.now() >= deadline) return await answer(deps, queryId, query, res, searched);
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (err) {
    // The page never gets this id, so nothing else could stop the query.
    await monitor.stopQuery(queryId).catch(() => undefined);
    throw err;
  }
}

export async function pollMonitoringQuery(deps: PlatformDeps, queryId: string) {
  const { monitor } = monitorOf(deps);
  const { query, searchedDays, capped } = await startedQuery(deps, queryId);
  return answer(deps, queryId, query, await monitor.getQueryResults(queryId).catch(upstream), { searchedDays, capped });
}

/** Stops a query the page no longer waits for. A query that already ended is fine. */
export async function stopMonitoringQuery(deps: PlatformDeps, queryId: string) {
  const { monitor } = monitorOf(deps);
  await startedQuery(deps, queryId);
  await monitor.stopQuery(queryId).catch((err: unknown) => log.info('StopQuery failed (the query may have ended)', { queryId, errorName: err instanceof Error ? err.name : 'Error' }));
  return { stopped: true };
}
