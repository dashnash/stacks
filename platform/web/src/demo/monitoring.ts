import type { MetricSeries, Monitor, QueryStatus } from '@stacks/platform-api';

/*
 * The demo's CloudWatch (#81): made-up metrics and log lines, the same every load, served through
 * the real Platform API routes. Queries are recognized by the text the API builds, so the demo
 * exercises the same validation and query building as production.
 */

const APP_BASE: Record<string, number> = { platform: 6, mofobookklub: 4, hello: 2, potluck: 1, pickup: 1 };
const ROUTES: Record<string, string[]> = {
  platform: ['/api/me', '/authorize', '/api/admin/access', '/api/apps/:slug/request', '/api/catalog'],
  mofobookklub: ['/api/books', '/api/books/:id', '/api/meetings/:id/rsvp', '/api/comments/:thread'],
  hello: ['/api/greetings', '/api/greetings/:id'],
  potluck: ['/api/events', '/api/events/:id/dishes'],
  pickup: ['/api/games', '/api/games/:id/join'],
};
const APPS = Object.keys(APP_BASE);
export const DEMO_REF = '3f9a2c1b';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}
const hash = (str: string) => [...str].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const hex = (r: () => number, n = 8) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
/** Logs Insights' timestamp format (UTC). */
const ts = (t: number) => new Date(t).toISOString().replace('T', ' ').replace('Z', '');

function metricValues(id: string, label: string, start: number, end: number, period: number) {
  const r = rng(hash(`${id}|${label}|${period}`));
  const timestamps: number[] = [];
  const values: number[] = [];
  const step = period * 1000;
  const single = end - start <= step * 1.01;
  for (let t = Math.ceil(start / step) * step; t < end; t += step) {
    const hour = new Date(t).getUTCHours();
    const day = 0.35 + 0.65 * (Math.sin(((hour - 12) / 24) * Math.PI * 2) * 0.5 + 0.5);
    const perMin = (APP_BASE[label] ?? 1) * day * (0.6 + r() * 0.8);
    const minutes = period / 60;
    let v: number | null;
    const kind = id.replace(/^t(?=[A-Z])/, '').replace(/^./, (c) => c.toLowerCase());
    // Errors are rare and only in a couple of apps, so the health table shows all three colors.
    const errorRate = (kind === 'clientErrors' ? { pickup: 0.004 } : kind === 'unhandled' ? { mofobookklub: 0.002 } : { mofobookklub: 0.004 })[label as 'pickup'] ?? 0;
    if (kind === 'requests') v = Math.round(perMin * minutes);
    else if (kind === 'serverErrors' || kind === 'unhandled' || kind === 'clientErrors') v = single ? Math.round(errorRate * 1000 * Math.min(1, (end - start) / 86_400_000) + (errorRate ? 1 : 0)) : r() < errorRate * Math.min(minutes, 60) ? 1 : 0;
    else if (kind === 'p95') v = r() < 0.12 ? null : Math.round((label === 'mofobookklub' ? 420 : label === 'potluck' ? 1300 : 150) * (0.7 + r() * 0.6) + (r() < 0.03 ? 900 : 0));
    else if (kind === 'lambdaP95') v = Math.round(90 + r() * 140);
    else v = r() < 0.002 ? 1 : 0;
    if (v === null) continue;
    timestamps.push(t);
    values.push(v);
  }
  // A whole-range total: one bucket, the sum (or for p95, a typical high value).
  if (single && !timestamps.length) {
    timestamps.push(start);
    values.push(0);
  }
  return { timestamps, values };
}

