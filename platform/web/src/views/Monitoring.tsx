import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ErrorNote, Spinner } from '@stacks/web';
import { runQuery, type AppHealth, type LogRow, type MonitoringMetrics, type MonitoringRange, type QueryAnswer, type QueryRequest } from '../api';
import { usePortal } from '../portal';
import { LineChart } from './LineChart';

/*
 * The Monitoring page (#81, docs/specs/81-admin-monitoring.md), platform admins only: the
 * environment's CloudWatch metrics and saved Logs Insights queries, read through the Platform API.
 */

const RANGES: MonitoringRange[] = ['1h', '24h', '7d', '30d'];
const RANGE_MS: Record<MonitoringRange, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
const PALETTE = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
export const AUTO_REFRESH_MS = 60_000;
const REF = /^[A-Za-z0-9_+/=-]{8}$/;
const USER_ID = /^u_[A-Za-z0-9_-]{1,64}$/;

type People = Record<string, { name: string; email: string }>;
type Lookup = { kind: 'ref'; ref: string } | { kind: 'user'; userId: string };

/** Logs Insights times are UTC `2026-11-21 17:42:42.123`. */
const parseTs = (ts?: string) => (ts ? Date.parse(`${ts.replace(' ', 'T')}${/[Zz+]/.test(ts.slice(10)) ? '' : 'Z'}`) : NaN);
const when = (ts?: string) => {
  const t = parseTs(ts);
  return Number.isNaN(t) ? (ts ?? '') : new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
const envLabel = (env: string) => (env === 'prod' ? 'production' : env === 'test' ? 'staging' : env);

export function Monitoring() {
  const { me } = usePortal();
  if (!me?.user.isPlatformAdmin)
    return (
      <section>
        <h1>Monitoring</h1>
        <p className="error">Platform admins only</p>
      </section>
    );
  return <MonitoringPage />;
}

function MonitoringPage() {
  const { api } = usePortal();
  const [range, setRange] = useState<MonitoringRange>('24h');
  const [app, setApp] = useState('');
  const [auto, setAuto] = useState(false);
  const [tick, setTick] = useState(0);
  const [metrics, setMetrics] = useState<MonitoringMetrics | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const lookupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .monitoringMetrics(range)
      .then((m) => {
        if (!live) return;
        setMetrics(m);
        setError(null);
        setUpdated(new Date());
      })
      .catch((err: Error) => live && setError(err))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [api, range, tick]);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') setTick((t) => t + 1);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [auto]);

  const open = (l: Lookup) => {
    setLookup(l);
    setTimeout(() => lookupRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), 0);
  };
  const apps = metrics?.apps.map((a) => a.app) ?? [];
  const colorOf = (a: string | null, i: number) => (a && apps.includes(a) ? PALETTE[apps.indexOf(a) % PALETTE.length]! : PALETTE[i % PALETTE.length]!);
  const links = { onRef: (ref: string) => open({ kind: 'ref', ref }), onUser: (userId: string) => open({ kind: 'user', userId }) };
  const shared = { range, tick, ...links };

  return (
    <section className="monitoring">
      <div className="mon-head">
        <div>
          <h1>
            Monitoring {metrics && <span className="env-pill">{envLabel(metrics.env)}</span>}
          </h1>
          <p className="muted">How the platform and each app are doing. Nothing here alerts you; look when someone says something broke. Logs hold user ids only; names are filled in here.</p>
        </div>
        {metrics && (
          <a className="button secondary small" href={metrics.consoleUrl} target="_blank" rel="noreferrer">
            Open in CloudWatch ↗
          </a>
        )}
      </div>

      <div className="mon-toolbar" role="toolbar" aria-label="Monitoring controls">
        <div className="chips tight" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
        <select aria-label="App" value={app} onChange={(e) => setApp(e.target.value)}>
          <option value="">All apps</option>
          {apps.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button type="button" className="button secondary small" onClick={() => setTick((t) => t + 1)}>
          Refresh
        </button>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Refresh every 60s
        </label>
        <span className="grow" />
        <span className="small muted" aria-live="polite">
          {loading ? 'Loading…' : updated ? `Updated ${updated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}
        </span>
      </div>

      <LookupCard lookup={lookup} onLookup={open} range={range} panelRef={lookupRef} {...links} />

      <ErrorNote error={error} className="error" />
      {!metrics && !error && <Spinner />}
      {metrics && (
        <>
          <h2>Health</h2>
          <HealthTable apps={metrics.apps} selected={app} onSelect={(a) => setApp(a === app ? '' : a)} />
          <p className="small muted mon-note">Click an app to show only it below. Red: a server error in the range. Amber: browser errors, or p95 over 1,500 ms.</p>

          <h2>Requests and errors per app</h2>
          <Graphs metrics={metrics} ids={['requests', 'serverErrors', 'clientErrors', 'p95']} app={app} colorOf={colorOf} className="mon-graphs" />
          <h2>AWS: Lambda and DynamoDB</h2>
          <Graphs metrics={metrics} ids={['lambdaErrors', 'lambdaP95', 'ddbThrottles']} app={app} colorOf={colorOf} className="mon-graphs three" aws />
        </>
      )}

      {app && (
        <>
          <h2>Requests for {app}</h2>
          <QueryTable request={{ query: 'appRequests', app }} {...shared} />
        </>
      )}
      <h2>Latest errors</h2>
      <QueryTable request={{ query: 'latestErrors', app: app || undefined }} {...shared} />
      <h2>Browser errors</h2>
      <QueryTable request={{ query: 'browserErrors', app: app || undefined }} {...shared} />
      <h2>Slowest requests</h2>
      <QueryTable request={{ query: 'slowestRequests', app: app || undefined }} {...shared} />
      {metrics && (
        <p className="small muted mon-note">
          {RANGE_MS[range] > metrics.logRetentionDays * 86_400_000
            ? `Tables cover the last ${metrics.logRetentionDays} days: logs here are kept that long. Graphs go back further.`
            : 'Each table shows the first rows of its saved query (50 to 200): errors newest first, slowest requests slowest first.'}
        </p>
      )}
    </section>
  );
}

export function healthOf(a: AppHealth): { tone: 'bad' | 'warn' | 'ok'; label: string } {
  if (a.serverErrors + a.unhandled > 0) return { tone: 'bad', label: 'Server errors' };
  if (a.clientErrors > 0) return { tone: 'warn', label: 'Browser errors' };
  if ((a.p95Ms ?? 0) > 1500) return { tone: 'warn', label: 'Slow' };
  return { tone: 'ok', label: 'Healthy' };
}

function HealthTable({ apps, selected, onSelect }: { apps: AppHealth[]; selected: string; onSelect(app: string): void }) {
  return (
    <div className="grid-scroll">
      <table className="grid mon-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Health</span>
            </th>
            <th scope="col">App</th>
            <th scope="col" className="num">
              Requests
            </th>
            <th scope="col" className="num">
              Server errors
            </th>
            <th scope="col" className="num">
              Browser errors
            </th>
            <th scope="col" className="num">
              p95 ms
            </th>
          </tr>
        </thead>
        <tbody>
          {apps.map((a) => {
            const h = healthOf(a);
            // Every unhandled error is also a 500 request line, so serverErrors already counts it.
            const server = a.serverErrors;
            return (
              <tr key={a.app} className={`clickable${selected === a.app ? ' selected' : ''}`} onClick={() => onSelect(a.app)}>
                <td>
                  <span className={`dot ${h.tone}`} title={h.label} aria-label={h.label} role="img" />
                </td>
                <td>
                  <button type="button" className="linkish strong" aria-pressed={selected === a.app} onClick={(e) => (e.stopPropagation(), onSelect(a.app))}>
                    {a.app}
                  </button>
                </td>
                <td className="num">{a.requests.toLocaleString()}</td>
                <td className={`num${server ? ' bad' : ''}`} title={a.unhandled ? `${a.unhandled} unhandled` : undefined}>
                  {server}
                </td>
                <td className="num">{a.clientErrors}</td>
                <td className="num">{a.p95Ms ?? '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Graphs({ metrics, ids, app, colorOf, className, aws = false }: { metrics: MonitoringMetrics; ids: string[]; app: string; colorOf(app: string | null, i: number): string; className: string; aws?: boolean }) {
  const from = Date.parse(metrics.from);
  const to = Date.parse(metrics.to);
  return (
    <div className={className}>
      {ids.map((id) => {
        const g = metrics.graphs.find((x) => x.id === id);
        if (!g) return null;
        const series = g.series
          .filter((s) => !app || s.app === app)
          // App graphs: one color per app (the same in every graph), unhandled dashed. AWS graphs can
          // hold several lines per app (functions, errors and throttles): a color per line, throttles dashed.
          .map((s, i) => ({
            label: aws ? shortResource(s.label, metrics.env) : s.label,
            color: aws ? PALETTE[i % PALETTE.length]! : colorOf(s.app, i),
            points: s.points,
            dashed: s.label.endsWith(' unhandled') || s.label.endsWith(' throttles'),
          }));
        return <LineChart key={id} title={g.title} unit={g.unit === 'ms' ? 'ms' : undefined} series={series} from={from} to={to} periodMs={metrics.periodSeconds * 1000} />;
      })}
    </div>
  );
}

/**
 * `stacks-prod-app-hello-ApiHandler5D2B1F4C-AbCdEf123 errors` → `hello-ApiHandler errors`: drops
 * the environment prefix and the hashes CloudFormation adds to generated names.
 */
export function shortResource(label: string, env: string): string {
  const [name = '', ...rest] = label.split(' ');
  const short = name
    .replace(new RegExp(`^stacks-${env}-(app-)?`), '')
    .replace(/-[A-Za-z0-9]{10,}$/, '')
    .replace(/([A-Za-z])[0-9A-F]{8}$/, '$1');
  return [short, ...rest].join(' ');
}

/* ---------- log tables ---------- */

function useQuery(request: QueryRequest | null, deps: unknown[]) {
  const { api } = usePortal();
  const [state, setState] = useState<{ answer: (QueryAnswer & { rows: LogRow[]; people: People }) | null; error: Error | null; loading: boolean }>({ answer: null, error: null, loading: !!request });
  useEffect(() => {
    if (!request) return;
    // Aborting stops the polling when the range, app or page changes (the query itself is short).
    const abort = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    runQuery(api, request, { signal: abort.signal })
      .then((answer) => !abort.signal.aborted && setState({ answer, error: null, loading: false }))
      .catch((error: Error) => !abort.signal.aborted && setState({ answer: null, error, loading: false }));
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, ...deps]);
  return state;
}

interface LinkProps {
  onRef(ref: string): void;
  onUser(userId: string): void;
}

function Person({ id, people, onUser }: { id?: string; people: People; onUser(id: string): void }) {
  if (!id) return <span className="muted">signed out</span>;
  const p = people[id];
  return (
    <>
      <button type="button" className="linkish" onClick={() => onUser(id)} title={`Show ${p?.name ?? id}'s trail`}>
        {p ? p.name : id}
      </button>
      {p && <span className="muted small block mono">{id}</span>}
    </>
  );
}

const Ref = ({ value, onRef }: { value?: string; onRef(ref: string): void }) =>
  value ? (
    <button type="button" className="linkish mono" onClick={() => onRef(value)} title="Find by ref">
      {value}
    </button>
  ) : null;

function Kind({ type }: { type?: string }) {
  const label = type === 'client-error' ? 'browser' : type === 'error' ? 'server' : (type ?? '');
  const tone = type === 'client-error' ? 'warn' : type === 'error' ? 'bad' : type === 'request' ? 'info' : 'plain';
  return <span className={`pill ${tone}`}>{label}</span>;
}

const Status = ({ value }: { value?: string }) => <span className={Number(value) >= 500 ? 'bad' : undefined}>{value}</span>;

interface Column {
  head: string;
  num?: boolean;
  cell(r: LogRow, people: People, links: LinkProps): ReactNode;
}
const col = {
  when: { head: 'When', cell: (r) => <span className="nowrap">{when(r.ts)}</span> } as Column,
  app: { head: 'App', cell: (r) => r.app } as Column,
  kind: { head: 'Kind', cell: (r) => <Kind type={r.type} /> } as Column,
  ref: { head: 'Ref', cell: (r, _p, l) => <Ref value={r.ref} onRef={l.onRef} /> } as Column,
  route: { head: 'Route', cell: (r) => <code>{r.route ?? r.path}</code> } as Column,
  who: { head: 'Who', cell: (r, p, l) => <Person id={r.userId} people={p} onUser={l.onUser} /> } as Column,
  message: { head: 'Message', cell: (r) => r.error ?? r.message } as Column,
  method: { head: 'Method', cell: (r) => r.method } as Column,
  status: { head: 'Status', num: true, cell: (r) => <Status value={r.status} /> } as Column,
  ms: { head: 'ms', num: true, cell: (r) => (r.durationMs ? Number(r.durationMs).toLocaleString() : '') } as Column,
  page: { head: 'Page', cell: (r) => <code>{r.path}</code> } as Column,
  source: { head: 'Source', cell: (r) => r.source } as Column,
  build: { head: 'Build', cell: (r) => <code>{r.clientBuild?.slice(0, 7)}</code> } as Column,
};
const COLUMNS: Record<string, Column[]> = {
  latestErrors: [col.when, col.kind, col.app, col.ref, col.route, col.who, col.message],
  browserErrors: [col.when, col.app, col.who, col.page, col.source, col.message, col.build],
  slowestRequests: [col.when, col.app, col.method, col.route, col.status, col.ms, col.ref, col.who],
  appRequests: [col.when, col.method, col.route, col.status, col.ms, col.ref, col.who],
};
const EMPTY: Record<string, string> = {
  latestErrors: 'No errors in this range.',
  browserErrors: 'No browser errors in this range.',
  slowestRequests: 'No requests in this range.',
  appRequests: 'No requests in this range.',
};

function QueryTable({ request, range, tick, ...links }: { request: Omit<QueryRequest, 'range'>; range: MonitoringRange; tick: number } & LinkProps) {
  const { answer, error, loading } = useQuery({ ...request, range }, [request.query, request.app, range, tick]);
  const columns = COLUMNS[request.query]!;
  const [open, setOpen] = useState<Set<number>>(new Set());
  useEffect(() => setOpen(new Set()), [answer]);
  if (error) return <ErrorNote error={error} className="error" />;
  if (!answer) return <Spinner />;
  const toggle = (i: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(i)) next.add(i);
      return next;
    });
  return (
    <div className={`grid-scroll${loading ? ' stale' : ''}`} aria-busy={loading}>
      <table className="grid mon-table" aria-label={request.query}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.head} scope="col" className={c.num ? 'num' : undefined}>
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {answer.rows.map((r, i) => (
            <Fragment key={i}>
              <tr
                className={r.stack ? 'clickable' : undefined}
                onClick={r.stack ? (e) => !(e.target as HTMLElement).closest('button') && toggle(i) : undefined}
                aria-expanded={r.stack ? open.has(i) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.head} className={c.num ? 'num' : undefined}>
                    {c.cell(r, answer.people, links)}
                  </td>
                ))}
              </tr>
              {r.stack && open.has(i) && (
                <tr className="detail">
                  <td colSpan={columns.length}>
                    <pre className="mon-stack">{r.stack}</pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {!answer.rows.length && <p className="muted pad">{EMPTY[request.query]}</p>}
    </div>
  );
}

