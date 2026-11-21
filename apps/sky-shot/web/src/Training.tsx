/**
 * Training mode's screens: the intro, the line under the dot while the script runs, the result of
 * the fit (before and after, what changed), and the blind A/B that decides whether to keep it.
 */
import type { FitReport, Metrics } from "../../game/fit";
import type { TrainingView } from "../../game/protocol";
import { KNOBS, type Tuning } from "../../game/tuning";

/** Each A/B round, ms. */
export const AB_MS = 20_000;

/** With a phone paired, the choices are on the phone: the screen shows what's on, not the buttons. */
export function OnPhone() {
  return <p className="muted on-phone">Choose on your phone.</p>;
}

export function TrainingIntro({
  onStart,
  error,
  remote = false,
}: {
  onStart: () => void;
  error: string | null;
  remote?: boolean;
}) {
  return (
    <div className="overlay training-intro" role="dialog" aria-label="Training">
      <h2>Train the aim</h2>
      <p>
        About two minutes. Sit and hold the phone the way you play. The game
        learns how far and how fast you move, then fits the controls to you.
      </p>
      <ol className="steps">
        <li>
          <strong>Follow the dot</strong> with the crosshair when it moves or
          sits still.
        </li>
        <li>
          <strong>When the crosshair vanishes</strong>, a new dot appears: point
          where it is in one natural move and hold still. Don't hunt for it.
        </li>
      </ol>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {remote ? (
        <p className="muted on-phone">Start it on your phone.</p>
      ) : (
        <button type="button" className="primary big" onClick={onStart}>
          Start training
        </button>
      )}
    </div>
  );
}

const HINT: Record<TrainingView["k"], string> = {
  ready: "",
  gap: "Next one…",
  jump: "Point at the new dot and hold",
  track: "Follow the dot",
  hold: "Keep the crosshair on the dot",
  fit: "Fitting…",
  done: "",
};

/** The progress line over the canvas while training runs. */
export function TrainingHud({ tr }: { tr: TrainingView }) {
  const text = tr.k === "jump" && tr.show ? "Settle on the dot" : HINT[tr.k];
  return (
    <div className="train-hud" role="status" aria-live="polite">
      {tr.k === "fit" ? (
        <span>Fitting your aim… {Math.round((tr.p ?? 0) * 100)} %</span>
      ) : (
        <>
          <span className="muted">
            {Math.min(tr.i + 1, tr.n)} / {tr.n}
          </span>
          <span>{text}</span>
          <progress max={tr.n} value={tr.i} aria-label="Training progress" />
        </>
      )}
    </div>
  );
}

/** The knobs the fit changed, labelled for people. */
export function changedKnobs(
  base: Tuning,
  fitted: Tuning,
): { key: keyof Tuning; label: string; from: string; to: string }[] {
  const show = (k: keyof Tuning, v: Tuning[keyof Tuning]) => {
    const knob = KNOBS[k];
    if (typeof v === "number")
      return `${+v.toFixed(3)}${knob.kind === "number" && knob.unit ? ` ${knob.unit}` : ""}`;
    return typeof v === "boolean" ? (v ? "on" : "off") : String(v);
  };
  return (Object.keys(KNOBS) as (keyof Tuning)[])
    .filter((k) => base[k] !== fitted[k])
    .map((k) => ({
      key: k,
      label: KNOBS[k].label,
      from: show(k, base[k]),
      to: show(k, fitted[k]),
    }));
}

const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
/** Screen heights to pixels on this screen. */
const px = (n: number) =>
  `${(n * (typeof window === "undefined" ? 1000 : window.innerHeight)).toFixed(1)} px`;

function Row({
  label,
  before,
  after,
  note,
}: {
  label: string;
  before: string;
  after: string;
  note?: string;
}) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{before}</td>
      <td>{after}</td>
      <td className="muted small">{note}</td>
    </tr>
  );
}

function speedNote(m: Metrics) {
  if (!m.gain) return "";
  if (m.gain > 1.15) return "too fast";
  if (m.gain < 0.87) return "too slow";
  return "about right";
}

