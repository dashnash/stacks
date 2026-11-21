/**
 * Shot telemetry: your shots (the owner: everyone's), filterable by config and look, paged, and
 * downloadable as CSV or JSON for offline analysis (built in the browser from the API's pages).
 */
import { useState } from 'react';
import { ErrorNote, Spinner, formatDateTime, useApi, useAsync } from '@stacks/web';
import type { TelemetryShot } from '../../api/telemetry';
import { THEME_TAGS } from '../../game/themes';
import type { Tuning } from '../../game/tuning';

interface Page {
  shots: TelemetryShot[];
  configs: Record<string, Tuning>;
  next: string | null;
  everyone: boolean;
}

const CSV_COLUMNS = ['at', 'shooterId', 'roomId', 'mode', 'configId', 'trigger', 'hit', 'missDist', 'rewindMs', 'gunRtt', 'screenRtt', 'shotToPixel', 'windowSamples', 'theme'] as const;

export function toCsv(shots: TelemetryShot[]): string {
  const rows = shots.map((s) =>
    [s.at, s.shooterId, s.roomId, s.mode, s.configId, s.trigger, s.hit, s.missDist, s.rewindMs, s.latency.gunRtt, s.latency.screenRtt, s.latency.shotToPixel, s.window.length, s.theme ?? ''].map((v) => {
      const text = String(v);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }),
  );
  return [CSV_COLUMNS.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

function download(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Telemetry() {
  const api = useApi();
  const [configId, setConfigId] = useState('');
  const [theme, setTheme] = useState('');
  const [pages, setPages] = useState<Page[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const query = (from?: string) => {
    const q = new URLSearchParams();
    if (configId) q.set('configId', configId);
    if (theme) q.set('theme', theme);
    if (from) q.set('from', from);
    return `/telemetry${q.size ? `?${q}` : ''}`;
  };
  const first = useAsync(() => api.get<Page>(query()), [configId, theme]);
  const all = first.data ? [first.data, ...pages] : [];
  const shots = all.flatMap((p) => p.shots);
  const configs = Object.assign({}, ...all.map((p) => p.configs)) as Record<string, Tuning>;
  const next = all.at(-1)?.next ?? null;

  async function more() {
    if (!next) return;
    setBusy(true);
    try {
      const page = await api.get<Page>(query(next));
      setPages((p) => [...p, page]);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  /** Everything matching, every page, for the download. */
  async function everything(): Promise<{ shots: TelemetryShot[]; configs: Record<string, Tuning> }> {
    const out: TelemetryShot[] = [];
    const cfg: Record<string, Tuning> = {};
    let from: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await api.get<Page>(`${query(from)}${from || configId || theme ? '&' : '?'}limit=1000`);
      out.push(...page.shots);
      Object.assign(cfg, page.configs);
      if (!page.next) break;
      from = page.next;
    }
    return { shots: out, configs: cfg };
  }

  async function save(kind: 'csv' | 'json') {
    setBusy(true);
    setError(null);
    try {
      const data = await everything();
      if (kind === 'csv') download('sky-shot-shots.csv', 'text/csv', toCsv(data.shots));
      else download('sky-shot-shots.json', 'application/json', JSON.stringify(data, null, 1));
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  const hits = shots.filter((s) => s.hit).length;
  return (
    <section className="telemetry panel">
      <div className="row spread">
        <h2>{first.data?.everyone ? "Everyone's shots" : 'Your shots'}</h2>
        <a href="#/" className="link">
          ← Title
        </a>
      </div>
      <p className="muted small">Kept 30 days. Each shot has its motion from 300 ms before to 100 ms after, and the tuning it was fired with.</p>
      <div className="row">
        <label htmlFor="config-filter">Config</label>
        <select id="config-filter" value={configId} onChange={(e) => (setPages([]), setConfigId(e.target.value))}>
          <option value="">All</option>
          {Object.keys(configs).map((id) => (
            <option key={id}>{id}</option>
          ))}
          {configId && !configs[configId] && <option>{configId}</option>}
        </select>
        <label htmlFor="theme-filter">Look</label>
        <select id="theme-filter" value={theme} onChange={(e) => (setPages([]), setTheme(e.target.value))}>
          <option value="">All</option>
          {[...new Set([...THEME_TAGS, ...shots.map((s) => s.theme).filter((t): t is string => !!t), ...(theme ? [theme] : [])])].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <button type="button" disabled={busy || !shots.length} onClick={() => void save('csv')}>
          Download CSV
        </button>
        <button type="button" disabled={busy || !shots.length} onClick={() => void save('json')}>
          Download JSON
        </button>
      </div>
      <ErrorNote error={first.error ?? error} className="error" />
      {first.loading && !first.data ? (
        <Spinner />
      ) : !shots.length ? (
        <p className="muted">No shots yet. Play a game and press Done to save it.</p>
      ) : (
        <>
          <p>
            {shots.length} shots shown · {Math.round((hits / shots.length) * 100)} % hits
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  {first.data?.everyone && <th>Shooter</th>}
                  <th>Mode</th>
                  <th>Config</th>
                  <th>Trigger</th>
                  <th>Hit</th>
                  <th>Miss by</th>
                  <th>Rewind</th>
                  <th>Shot → pixel</th>
                  <th>Look</th>
                </tr>
              </thead>
              <tbody>
                {shots.map((s) => (
                  <tr key={s.cursor}>
                    <td>{formatDateTime(s.at)}</td>
                    {first.data?.everyone && <td title={s.shooterId}>{s.shooterName ?? s.shooterId}</td>}
                    <td>{s.mode}</td>
                    <td>
                      <code>{s.configId}</code>
                    </td>
                    <td>{s.trigger}</td>
                    <td>{s.hit ? '✔' : '✘'}</td>
                    <td>{s.hit ? '-' : s.missDist.toFixed(3)}</td>
                    <td>{s.rewindMs} ms</td>
                    <td>{s.latency.shotToPixel} ms</td>
                    <td>{s.theme ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {next && (
            <button type="button" disabled={busy} onClick={() => void more()}>
              Show more
            </button>
          )}
        </>
      )}
    </section>
  );
}