/* ---------- look up ---------- */

function LookupCard({ lookup, onLookup, range, panelRef, ...links }: { lookup: Lookup | null; onLookup(l: Lookup): void; range: MonitoringRange; panelRef: React.RefObject<HTMLDivElement> } & LinkProps) {
  const [ref, setRef] = useState('');
  const [user, setUser] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  useEffect(() => {
    if (lookup?.kind === 'ref') setRef(lookup.ref);
    if (lookup?.kind === 'user') setUser(lookup.userId);
    setInvalid(null);
  }, [lookup]);
  const submitRef = (e: FormEvent) => {
    e.preventDefault();
    const v = ref.trim();
    if (!REF.test(v)) return setInvalid('A ref is 8 characters, like 3f9a2c1b or Ld-6ziNZ. Paste it rather than retyping: refs are case-sensitive.');
    onLookup({ kind: 'ref', ref: v });
  };
  const submitUser = (e: FormEvent) => {
    e.preventDefault();
    const v = user.trim();
    if (!USER_ID.test(v)) return setInvalid("A user id starts with u_. Logs hold ids, not names or emails; the access grid shows each person's id.");
    onLookup({ kind: 'user', userId: v });
  };
  return (
    <div className="card mon-lookup">
      <h3>Look up</h3>
      <div className="mon-lookup-forms">
        <form onSubmit={submitRef}>
          <label>
            Someone sent you a ref
            <input className="mono" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. 3f9a2c1b" autoComplete="off" spellCheck={false} />
          </label>
          <button className="button small" type="submit">
            Find by ref
          </button>
        </form>
        <form onSubmit={submitUser}>
          <label>
            Follow one person
            <input className="mono" value={user} onChange={(e) => setUser(e.target.value)} placeholder="u_… id" autoComplete="off" spellCheck={false} />
          </label>
          <button className="button secondary small" type="submit">
            Show trail
          </button>
        </form>
      </div>
      {invalid && <p className="error">{invalid}</p>}
      <div ref={panelRef}>{lookup && !invalid && <LookupResult key={`${lookup.kind}:${lookup.kind === 'ref' ? lookup.ref : lookup.userId}:${range}`} lookup={lookup} range={range} {...links} />}</div>
    </div>
  );
}

