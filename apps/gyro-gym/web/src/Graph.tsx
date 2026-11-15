import type { MotionSample } from '@stacks/native';
import { HISTORY_S } from './motion/stats';

const W = 300;
const H = 72;
const MAX_POINTS = 150;
const COLORS = ['#c6ff3d', '#4dd0ff', '#ff6b9a'];

/** The last 5 s of three values as lines, newest at the right. `range`: values are drawn from -range to +range. */
export function Graph({ label, samples, pick, range, unit }: { label: string; samples: MotionSample[]; pick: (s: MotionSample) => [number, number, number] | null; range: number; unit: string }) {
  const end = samples[samples.length - 1]?.t ?? 0;
  const every = Math.max(1, Math.ceil(samples.length / MAX_POINTS));
  const lines: string[][] = [[], [], []];
  for (let i = 0; i < samples.length; i += every) {
    const s = samples[i]!;
    const v = pick(s);
    if (!v) continue;
    const x = W - ((end - s.t) / HISTORY_S) * W;
    v.forEach((val, k) => lines[k]!.push(`${x.toFixed(1)},${(H / 2 - (Math.max(-range, Math.min(range, val)) / range) * (H / 2 - 2)).toFixed(1)}`));
  }
  return (
    <figure className="graph">
      <figcaption>
        {label} <span className="muted">±{Math.abs(range - Math.PI) < 1e-9 ? 'π' : range} {unit}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}, last ${HISTORY_S} seconds`}>
        <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="axis" />
        {lines.map((pts, k) => (pts.length > 1 ? <polyline key={k} points={pts.join(' ')} fill="none" stroke={COLORS[k]} strokeWidth="1.5" vectorEffect="non-scaling-stroke" /> : null))}
      </svg>
    </figure>
  );
}
