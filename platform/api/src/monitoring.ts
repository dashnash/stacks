import { badRequest, HttpError, log } from '@stacks/api';
import { appMetricSearch, awsMetricSearch, dashboardName, queryText, SAVED_QUERIES, type SavedQueryId } from '@stacks/manifest/monitoring';
import { shownName, type PlatformDeps } from './model';
import { getUser } from './core';

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

/** API log retention (`packages/infra`): logs older than this are gone, so queries never ask for them. */
export const logRetentionDays = (tag: string) => (tag === 'prod' ? 30 : 7);

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
  startQuery(q: { logGroupNames: string[]; queryString: string; start: Date; end: Date }): Promise<string>;
  /** Rows keep Logs Insights' field names (`@timestamp`, `message.route`, …). */
  getQueryResults(queryId: string): Promise<{ status: QueryStatus; rows: Record<string, string>[] }>;
  /** How long `POST /query` waits for a result before handing back the id (default 8 s). */
  waitMs?: number;
}

export const parseRange = (value: unknown): MonitoringRange => {
  if (value === undefined || value === null || value === '') return '24h';
  if (typeof value === 'string' && value in MONITORING_RANGES) return value as MonitoringRange;
  throw badRequest('"range" must be 1h, 24h, 7d or 30d');
};

const upstream = (err: unknown): never => {
  log.warn('CloudWatch call failed', err);
  const name = err instanceof Error ? err.name : 'Error';
  throw new HttpError(502, `CloudWatch didn't answer: ${name}`, 'UPSTREAM');
};

function monitorOf(deps: PlatformDeps): { monitor: Monitor; tag: string } {
  if (!deps.monitor || !deps.config.envTag) throw new HttpError(503, 'Monitoring is not set up here', 'UNAVAILABLE');
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
  return [...slugs].sort((a, b) => b.length - a.length).find((s) => rest.startsWith(`${s}-`));
}

export async function monitoringMetrics(deps: PlatformDeps, rangeParam: unknown, slugs: string[]) {
  const { monitor, tag } = monitorOf(deps);
  const range = parseRange(rangeParam);
  const { ms, periodSeconds } = MONITORING_RANGES[range];
  const end = deps.now();
  const start = new Date(end.getTime() - ms);
  const totalPeriod = Math.ceil(ms / 1000 / 60) * 60;
  const queries: MetricQuery[] = [
    ...GRAPHS.flatMap((g) => g.queries.map((q) => ({ id: q.id, label: q.label, expression: q.build(tag, periodSeconds) }))),
    ...TOTALS.map((q) => ({ id: q.id, label: q.label, expression: q.build(tag, totalPeriod) })),
  ];
  const results = await monitor.getMetricData({ queries, start, end }).catch(upstream);
  const byId = (id: string) => results.filter((r) => r.id === id);

  const known = ['platform', ...slugs];
  const appFor = (graphId: string, label: string) => (GRAPHS.findIndex((g) => g.id === graphId) < 4 ? label : appOfResource(tag, label, slugs));

  const graphs = GRAPHS.map((g) => ({
    id: g.id,
    title: g.title,
    unit: g.unit,
    series: g.queries.flatMap((q) =>
      byId(q.id)
        .filter((r) => r.timestamps.length)
        .map((r) => {
          // Server errors draw two lines per app; name the unhandled one.
          const label = q.id === 'unhandled' ? `${r.label} unhandled` : r.label;
          return { label, app: appFor(g.id, r.label) ?? null, points: r.timestamps.map((t, i) => [t, r.values[i]!] as [number, number]) };
        }),
    ),
  }));

  const sum = (id: string, app: string) => byId(id).filter((r) => r.label === app).reduce((s, r) => s + r.values.reduce((a, b) => a + b, 0), 0);
  const max = (id: string, app: string) => {
    const v = byId(id).filter((r) => r.label === app).flatMap((r) => r.values);
    return v.length ? Math.round(Math.max(...v)) : null;
  };
  const seen = new Set([...known, ...TOTALS.flatMap((q) => byId(q.id).map((r) => r.label))].filter(Boolean));
  const apps = [...seen]
    .sort((a, b) => (a === 'platform' ? -1 : b === 'platform' ? 1 : a.localeCompare(b)))
    .map((app) => ({ app, requests: sum('tRequests', app), serverErrors: sum('tServerErrors', app), unhandled: sum('tUnhandled', app), clientErrors: sum('tClientErrors', app), p95Ms: max('tP95', app) }));

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

export const REF = /^[A-Za-z0-9]{8}$/;
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
  for (const id of new Set(rows.map((r) => r.userId).filter((v): v is string => !!v && LOG_USER_ID.test(v)))) {
    const u = await getUser(deps, id).catch(() => null);
    if (u && !u.mergedInto) people[id] = { name: shownName(u), email: u.email };
  }
  return people;
}

async function answer(deps: PlatformDeps, queryId: string, res: { status: QueryStatus; rows: Record<string, string>[] }) {
  if (res.status !== 'Complete') return { queryId, status: res.status };
  const rows = res.rows.map(rowOut);
  return { queryId, status: res.status, rows, people: await withPeople(deps, rows) };
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
  if (query === 'findByRef' ? !ref || !REF.test(ref) : ref !== undefined) throw badRequest('"ref" is 8 letters and digits, only for findByRef');
  if (query === 'userTrail' ? !userId || !LOG_USER_ID.test(userId) : userId !== undefined) throw badRequest('"userId" is a u_… id, only for userTrail');
  if (query === 'appRequests' ? !app : false) throw badRequest('"app" is required for appRequests');
  if (app !== undefined && app !== 'platform' && !slugs.includes(app)) throw badRequest('"app" must be platform or a registered app');

  const end = deps.now();
  const ms = Math.min(MONITORING_RANGES[range].ms, logRetentionDays(tag) * 86_400_000);
  const start = new Date(end.getTime() - ms);
  const logGroupNames = await monitor.listApiLogGroups().catch(upstream);
  if (!logGroupNames.length) return { queryId: null, status: 'Complete' as const, rows: [], people: {} };
  const queryId = await monitor.startQuery({ logGroupNames, queryString: buildQuery(query, { ref, userId, app }), start, end }).catch(upstream);

  const deadline = Date.now() + (monitor.waitMs ?? 8_000);
  for (;;) {
    const res = await monitor.getQueryResults(queryId).catch(upstream);
    if ((res.status !== 'Running' && res.status !== 'Scheduled') || Date.now() >= deadline) return answer(deps, queryId, res);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function pollMonitoringQuery(deps: PlatformDeps, queryId: string) {
  const { monitor } = monitorOf(deps);
  if (!QUERY_ID.test(queryId)) throw badRequest('Not a query id');
  return answer(deps, queryId, await monitor.getQueryResults(queryId).catch(upstream));
}
