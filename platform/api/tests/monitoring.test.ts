import { describe, expect, it } from 'vitest';
import { queryText, SAVED_QUERIES } from '@stacks/manifest/monitoring';
import { appOfResource, buildQuery, type MetricQuery, type MetricSeries, type Monitor, type QueryStatus } from '../src/monitoring';
import { createPlatformHarness } from './helpers';

const QID = '0a1b2c3d-1111-2222-3333-444455556666';

function fakeMonitor(o: { series?: (q: MetricQuery[]) => MetricSeries[]; status?: QueryStatus[]; rows?: Record<string, string>[]; groups?: string[]; fail?: boolean } = {}) {
  const calls = { metrics: [] as { queries: MetricQuery[]; start: Date; end: Date }[], queries: [] as { logGroupNames: string[]; queryString: string; start: Date; end: Date }[], polls: 0, stopped: [] as string[] };
  const statuses = [...(o.status ?? ['Complete'])];
  const err = () => Object.assign(new Error('nope'), { name: 'AccessDeniedException' });
  const monitor: Monitor = {
    waitMs: 0,
    getMetricData: async (q) => {
      if (o.fail) throw err();
      calls.metrics.push(q);
      return o.series?.(q.queries) ?? [];
    },
    listApiLogGroups: async () => o.groups ?? ['/stacks/prod/club/api', '/stacks/prod/platform/api'],
    startQuery: async (q) => {
      if (o.fail) throw err();
      calls.queries.push(q);
      return QID;
    },
    stopQuery: async (id) => {
      calls.stopped.push(id);
    },
    getQueryResults: async () => {
      calls.polls++;
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      return { status, rows: status === 'Complete' ? (o.rows ?? []) : [] };
    },
  };
  return { monitor, calls };
}

function setup(o: Parameters<typeof fakeMonitor>[0] = {}) {
  const h = createPlatformHarness();
  const fake = fakeMonitor(o);
  h.deps.monitor = fake.monitor;
  h.deps.config.envTag = 'prod';
  return { ...h, ...fake };
}

const ADMIN = 'root@test.dev';

describe('monitoring access', () => {
  it('answers 401 signed out and 403 to anyone but a platform admin, on every route', async () => {
    const h = setup();
    const routes: [string, string, unknown?][] = [
      ['GET', '/admin/monitoring/metrics'],
      ['POST', '/admin/monitoring/query', { query: 'latestErrors' }],
      ['GET', `/admin/monitoring/query/${QID}`],
      ['DELETE', `/admin/monitoring/query/${QID}`],
    ];
    for (const [method, path, body] of routes) {
      expect((await h.call(method, path, { body })).status).toBe(401);
      // An app owner manages access but is not a platform admin.
      const res = await h.call(method, path, { as: 'owner@test.dev', body });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Platform admins only');
    }
    expect(h.calls.metrics).toHaveLength(0);
    expect(h.calls.queries).toHaveLength(0);
    expect(h.calls.polls).toBe(0);
    expect(h.calls.stopped).toEqual([]);
  });

  it('needs the CSRF header to start a query', async () => {
    const h = setup();
    const res = await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'latestErrors' }, headers: { 'x-stacks-request': '' } });
    expect(res.status).toBe(403);
  });

  it('answers 503 where no monitor is set up', async () => {
    const h = createPlatformHarness();
    expect((await h.call('GET', '/admin/monitoring/metrics', { as: ADMIN })).status).toBe(503);
  });
});

