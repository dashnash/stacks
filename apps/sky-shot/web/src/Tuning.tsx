/**
 * The tuning panel (toggle with T): every knob of the aim mapping and trigger, sent to the server as
 * `{ tune }` on change, plus the diagnostics: latency, live motion graphs, accuracy per config and
 * the raw/mapped overlay switch. Ported in spirit from Gyro Gym's Lab (graphs as app code).
 */
import { useId } from 'react';
import type { ConfigStats, GameMode, RangeKind, Snapshot } from '../../game/protocol';
import { KNOBS, type Knob, type Tuning } from '../../game/tuning';
import { LookSelect } from './Look';

/** The last 5 s of motion from snapshots, for the graphs. */
export interface MotionPoint {
  at: number;
  yaw: number;
  pitch: number;
  roll: number;
  r: [number, number, number];
  a: number;
}
export const GRAPH_MS = 5000;

const W = 300;
const H = 64;
const LINE = ['#c6ff3d', '#4dd0ff', '#ff6b9a'];

/** Up to three values over the last 5 s, newest at the right, drawn from −range to +range (or 0 to range). */
export function Graph({ label, points, pick, range, unit, threshold, positive }: { label: string; points: MotionPoint[]; pick: (p: MotionPoint) => number[]; range: number; unit: string; threshold?: number; positive?: boolean }) {
  const end = points[points.length - 1]?.at ?? 0;
  const lines: string[][] = [[], [], []];
  const yOf = (v: number) => (positive ? H - 2 - (Math.min(range, Math.max(0, v)) / range) * (H - 4) : H / 2 - (Math.max(-range, Math.min(range, v)) / range) * (H / 2 - 2));
  for (const p of points) {
    const x = W - ((end - p.at) / GRAPH_MS) * W;
    pick(p).forEach((v, k) => lines[k]!.push(`${x.toFixed(1)},${yOf(v).toFixed(1)}`));
  }
  return (
    <figure className="graph">
      <figcaption>
        {label} <span className="muted">{positive ? `0-${range}` : `±${range}`} {unit}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}, last 5 seconds`}>
        {!positive && <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="axis" />}
        {threshold !== undefined && <line x1="0" x2={W} y1={yOf(threshold)} y2={yOf(threshold)} className="threshold" />}
        {lines.map((pts, k) => (pts.length > 1 ? <polyline key={k} points={pts.join(' ')} fill="none" stroke={LINE[k]} strokeWidth="1.5" vectorEffect="non-scaling-stroke" /> : null))}
      </svg>
    </figure>
  );
}

function KnobInput({ name, knob, value, tuning, onChange }: { name: keyof Tuning; knob: Knob; value: Tuning[keyof Tuning]; tuning: Tuning; onChange: (change: Partial<Tuning>) => void }) {
  const id = useId();
  const inactive = (knob.kind === 'number' && knob.modes && !knob.modes.includes(tuning.mode)) || ('trigger' in knob && knob.trigger && knob.trigger !== tuning.trigger);
  if (knob.kind === 'flag')
    return (
      <label className={`knob flag${inactive ? ' inactive' : ''}`}>
        <input type="checkbox" checked={value as boolean} onChange={(e) => onChange({ [name]: e.target.checked })} /> {knob.label}
      </label>
    );
  if (knob.kind === 'choice')
    return (
      <div className={`knob${inactive ? ' inactive' : ''}`}>
        <label htmlFor={id}>{knob.label}</label>
        <select id={id} value={value as string} onChange={(e) => onChange({ [name]: e.target.value })}>
          {knob.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>
    );
  return (
    <div className={`knob${inactive ? ' inactive' : ''}`}>
      <label htmlFor={id}>
        {knob.label}{' '}
        <output>
          {+(value as number).toFixed(3)}
          {knob.unit ? ` ${knob.unit}` : ''}
        </output>
      </label>
      <input id={id} type="range" min={knob.min} max={knob.max} step={knob.step} value={value as number} onChange={(e) => onChange({ [name]: Number(e.target.value) })} />
    </div>
  );
}

export interface TuningPanelProps {
  tuning: Tuning;
  configId: string;
  stats: Record<string, ConfigStats>;
  snapshot: Snapshot | null;
  motion: MotionPoint[];
  /** Latency of the latest shot (per leg). */
  lastShot: { gun: number; screen: number; pix: number; rw: number } | null;
  mode: GameMode;
  range: { kind: RangeKind; speed: number };
  overlay: boolean;
  onTune: (change: Partial<Tuning>) => void;
  onRange: (change: { kind?: RangeKind; speed?: number }) => void;
  onOverlay: (on: boolean) => void;
  /** Draw each target's hitbox. */
  hitboxes: boolean;
  onHitboxes: (on: boolean) => void;
  onClose: () => void;
  /** Save the current tuning as your own default. */
  onSave?: () => void;
  /** Start a 5-point calibration. */
  onCalibrate?: () => void;
}

export function TuningPanel(p: TuningPanelProps) {
  const lat = p.snapshot?.lat;
  const pct = (s: ConfigStats) => (s.shots ? `${Math.round((s.hits / s.shots) * 100)} %` : '-');
  return (
    <aside className="tuning" aria-label="Tuning">
      <div className="tuning-head">
        <h2>Tuning</h2>
        <span className="muted small">config {p.configId}</span>
        {p.onCalibrate && (
          <button type="button" className="link" onClick={p.onCalibrate}>
            Calibrate (5 dots)
          </button>
        )}
        {p.onSave && (
          <button type="button" className="link" onClick={p.onSave}>
            Save as my default
          </button>
        )}
        <button type="button" className="link" onClick={p.onClose}>
          Close (T)
        </button>
      </div>
      {p.mode === 'rounds' && <p className="muted small">Rounds are paused while this is open.</p>}

      <section>
        <h3>Latency</h3>
        <dl className="latency">
          <dt>Gun ⇄ server</dt>
          <dd>{lat ? `${lat.gun} ms` : '-'}</dd>
          <dt>Screen ⇄ server</dt>
          <dd>{lat ? `${lat.screen} ms` : '-'}</dd>
          <dt>Screen delay</dt>
          <dd>{lat ? `${lat.lag} ms` : '-'}</dd>
          <dt>Shot → pixel</dt>
          <dd>{lat ? `~${lat.pix} ms` : '-'}</dd>
          {p.lastShot && (
            <>
              <dt>Last shot</dt>
              <dd>
                rewound {p.lastShot.rw} ms · gun {p.lastShot.gun} · screen {p.lastShot.screen} · ~{p.lastShot.pix} ms
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="knobs">
        <h3>Aim</h3>
        {(Object.keys(KNOBS) as (keyof Tuning)[]).map((k) => (
          <KnobInput key={k} name={k} knob={KNOBS[k]} value={p.tuning[k]} tuning={p.tuning} onChange={p.onTune} />
        ))}
        <label className="knob flag">
          <input type="checkbox" checked={p.overlay} onChange={(e) => p.onOverlay(e.target.checked)} /> Show the raw crosshair too
        </label>
      </section>

      <section className="knobs">
        <h3>Look</h3>
        <LookSelect />
        <label className="knob flag">
          <input type="checkbox" checked={p.hitboxes} onChange={(e) => p.onHitboxes(e.target.checked)} /> Show hitboxes
        </label>
      </section>

      {p.mode === 'range' && (
        <section className="knobs">
          <h3>Range</h3>
          <div className="knob">
            <label htmlFor="range-kind">Targets</label>
            <select id="range-kind" value={p.range.kind} onChange={(e) => p.onRange({ kind: e.target.value as RangeKind })}>
              <option value="static">Still</option>
              <option value="sweep">Slow sweep</option>
              <option value="popup">Pop-ups</option>
            </select>
          </div>
          <div className="knob">
            <label htmlFor="range-speed">
              Speed <output>{p.range.speed.toFixed(1)}×</output>
            </label>
            <input id="range-speed" type="range" min={0.1} max={2} step={0.1} value={p.range.speed} onChange={(e) => p.onRange({ speed: Number(e.target.value) })} />
          </div>
        </section>
      )}

      <section>
        <h3>Motion (first gun)</h3>
        <Graph label="Attitude" points={p.motion} pick={(m) => [m.roll, m.pitch, m.yaw]} range={Math.PI} unit="rad" />
        <Graph label="Rotation rate" points={p.motion} pick={(m) => m.r} range={6} unit="rad/s" />
        <Graph label="|Acceleration|" points={p.motion} pick={(m) => [m.a]} range={4} unit="g" positive threshold={p.tuning.trigger === 'flick' ? p.tuning.flickThreshold : undefined} />
      </section>

      <section>
        <h3>Accuracy per config</h3>
        {Object.keys(p.stats).length ? (
          <table className="stats">
            <thead>
              <tr>
                <th>Config</th>
                <th>Hits</th>
                <th>Accuracy</th>
                <th>Mean miss</th>
                <th>Time to hit</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(p.stats).map(([id, s]) => (
                <tr key={id} className={id === p.configId ? 'current' : undefined}>
                  <td>{id}</td>
                  <td>
                    {s.hits}/{s.shots}
                  </td>
                  <td>{pct(s)}</td>
                  <td>{s.meanMiss ? s.meanMiss.toFixed(3) : '-'}</td>
                  <td>{s.meanTtt ? `${(s.meanTtt / 1000).toFixed(1)} s` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted small">No shots yet with any config.</p>
        )}
      </section>
    </aside>
  );
}