export function createDemoMonitor(o: { userIds: () => Promise<string[]> }): Monitor {
  let n = 0;
  const pending = new Map<string, { status: QueryStatus; rows: Record<string, string>[] }>();

  async function rowsFor(q: string, start: number, end: number): Promise<Record<string, string>[]> {
    const ids = [...(await o.userIds()), 'u_formerdemo1'];
    const r = rng(hash(q));
    const span = end - start;
    const appFilter = /filter message\.app = "([^"]+)"/.exec(q)?.[1];
    const apps = appFilter ? [appFilter] : APPS;
    const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
    const at = (i: number, count: number) => end - (span * (i + r() * 0.8)) / count;
    const err = (app: string) => [`ConditionalCheckFailedException: The conditional request failed`, `Timeout fetching Google Books`, `Cannot read properties of undefined (reading 'title')`][app === 'mofobookklub' ? 0 : Math.floor(r() * 3)]!;
    const serverStack = (app: string, route: string) =>
      `ConditionalCheckFailedException: The conditional request failed\n    at throwDefaultError (node_modules/@smithy/smithy-client/src/default-error-handler.ts:21:20)\n    at handler (apps/${app}/api/routes.ts:${100 + Math.floor(r() * 200)}:5) [${route}]\n    at Router.handle (packages/api/src/router.ts:88:22)`;
    const browserStack = `TypeError: Cannot read properties of undefined (reading 'seat')\n    at Xe (assets/index-BqT3k9.js:1:48211)\n    at Ri (assets/index-BqT3k9.js:1:91002)`;

    const ref = /message\.ref = "([^"]+)"/.exec(q)?.[1];
    if (ref) {
      if (ref !== DEMO_REF && r() < 0.4) return [];
      const t = end - 42 * 60_000;
      const userId = ids[0]!;
      return [
        { '@timestamp': ts(t), 'message.type': 'app', 'message.app': 'mofobookklub', 'message.userId': userId, 'message.message': 'rsvp: updating seat' },
        { '@timestamp': ts(t + 38), 'message.type': 'error', 'message.app': 'mofobookklub', 'message.userId': userId, 'message.route': '/api/meetings/:id/rsvp', 'message.error.name': 'ConditionalCheckFailedException', 'message.error.message': 'The conditional request failed', 'message.error.stack': serverStack('mofobookklub', '/api/meetings/:id/rsvp') },
        { '@timestamp': ts(t + 41), 'message.type': 'request', 'message.app': 'mofobookklub', 'message.userId': userId, 'message.method': 'POST', 'message.route': '/api/meetings/:id/rsvp', 'message.status': '500', 'message.durationMs': '41' },
      ];
    }
    const user = /message\.userId = "([^"]+)"/.exec(q)?.[1];
    if (user) {
      return Array.from({ length: 9 }, (_, i) => {
        const app = i < 2 ? 'platform' : i < 7 ? 'mofobookklub' : 'hello';
        const failed = i === 5;
        return {
          '@timestamp': ts(end - 3 * 3_600_000 + i * 6.5 * 60_000),
          'message.app': app,
          'message.type': failed ? 'error' : 'request',
          'message.method': failed ? 'POST' : 'GET',
          'message.route': pick(ROUTES[app]!),
          ...(failed ? { 'message.message': 'Unhandled error' } : { 'message.status': '200', 'message.durationMs': String(Math.round(40 + r() * 300)) }),
          'message.ref': failed ? DEMO_REF : hex(r),
          'message.userId': user,
        };
      });
    }
    if (q.includes('filter message.type in ["error", "client-error"]')) {
      return Array.from({ length: 8 }, (_, i) => {
        const app = apps.length > 1 && r() < 0.5 ? 'mofobookklub' : pick(apps);
        const browser = i > 0 && r() < 0.3;
        const route = pick(ROUTES[app]!);
        return {
          '@timestamp': ts(at(i, 8)),
          'message.app': app,
          'message.type': browser ? 'client-error' : 'error',
          ...(browser ? {} : { 'message.ref': i === 0 ? DEMO_REF : hex(r), 'message.route': route }),
          ...(r() < 0.85 ? { 'message.userId': pick(ids) } : {}),
          error: browser ? "Cannot read properties of undefined (reading 'seat')" : err(app),
        };
      });
    }
    if (q.includes('filter message.type = "client-error"')) {
      return Array.from({ length: 5 }, (_, i) => {
        const app = apps.length > 1 && r() < 0.6 ? 'pickup' : pick(apps);
        return {
          '@timestamp': ts(at(i, 5)),
          'message.app': app,
          ...(r() < 0.8 ? { 'message.userId': pick(ids) } : {}),
          'message.clientBuild': hex(r, 40),
          'message.source': pick(['error', 'unhandledrejection', 'render']),
          'message.path': pick(ROUTES[app]!).replace('/api', '').replace(/:\w+/, '7'),
          'message.message': pick(["Cannot read properties of undefined (reading 'seat')", 'Failed to fetch', 'Load failed']),
          'message.stack': browserStack,
        };
      });
    }
    // Slowest requests, or one app's requests.
    const slow = q.includes('sort message.durationMs desc');
    const rows = Array.from({ length: slow ? 12 : 15 }, (_, i) => {
      const app = pick(apps);
      return {
        '@timestamp': ts(at(slow ? Math.floor(r() * 12) : i, slow ? 12 : 15)),
        'message.app': app,
        'message.method': r() < 0.7 ? 'GET' : 'POST',
        'message.route': pick(ROUTES[app]!),
        'message.status': String(r() < 0.06 ? 500 : r() < 0.1 ? 404 : 200),
        'message.durationMs': String(slow ? Math.round(5200 - i * 380 + r() * 120) : Math.round(40 + r() * 400)),
        'message.ref': hex(r),
        ...(r() < 0.85 ? { 'message.userId': pick(ids) } : {}),
      };
    });
    return rows;
  }

  return {
    // The demo answers on the first poll.
    waitMs: 0,
    async getMetricData({ queries, start, end }) {
      const out: MetricSeries[] = [];
      for (const q of queries) {
        const period = Number(/, (\d+)\)$/.exec(q.expression)?.[1] ?? 300);
        const labels = q.expression.includes('{Stacks/')
          ? APPS
          : q.expression.includes('AWS/DynamoDB')
            ? ['stacks-demo-platform-Table ConditionCheckItem', 'stacks-demo-app-mofobookklub-Table PutItem']
            : APPS.map((a) => (a === 'platform' ? 'stacks-demo-platform-ApiHandler5D2B' : `stacks-demo-app-${a}-ApiHandler9F1C`));
        for (const base of labels) {
          const label = q.id === 'lambdaErrors' ? `${base} errors` : q.id === 'lambdaThrottles' ? `${base} throttles` : base;
          out.push({ id: q.id, label, ...metricValues(q.id, base, start.getTime(), end.getTime(), period) });
        }
      }
      return out;
    },
    async listApiLogGroups() {
      return APPS.map((a) => `/stacks/demo/${a}/api`);
    },
    async startQuery({ queryString, start, end }) {
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      pending.set(id, { status: 'Complete', rows: await rowsFor(queryString, start.getTime(), end.getTime()) });
      return id;
    },
    async stopQuery(queryId) {
      pending.delete(queryId);
    },
    async getQueryResults(queryId) {
      return pending.get(queryId) ?? { status: 'Unknown', rows: [] };
    },
  };
}