describe('GET /admin/monitoring/metrics', () => {
  it('asks for the dashboard expressions with the period of the range', async () => {
    const h = setup();
    for (const [range, period] of [['1h', 60], ['24h', 300], ['7d', 3600], ['30d', 10800]] as const) {
      const res = await h.call('GET', '/admin/monitoring/metrics', { as: ADMIN, query: { range } });
      expect(res.status).toBe(200);
      const q = h.calls.metrics.at(-1)!;
      const req = q.queries.find((x) => x.id === 'requests')!;
      expect(req.expression).toBe(`SEARCH('{Stacks/prod,app} MetricName="Requests"', 'Sum', ${period})`);
      expect(req.label).toBe("${PROP('Dim.app')}");
      expect(q.queries.find((x) => x.id === 'lambdaP95')!.expression).toBe(`SEARCH('{AWS/Lambda,FunctionName} MetricName="Duration" stacks prod', 'p95', ${period})`);
      expect(q.queries.find((x) => x.id === 'ddbThrottles')!.expression).toContain('{AWS/DynamoDB,TableName,Operation} MetricName="ThrottledRequests" stacks prod');
      // Totals: one bucket for the whole range.
      const seconds = { '1h': 3600, '24h': 86400, '7d': 604800, '30d': 2592000 }[range];
      expect(q.queries.find((x) => x.id === 'tRequests')!.expression).toBe(`SEARCH('{Stacks/prod,app} MetricName="Requests"', 'Sum', ${seconds})`);
      expect(q.end.getTime() - q.start.getTime()).toBe(seconds * 1000);
    }
    expect(new Set(h.calls.metrics[0]!.queries.map((q) => q.id)).size).toBe(h.calls.metrics[0]!.queries.length);
    for (const q of h.calls.metrics[0]!.queries) expect(q.id).toMatch(/^[a-z][A-Za-z0-9_]*$/);
  });

  it('defaults to 24h and refuses other ranges', async () => {
    const h = setup();
    expect((await h.call('GET', '/admin/monitoring/metrics', { as: ADMIN })).body.range).toBe('24h');
    expect((await h.call('GET', '/admin/monitoring/metrics', { as: ADMIN, query: { range: '2y' } })).status).toBe(400);
    expect((await h.call('GET', '/admin/monitoring/metrics', { as: ADMIN, query: { range: 'toString' } })).status).toBe(400);
  });

  it('turns results into the health table and graphs', async () => {
    const t = Date.parse('2026-03-01T00:00:00Z');
    const h = setup({
      series: () => [
        { id: 'requests', label: 'club', timestamps: [t, t + 300_000], values: [4, 6] },
        { id: 'requests', label: 'nobody-yet', timestamps: [], values: [] },
        { id: 'unhandled', label: 'club', timestamps: [t], values: [1] },
        { id: 'lambdaErrors', label: 'stacks-prod-app-club-ApiHandler1A2B errors', timestamps: [t], values: [0] },
        { id: 'lambdaP95', label: 'stacks-prod-platform-ApiHandler9Z', timestamps: [t], values: [120] },
        // Staging's function matched by the same SEARCH words (`stacks`, `prod` in a slug): left out.
        { id: 'lambdaP95', label: 'stacks-test-app-prod-tools-ApiHandler1', timestamps: [t], values: [99] },
        { id: 'tRequests', label: 'club', timestamps: [t], values: [10] },
        { id: 'tServerErrors', label: 'club', timestamps: [t], values: [2] },
        { id: 'tUnhandled', label: 'club', timestamps: [t], values: [1] },
        { id: 'tP95', label: 'club', timestamps: [t, t + 1], values: [240.6, 2400] },
        { id: 'tRequests', label: 'platform', timestamps: [t], values: [3] },
        // An app no longer registered: not offered (the query route would refuse it).
        { id: 'tRequests', label: 'retired', timestamps: [t], values: [7] },
      ],
    });
    const res = await h.call('GET', '/admin/monitoring/metrics', { as: ADMIN });
    expect(res.body.env).toBe('prod');
    expect(res.body.consoleUrl).toContain('#dashboards/dashboard/stacks-prod');
    expect(res.body.logRetentionDays).toBe(30);
    expect(res.body.apps).toEqual([
      { app: 'platform', requests: 3, serverErrors: 0, unhandled: 0, clientErrors: 0, p95Ms: null },
      { app: 'club', requests: 10, serverErrors: 2, unhandled: 1, clientErrors: 0, p95Ms: 241 },
      { app: 'hello', requests: 0, serverErrors: 0, unhandled: 0, clientErrors: 0, p95Ms: null },
    ]);
    const g = Object.fromEntries(res.body.graphs.map((x: { id: string }) => [x.id, x]));
    expect(res.body.graphs.map((x: { id: string }) => x.id)).toEqual(['requests', 'serverErrors', 'clientErrors', 'p95', 'lambdaErrors', 'lambdaP95', 'ddbThrottles']);
    expect(g.requests.series).toEqual([{ label: 'club', app: 'club', points: [[t, 4], [t + 300_000, 6]] }]);
    expect(g.serverErrors.series).toEqual([{ label: 'club unhandled', app: 'club', points: [[t, 1]] }]);
    expect(g.lambdaErrors.series[0].app).toBe('club');
    expect(g.lambdaP95.series.map((s: { app: string }) => s.app)).toEqual(['platform']);
  });

  it('answers 424 (not a 5xx, which would count as a platform server error) when CloudWatch fails', async () => {
    const h = setup({ fail: true });
    const res = await h.call('GET', '/admin/monitoring/metrics', { as: ADMIN });
    expect(res.status).toBe(424);
    expect(res.body.error).toBe("CloudWatch didn't answer: AccessDeniedException");
  });
});

