import { useRef, useState } from 'react';

export interface ChartSeries {
  label: string;
  color: string;
  points: [number, number][];
  /** Drawn dashed: a second line of the same app (e.g. unhandled next to 5xx). */
  dashed?: boolean;
}

const W = 520;
const H = 170;
const L = 40;
const R = 8;
const T = 8;
const B = 22;

/** A round number at or above `v` (1, 2 or 5 times a power of ten). */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const m = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / m;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * m;
}

const short = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toFixed(1)}`);

/**
 * A small multi-line chart drawn in SVG (no chart library). Buckets CloudWatch left out are gaps,
 * not zeros. Hovering shows each line's value at that time.
 */
export function LineChart({ title, unit, series, from, to, periodMs }: { title: string; unit?: string; series: ChartSeries[]; from: number; to: number; periodMs: number }) {
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const span = Math.max(1, to - from);
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p[1]))));
  const sx = (t: number) => L + ((t - from) / span) * (W - L - R);
  const sy = (v: number) => T + (1 - v / max) * (H - T - B);
  const day = span > 36 * 3_600_000;
  const xLabel = (t: number) => new Date(t).toLocaleString(undefined, day ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' });
  const path = (pts: [number, number][]) => {
    let d = '';
    let prev: number | null = null;
    for (const [t, v] of pts) {
      d += `${prev !== null && t - prev <= periodMs * 1.5 ? 'L' : 'M'}${sx(t).toFixed(1)},${sy(v).toFixed(1)}`;
      prev = t;
    }
    return d;
  };
  /** Points with no joined neighbour: a path draws nothing for them, so they get a dot. Error
   * metrics exist only for minutes that had an error, so a lone point is the usual case there. */
  const lonely = (pts: [number, number][]) =>
    pts.filter(([t], i) => !(i > 0 && t - pts[i - 1]![0] <= periodMs * 1.5) && !(i < pts.length - 1 && pts[i + 1]![0] - t <= periodMs * 1.5));
  const nearest = (pts: [number, number][], t: number) => {
    let best: [number, number] | undefined;
    for (const p of pts) if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    return best && Math.abs(best[0] - t) <= periodMs ? best[1] : null;
  };

  const onMove = (e: React.PointerEvent) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || !box.width) return;
    const x = ((e.clientX - box.left) / box.width) * W;
    setHover(Math.min(to, Math.max(from, from + ((x - L) / (W - L - R)) * span)));
  };

  return (
    <figure className="card chart">
      <figcaption className="chart-title">{title}</figcaption>
      {series.length ? (
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {[0, max / 2, max].map((v) => (
            <g key={v}>
              <line className="chart-grid" x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} />
              <text className="chart-axis" x={L - 6} y={sy(v) + 3} textAnchor="end">
                {short(v)}
              </text>
            </g>
          ))}
          {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
            <text key={f} className="chart-axis" x={sx(from + f * span)} y={H - 6} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>
              {xLabel(from + f * span)}
            </text>
          ))}
          {series.map((s) => (
            <g key={s.label}>
              <path d={path(s.points)} fill="none" stroke={s.color} strokeWidth={1.6} strokeLinejoin="round" strokeDasharray={s.dashed ? '4 3' : undefined} />
              {lonely(s.points).map(([t, v]) => (
                <circle key={t} className="chart-dot" cx={sx(t)} cy={sy(v)} r={2.5} fill={s.color} />
              ))}
            </g>
          ))}
          {hover !== null && <line className="chart-hover" x1={sx(hover)} x2={sx(hover)} y1={T} y2={H - B} />}
          <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" />
        </svg>
      ) : (
        <p className="muted pad">No data in this range</p>
      )}
      <div className="chart-readout" aria-live="polite">
        {hover !== null &&
          `${new Date(hover).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${series
            .map((s) => {
              const v = nearest(s.points, hover);
              return `${s.label} ${v === null ? '–' : Math.round(v * 10) / 10}`;
            })
            .join(' · ')}${unit ? ` ${unit}` : ''}`}
      </div>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.label}>
            <span className={`swatch${s.dashed ? ' dashed' : ''}`} style={s.dashed ? { borderColor: s.color } : { background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </figure>
  );
}