export function TrainingResult({
  report,
  onCompare,
  onUse,
  onKeep,
  onAgain,
  remote = false,
}: {
  remote?: boolean;
  report: FitReport;
  onCompare: () => void;
  onUse: () => void;
  onKeep: () => void;
  onAgain: () => void;
}) {
  const { before, after } = report;
  const changes = changedKnobs(report.base, report.fitted);
  const fewJumps = report.usedJumps < 8;
  return (
    <div
      className="overlay training-result"
      role="dialog"
      aria-label="Training result"
    >
      <h2>Your fitted aim</h2>
      {fewJumps ? (
        <p className="error">
          Only {report.usedJumps} of {report.totalJumps} jumps were usable (hold
          still at the end of each), so only the smoothing was fitted. Try
          another run.
        </p>
      ) : (
        <p className="muted small">
          From {report.usedJumps} of {report.totalJumps} jumps, the tracking and
          the holds. Delay to the screen: {report.latencyMs} ms.
        </p>
      )}
      <table className="compare">
        <thead>
          <tr>
            <th />
            <th>Yours</th>
            <th>Fitted</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <Row
            label="Speed"
            before={`${before.gain.toFixed(2)}×`}
            after={`${after.gain.toFixed(2)}×`}
            note={`${speedNote(before)} → ${speedNote(after)}`}
          />
          <Row
            label="Jump miss"
            before={pct(before.jumpErr)}
            after={pct(after.jumpErr)}
            note="of the screen height"
          />
          <Row
            label="Lag"
            before={`${before.lagMs} ms`}
            after={`${after.lagMs} ms`}
            note="hand to pixel"
          />
          <Row
            label="Shake"
            before={px(before.jitter)}
            after={px(after.jitter)}
            note="holding still"
          />
        </tbody>
      </table>
      {changes.length > 0 && (
        <details>
          <summary>What changed ({changes.length})</summary>
          <ul className="changes">
            {changes.map((c) => (
              <li key={c.key}>
                {c.label}: {c.from} → <strong>{c.to}</strong>
              </li>
            ))}
          </ul>
        </details>
      )}
      {remote ? (
        <OnPhone />
      ) : (
        <div className="row">
          <button type="button" className="primary" onClick={onCompare}>
            Compare blind (A/B)
          </button>
          <button type="button" onClick={onUse}>
            Use the fit
          </button>
          <button type="button" onClick={onKeep}>
            Keep mine
          </button>
          <button type="button" className="link" onClick={onAgain}>
            Train again
          </button>
        </div>
      )}
    </div>
  );
}

export type Pick = "A" | "B" | "same";

/** Shown between and after the two A/B rounds. */
export function AbChoice({
  onPick,
  score,
  remote = false,
}: {
  onPick: (p: Pick) => void;
  remote?: boolean;
  score: [{ hits: number; shots: number }, { hits: number; shots: number }];
}) {
  return (
    <div
      className="overlay ab-choice"
      role="dialog"
      aria-label="Which felt better?"
    >
      <h2>Which felt better?</h2>
      <p className="muted">
        Go by feel. The hits are below, but a short round says little.
      </p>
      <p className="small">
        A: {score[0].hits}/{score[0].shots} hits · B: {score[1].hits}/
        {score[1].shots} hits
      </p>
      {remote ? (
        <OnPhone />
      ) : (
        <div className="row">
          <button type="button" className="primary" onClick={() => onPick("A")}>
            A
          </button>
          <button type="button" className="primary" onClick={() => onPick("B")}>
            B
          </button>
          <button type="button" onClick={() => onPick("same")}>
            Can't tell
          </button>
        </div>
      )}
    </div>
  );
}

export function AbBanner({ label, msLeft }: { label: string; msLeft: number }) {
  return (
    <div className="banner ab-banner" role="status">
      Try {label} · {Math.ceil(msLeft / 1000)} s
    </div>
  );
}

/** After the A/B (or a direct choice): what is in use now, and where to go next. */
export function TrainingDone({
  message,
  saving,
  error,
  onPlay,
  onAgain,
  onDone,
  remote = false,
}: {
  message: string;
  saving: boolean;
  error: string | null;
  onPlay: () => void;
  onAgain: () => void;
  onDone: () => void;
  remote?: boolean;
}) {
  return (
    <div
      className="overlay training-done"
      role="dialog"
      aria-label="Training done"
    >
      <h2>{saving ? "Saving…" : message}</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {remote ? (
        <OnPhone />
      ) : (
        <div className="row">
          <button type="button" className="primary" onClick={onPlay}>
            Play Rounds
          </button>
          <button type="button" onClick={onAgain}>
            Train again
          </button>
          <button type="button" className="link" onClick={onDone}>
            Done (save)
          </button>
        </div>
      )}
    </div>
  );
}
