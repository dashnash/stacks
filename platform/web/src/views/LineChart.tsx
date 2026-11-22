import { useRef, useState, useSyncExternalStore } from 'react';

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

/**
 * The time under the pointer, shared by charts so hovering one draws the line on all of them. A small
 * store, not React state on the page: moving the mouse then re-renders the charts only.
 */
export interface HoverSync {
  get(): number | null;
  set(t: number | null): void;
  subscribe(listener: () => void): () => void;
}
export function createHoverSync(): HoverSync {
  let value: number | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(t) {
      if (t === value) return;
      value = t;
      listeners.forEach((l) => l());
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** A drag narrower than this (in chart units, ~1% of the width) is a click, not a zoom. */
const MIN_DRAG = 6;

const short = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toFixed(1)}`);

/**
 * A small multi-line chart drawn in SVG (no chart library). Buckets CloudWatch left out are gaps,
 * not zeros. Hovering shows each line's value at that time, on every chart sharing `sync`; with
 * `onZoom`, dragging across the chart picks a time window.
 */
export function LineChart({ title, unit, series, from, to, periodMs, sync, onZoom }: { title: string; unit?: string; series: ChartSeries[]; from: number; to: number; periodMs: number; sync?: HoverSync; onZoom?(from: number, to: number): void }) {
  const svg = useRef<SVGSVGElement>(null);
  const [own] = useState(createHoverSync);
  const store = sync ?? own;
  const shared = useSyncExternalStore(store.subscribe, store.get);
  const hover = shared !== null && shared >= from && shared <= to ? shared : null;
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
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

  const timeAt = (e: React.PointerEvent) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || !box.width) return null;
    const x = ((e.clientX - box.left) / box.width) * W;
    return Math.min(to, Math.max(from, from + ((x - L) / (W - L - R)) * span));
  };
  const onMove = (e: React.PointerEvent) => {
    const t = timeAt(e);
    if (t === null) return;
    store.set(t);
    if (drag) setDrag({ a: drag.a, b: t });
  };
  const onDown = (e: React.PointerEvent) => {
    if (!onZoom || e.button !== 0) return;
    const t = timeAt(e);
    if (t === null) return;
    setDrag({ a: t, b: t });
    // Keep getting moves (and the release) when the pointer leaves the chart mid-drag.
    svg.current?.setPointerCapture?.(e.pointerId);
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag) return;
    if (onZoom && Math.abs(sx(drag.b) - sx(drag.a)) >= MIN_DRAG) onZoom(Math.min(drag.a, drag.b), Math.max(drag.a, drag.b));
    setDrag(null);
    // Released outside the chart: the leave already happened during the capture.
    const box = svg.current?.getBoundingClientRect();
    if (box && (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom)) store.set(null);
  };

  return (
    <figure className="card chart">
      <figcaption className="chart-title">{title}</figcaption>
      {series.length ? (
        <svg
          ref={svg}
          className={onZoom ? 'zoomable' : undefined}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={title}
          onPointerMove={onMove}
          onPointerDown={onDown}
          onPointerUp={onUp}
          onPointerCancel={() => setDrag(null)}
          onPointerLeave={() => !drag && store.set(null)}
        >
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
          {series.map((s, i) => (
            <g key={i}>
              <path d={path(s.points)} fill="none" stroke={s.color} strokeWidth={1.6} strokeLinejoin="round" strokeDasharray={s.dashed ? '4 3' : undefined} />
              {lonely(s.points).map(([t, v]) => (
                <circle key={t} className="chart-dot" cx={sx(t)} cy={sy(v)} r={2.5} fill={s.color} />
              ))}
            </g>
          ))}
          {drag && <rect className="chart-select" data-testid="chart-select" x={sx(Math.min(drag.a, drag.b))} y={T} width={Math.abs(sx(drag.b) - sx(drag.a))} height={H - T - B} />}
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
        {series.map((s, i) => (
          <span key={i}>
            <span className={`swatch${s.dashed ? ' dashed' : ''}`} style={s.dashed ? { borderColor: s.color } : { background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </figure>
  );
}