function LookupResult({ lookup, range, ...links }: { lookup: Lookup; range: MonitoringRange } & LinkProps) {
  const request: QueryRequest = lookup.kind === 'ref' ? { query: 'findByRef', ref: lookup.ref, range } : { query: 'userTrail', userId: lookup.userId, range };
  const { answer, error, loading } = useQuery(request, [lookup.kind, lookup.kind === 'ref' ? lookup.ref : lookup.userId, range]);
  let heading: ReactNode;
  if (lookup.kind === 'ref') heading = <>Ref <code>{lookup.ref}</code></>;
  else {
    const p = answer?.people[lookup.userId];
    heading = (
      <>
        {p ? `${p.name}'s trail` : 'Trail'} {p && <span className="muted small">{p.email}</span>} <span className="muted small mono">{lookup.userId}</span>
      </>
    );
  }
  return (
    <div className="mon-result">
      <h3>{heading}</h3>
      {error && <ErrorNote error={error} className="error" />}
      {loading && <Spinner />}
      {answer && !loading && !answer.rows.length && (
        <p className="muted">{lookup.kind === 'ref' ? `No lines with this ref in the last ${range}. Try a longer range.` : `Nothing from this person in the last ${range}.`}</p>
      )}
      {answer && !loading && answer.limited && (
        <p className="small muted">{lookup.kind === 'user' ? `The latest ${answer.rows.length} lines; older ones are left out.` : `The first ${answer.rows.length} lines.`}</p>
      )}
      {answer && !loading && !!answer.rows.length && (
        <div className="grid-scroll">
          <table className="grid mon-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">App</th>
                <th scope="col">Type</th>
                <th scope="col">What</th>
                {lookup.kind === 'user' ? <th scope="col">Ref</th> : <th scope="col">Who</th>}
              </tr>
            </thead>
            <tbody>
              {answer.rows.map((r, i) => (
                <tr key={i}>
                  <td className="nowrap">{when(r.ts)}</td>
                  <td>{r.app}</td>
                  <td>
                    <Kind type={r.type} />
                  </td>
                  <td className="mon-what">
                    {r.route && (
                      <code>
                        {r.method} {r.route}
                      </code>
                    )}
                    {r.status && (
                      <>
                        {' → '}
                        <Status value={r.status} />
                        {r.durationMs && ` in ${r.durationMs} ms`}
                      </>
                    )}
                    {(r.error || r.message) && <span className="block">{r.error ?? r.message}</span>}
                    {r.stack && <pre className="mon-stack">{r.stack}</pre>}
                  </td>
                  <td>{lookup.kind === 'user' ? <Ref value={r.ref} onRef={links.onRef} /> : <Person id={r.userId} people={answer.people} onUser={links.onUser} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
