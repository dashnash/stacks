import { useState } from 'react';
import type { MotionSample } from '@stacks/native';
import { Graph } from './Graph';
import { relative, tiltFromAttitude, ZERO } from './motion/tilt';
import { canCompare, errorText, sourceLabel, useMotion, useTicker, useZero, type Want } from './motion/useMotion';

export const RATES = [10, 30, 60, 100] as const;

const f = (v: number | undefined, digits = 2) => (v === undefined ? '–' : (v >= 0 ? ' ' : '') + v.toFixed(digits));
const deg = (rad: number) => (rad * 180) / Math.PI;

function Readout({ label, values, unit }: { label: string; values: [string, number | undefined][]; unit: string }) {
  return (
    <div className="readout">
      <h3>{label}</h3>
      <dl>
        {values.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{f(v, unit === '°' ? 0 : 2)}</dd>
          </div>
        ))}
      </dl>
      <span className="muted small">{unit}</span>
    </div>
  );
}

export function Lab() {
  const [hz, setHz] = useState<number>(100);
  const [want, setWant] = useState<Want>('auto');
  const motion = useMotion(hz, want);
  const { zero, setZero } = useZero();
  useTicker(66);

  const stats = motion.stats.current;
  const snap = stats?.snapshot();
  const latest: MotionSample | undefined = stats?.latest;
  const history = stats?.history ?? [];
  const att = latest?.attitude ? relative(latest.attitude, zero) : null;
  const tilt = att ? tiltFromAttitude(att) : { x: 0, y: 0 };
  const label = sourceLabel(motion.source);

  return (
    <section className="lab" aria-label="Lab">
      <div className="bar">
        <span className={`chip chip-${label.toLowerCase()}`} data-testid="source">
          {label}
          {motion.hz ? ` · ${motion.hz} Hz` : ''}
        </span>
        {canCompare() && (
          <button type="button" className="ghost" onClick={() => setWant(want === 'web' ? 'auto' : 'web')}>
            {want === 'web' ? 'Use the app’s sensors' : 'Compare: browser sensors'}
          </button>
        )}
      </div>

      <div className="rates" role="group" aria-label="Sample rate">
        {RATES.map((r) => (
          <button key={r} type="button" aria-pressed={hz === r} onClick={() => setHz(r)}>
            {r} Hz
          </button>
        ))}
      </div>

      {motion.needsTap && (
        <button type="button" className="primary" onClick={() => void motion.enable()}>
          Enable motion
        </button>
      )}
      {motion.error && <p className="error" role="alert">{errorText[motion.error]}</p>}

      <div className="meter" aria-label="Rate meter">
        <div>
          <span className="big">{hz}</span>
          <span className="muted small">asked Hz</span>
        </div>
        <div>
          <span className="big" data-testid="measured">{snap?.hz ?? 0}</span>
          <span className="muted small">measured Hz</span>
        </div>
        <div>
          <span className="big">{snap?.perBatch ?? 0}</span>
          <span className="muted small">per batch</span>
        </div>
        <div>
          <span className="big">{snap?.late ?? 0}</span>
          <span className="muted small">late batches</span>
        </div>
        <div>
          <span className="big">{snap?.dropped ?? 0}</span>
          <span className="muted small">dropped</span>
        </div>
      </div>

      <div className="viz">
        <div className="level" aria-label="Bubble level">
          <div className="bubble" style={{ transform: `translate(${(-tilt.x * 45).toFixed(1)}px, ${(-tilt.y * 45).toFixed(1)}px)` }} />
          <div className="cross" />
        </div>
        <div className="phone-stage" aria-label="Phone attitude">
          <div
            className="phone"
            style={{ transform: att ? `rotateX(${deg(att.pitch).toFixed(1)}deg) rotateY(${deg(att.roll).toFixed(1)}deg) rotateZ(${deg(-att.yaw).toFixed(1)}deg)` : undefined }}
          >
            <span>▲</span>
          </div>
        </div>
        <button type="button" className="ghost" onClick={() => latest?.attitude && setZero(latest.attitude)} disabled={!latest?.attitude}>
          Zero
        </button>
        {zero !== ZERO && (
          <button type="button" className="link" onClick={() => setZero(ZERO)}>
            Clear zero
          </button>
        )}
      </div>

      <div className="readouts">
        <Readout label="Acceleration" unit="g" values={[['x', latest?.userAcceleration?.x], ['y', latest?.userAcceleration?.y], ['z', latest?.userAcceleration?.z]]} />
        <Readout label="Rotation" unit="rad/s" values={[['x', latest?.rotationRate?.x], ['y', latest?.rotationRate?.y], ['z', latest?.rotationRate?.z]]} />
        <Readout label="Gravity" unit="g" values={[['x', latest?.gravity?.x], ['y', latest?.gravity?.y], ['z', latest?.gravity?.z]]} />
        <Readout label="Attitude" unit="°" values={[['roll', att && deg(att.roll)], ['pitch', att && deg(att.pitch)], ['yaw', att && deg(att.yaw)]].map(([k, v]) => [k as string, (v ?? undefined) as number | undefined])} />
      </div>

      <div className="graphs">
        <Graph label="Acceleration" unit="g" range={2} samples={history} pick={(s) => (s.userAcceleration ? [s.userAcceleration.x, s.userAcceleration.y, s.userAcceleration.z] : null)} />
        <Graph label="Rotation" unit="rad/s" range={6} samples={history} pick={(s) => (s.rotationRate ? [s.rotationRate.x, s.rotationRate.y, s.rotationRate.z] : null)} />
        <Graph label="Gravity" unit="g" range={1} samples={history} pick={(s) => (s.gravity ? [s.gravity.x, s.gravity.y, s.gravity.z] : null)} />
        <Graph label="Attitude" unit="rad" range={Math.PI} samples={history} pick={(s) => (s.attitude ? [s.attitude.roll, s.attitude.pitch, s.attitude.yaw] : null)} />
      </div>
      <p className="muted small legend">
        <span className="k0">■ x / roll</span> <span className="k1">■ y / pitch</span> <span className="k2">■ z / yaw</span>
      </p>
    </section>
  );
}