describe('POST /admin/monitoring/query', () => {
  it('runs exactly the saved query with the value put in', async () => {
    const h = setup();
    const cases: [Record<string, string>, string][] = [
      [{ query: 'latestErrors' }, queryText(SAVED_QUERIES.latestErrors.query)],
      [{ query: 'findByRef', ref: '3f9A2c1b' }, queryText(SAVED_QUERIES.findByRef.query).replace('PASTE-REF', '3f9A2c1b')],
      // API Gateway request ids are base64-like, so a ref can hold - _ + / =.
      [{ query: 'findByRef', ref: 'Ld-6z+/=' }, queryText(SAVED_QUERIES.findByRef.query).replace('PASTE-REF', 'Ld-6z+/=')],
      [{ query: 'userTrail', userId: 'u_abc123' }, queryText(SAVED_QUERIES.userTrail.query).replace('u_PASTE-USER-ID', 'u_abc123')],
      [{ query: 'appRequests', app: 'club' }, queryText(SAVED_QUERIES.appRequests.query).replace('APP-SLUG', 'club')],
    ];
    for (const [body, text] of cases) {
      const res = await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body });
      expect(res.status).toBe(200);
      expect(h.calls.queries.at(-1)!.queryString).toBe(text);
      expect(h.calls.queries.at(-1)!.logGroupNames).toEqual(['/stacks/prod/club/api', '/stacks/prod/platform/api']);
    }
  });

  it('adds an app filter to the other queries', async () => {
    const h = setup();
    await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'slowestRequests', app: 'platform' } });
    expect(h.calls.queries[0]!.queryString).toBe(
      ['fields @timestamp, message.app, message.method, message.route, message.status, message.durationMs, message.ref, message.userId', 'filter message.type = "request"', 'filter message.app = "platform"', 'sort message.durationMs desc', 'limit 50'].join('\n| '),
    );
    expect(buildQuery('browserErrors', { app: 'hello' })).toContain('| filter message.app = "hello"\n| sort');
  });

  it('refuses anything that is not a saved query with valid values, before calling CloudWatch', async () => {
    const h = setup();
    const bad: unknown[] = [
      {},
      { query: 'fields @message' },
      { query: 'toString' },
      { query: 'latestErrors', range: '90d' },
      { query: 'findByRef' },
      { query: 'findByRef', ref: '3f9a2c1' },
      { query: 'findByRef', ref: '3f9a2c1b" or 1=1' },
      { query: 'findByRef', ref: 'Ld-6zi"|' },
      { query: 'latestErrors', range: 'toString' },
      { query: 'findByRef', ref: 12345678 },
      { query: 'userTrail', userId: 'ana@example.com' },
      { query: 'userTrail', userId: 'u_x"| filter 1' },
      { query: 'appRequests' },
      { query: 'appRequests', app: 'other' },
      { query: 'latestErrors', app: 'club" or "1' },
      { query: 'latestErrors', ref: '3f9a2c1b' },
    ];
    for (const body of bad) expect((await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body })).status, JSON.stringify(body)).toBe(400);
    expect(h.calls.queries).toHaveLength(0);
  });

  it('never asks for logs older than the retention', async () => {
    const h = setup();
    await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'latestErrors', range: '30d' } });
    const q = h.calls.queries[0]!;
    expect(q.end.getTime() - q.start.getTime()).toBe(30 * 86_400_000);
    h.deps.config.envTag = 'test';
    await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'latestErrors', range: '30d' } });
    const t = h.calls.queries[1]!;
    expect(t.end.getTime() - t.start.getTime()).toBe(7 * 86_400_000);
  });

  it('renames fields and fills in names for user ids, without unknown or merged ids', async () => {
    const h = setup();
    await h.signIn('ana@test.dev', 'Ana Silva');
    const ana = await h.idOf('ana@test.dev');
    // u_merged00 was merged into Ana: shown by id only, never with the survivor's name.
    await h.store.put({ PK: 'USER#u_merged00', SK: 'PROFILE', id: 'u_merged00', email: 'old@test.dev', name: 'Old', createdAt: '2026-01-01', mergedInto: ana });
    h.deps.monitor = fakeMonitor({
      rows: [
        { '@timestamp': '2026-03-01 00:00:01.000', 'message.type': 'error', 'message.userId': ana, 'message.error.message': 'boom', 'message.error.stack': 'Error: boom\n  at x', 'message.error.name': 'Error', '@ptr': 'abc' },
        { '@timestamp': '2026-03-01 00:00:02.000', 'message.type': 'request', 'message.userId': 'u_gone00', 'message.status': '500' },
        { '@timestamp': '2026-03-01 00:00:03.000', 'message.type': 'request', 'message.userId': 'u_merged00', 'message.status': '200' },
      ],
    }).monitor;
    const res = await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'latestErrors' } });
    expect(res.body.status).toBe('Complete');
    expect(res.body.rows).toEqual([
      { ts: '2026-03-01 00:00:01.000', type: 'error', userId: ana, error: 'boom', stack: 'Error: boom\n  at x', errorName: 'Error' },
      { ts: '2026-03-01 00:00:02.000', type: 'request', userId: 'u_gone00', status: '500' },
      { ts: '2026-03-01 00:00:03.000', type: 'request', userId: 'u_merged00', status: '200' },
    ]);
    expect(res.body.people).toEqual({ [ana]: { name: 'Ana', email: 'ana@test.dev' } });
  });

  it('hands back the query id while it is still running, and GET polls it', async () => {
    const h = setup({ status: ['Running', 'Complete'], rows: [{ 'message.route': '/api/me' }] });
    h.monitor.waitMs = undefined; // the default: one look, then the client polls
    const start = await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'latestErrors' } });
    expect(start.body).toEqual({ queryId: QID, status: 'Running' });
    const poll = await h.call('GET', `/admin/monitoring/query/${QID}`, { as: ADMIN });
    expect(poll.body).toEqual({ queryId: QID, status: 'Complete', rows: [{ route: '/api/me' }], people: {}, limited: false });
    expect((await h.call('GET', '/admin/monitoring/query/not-an-id', { as: ADMIN })).status).toBe(400);
  });

  it('polls and stops only queries this portal started, for an hour', async () => {
    const h = setup({ status: ['Running'] });
    const other = '99999999-1111-2222-3333-444455556666';
    expect((await h.call('GET', `/admin/monitoring/query/${other}`, { as: ADMIN })).status).toBe(404);
    expect((await h.call('DELETE', `/admin/monitoring/query/${other}`, { as: ADMIN })).status).toBe(404);
    expect(h.calls.polls).toBe(0);
    await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'latestErrors' } });
    const stop = await h.call('DELETE', `/admin/monitoring/query/${QID}`, { as: ADMIN });
    expect(stop.status).toBe(200);
    expect(h.calls.stopped).toEqual([QID]);
    h.advance(3_601_000);
    expect((await h.call('GET', `/admin/monitoring/query/${QID}`, { as: ADMIN })).status).toBe(404);
  });

  it('keeps the latest trail lines and shows them oldest first, saying when the limit was reached', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ '@timestamp': `t${String(500 - i).padStart(3, '0')}`, 'message.userId': 'u_abc123' }));
    const h = setup({ rows });
    const res = await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'userTrail', userId: 'u_abc123' } });
    expect(h.calls.queries[0]!.queryString).toContain('sort @timestamp desc\n| limit 500');
    expect(res.body.rows[0].ts).toBe('t001');
    expect(res.body.rows.at(-1).ts).toBe('t500');
    expect(res.body.limited).toBe(true);
    const few = setup({ rows: rows.slice(0, 3) });
    expect((await few.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'userTrail', userId: 'u_abc123' } })).body.limited).toBe(false);
  });

  it('stops the query when its first look fails, since the page never gets its id', async () => {
    const h = setup();
    h.monitor.getQueryResults = async () => {
      throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    };
    expect((await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'latestErrors' } })).status).toBe(424);
    expect(h.calls.stopped).toEqual([QID]);
  });

  it('answers empty when every log group it knew has gone', async () => {
    const h = setup();
    h.monitor.startQuery = async () => null;
    const res = await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'latestErrors' } });
    expect(res.body).toMatchObject({ queryId: null, status: 'Complete', rows: [] });
  });

  it('answers empty when the environment has no log groups yet', async () => {
    const h = setup({ groups: [] });
    const res = await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'latestErrors' } });
    expect(res.body).toEqual({ queryId: null, status: 'Complete', rows: [], people: {}, limited: false });
    expect(h.calls.queries).toHaveLength(0);
  });

  it('answers 424 when CloudWatch fails', async () => {
    const h = setup({ fail: true });
    expect((await h.call('POST', '/admin/monitoring/query', { as: ADMIN, body: { query: 'latestErrors' } })).status).toBe(424);
  });
});

describe('appOfResource', () => {
  it('maps stack-prefixed names to apps, preferring the longest slug', () => {
    const slugs = ['sky', 'sky-shot', 'hello'];
    expect(appOfResource('prod', 'stacks-prod-platform-ApiHandler', slugs)).toBe('platform');
    expect(appOfResource('prod', 'stacks-prod-app-sky-shot-ApiHandler1', slugs)).toBe('sky-shot');
    expect(appOfResource('prod', 'stacks-prod-app-sky-ApiHandler1', slugs)).toBe('sky');
    expect(appOfResource('prod', 'stacks-test-app-hello-ApiHandler1', slugs)).toBeUndefined();
    expect(appOfResource('prod', 'stacks-prod-app-unknown-Fn', slugs)).toBeUndefined();
    // A 30-character slug cut short in a 64-character generated name.
    const long = 'a-very-long-app-slug-of-thirty';
    expect(appOfResource('prod', `stacks-prod-app-${long.slice(0, 20)}-ApiHandl-AbC123XyZ0123456789`, [...slugs, long])).toBe(long);
    expect(appOfResource('prod', 'stacks-prod-app-sk-Fn', slugs)).toBeUndefined();
    // A retired app's resource is not given to a registered slug that starts the same way.
    expect(appOfResource('prod', 'stacks-prod-app-hello-ApiHandler1A2B3C4D-AbCdEf', ['hello-world'])).toBeUndefined();
  });
});
