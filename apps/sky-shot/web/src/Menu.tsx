/**
 * The controller's menu: game, look, re-calibrate, settings, and (paused) resume and exit. The phone
 * shows it (it sends `{ menu }` events); with only a mouse, the screen shows it as a pause panel.
 * Looks swap live; switching game mid-round ends that game (saved) and starts the new one.
 */
import { useState } from 'react';
import type { GameMode } from '../../game/protocol';
import { THEME_IDS, THEME_PALETTES, type ThemeChoice } from '../../game/themes';
import type { Tuning } from '../../game/tuning';
import { LookThumb } from './Look';
import { THEMES } from './themes';

const AIM_MODES: Tuning['mode'][] = ['absolute', 'relative', 'hybrid'];

export const GAMES: { mode: GameMode; name: string; note: string }[] = [
  { mode: 'rounds', name: 'Rounds', note: 'scored waves' },
  { mode: 'range', name: 'Range', note: 'free fire, tune' },
  { mode: 'training', name: 'Training', note: '1 min fit' },
];

export const gameName = (m: GameMode) => GAMES.find((g) => g.mode === m)?.name ?? m;

export interface MenuProps {
  mode: GameMode;
  look: ThemeChoice;
  onMode: (m: GameMode) => void;
  onLook: (c: ThemeChoice) => void;
  /** A game is on: switching ends it. */
  playing?: boolean;
  /** Training needs a phone. */
  canTrain?: boolean;
  onRecalibrate?: () => void;
  onSettings?: () => void;
  onResume?: () => void;
  /** Exit to the menu; asked to confirm first when `confirmExit`. */
  onExit?: () => void;
  confirmExit?: boolean;
}

export function GameMenu(p: MenuProps) {
  const [sure, setSure] = useState(false);
  return (
    <div className="menu">
      {p.onResume && (
        <button type="button" className="primary big menu-resume" onClick={p.onResume}>
          Resume
        </button>
      )}
      <h3 className="menu-h">Game</h3>
      <div className="menu-games" role="radiogroup" aria-label="Game">
        {GAMES.map((g) => {
          const off = g.mode === 'training' && p.canTrain === false;
          return (
            <button key={g.mode} type="button" role="radio" aria-checked={p.mode === g.mode} disabled={off} onClick={() => g.mode !== p.mode && p.onMode(g.mode)}>
              {g.name}
              <small>{g.note}</small>
            </button>
          );
        })}
      </div>
      {p.canTrain === false && <p className="muted small">Training needs a phone.</p>}
      {p.playing && <p className="muted small">Switching game ends this round, saves its score and starts the new one.</p>}
      <h3 className="menu-h">Look · changes instantly</h3>
      <div className="menu-looks" role="radiogroup" aria-label="Look">
        {THEME_IDS.flatMap((id) =>
          THEME_PALETTES[id].map((palette) => {
            const c = { id, palette };
            const on = p.look.id === id && p.look.palette === palette;
            const name = THEME_PALETTES[id].length > 1 ? `${THEMES[id].name} · ${THEMES[id].palettes[palette]!.name}` : THEMES[id].name;
            return (
              <button key={`${id}/${palette}`} type="button" role="radio" aria-checked={on} aria-label={name} onClick={() => !on && p.onLook(c)}>
                <LookThumb choice={c} />
                <span>{name}</span>
              </button>
            );
          }),
        )}
      </div>
      <div className="menu-actions">
        {p.onRecalibrate && (
          <button type="button" onClick={p.onRecalibrate}>
            Re-calibrate <small>5 dots, live crosshair</small>
          </button>
        )}
        {p.onSettings && (
          <button type="button" onClick={p.onSettings}>
            Settings <small>aim, trigger, sensitivity</small>
          </button>
        )}
      </div>
      {p.onExit &&
        (p.confirmExit && sure ? (
          <div className="menu-confirm" role="alertdialog" aria-label="Exit to menu?">
            <p>End the game and go back to the menu? Scores so far are saved.</p>
            <div className="row">
              <button type="button" className="primary" onClick={p.onExit}>
                Exit
              </button>
              <button type="button" onClick={() => setSure(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="menu-exit" onClick={() => (p.confirmExit ? setSure(true) : p.onExit!())}>
            ← Exit to menu
          </button>
        ))}
    </div>
  );
}

/** The phone's settings: the knobs a player changes (the screen's tuning panel has every one). */
export function PhoneSettings({ tuning, onTune, onSave, onClose, saved }: { tuning: Tuning; onTune: (c: Partial<Tuning>) => void; onSave: () => void; onClose: () => void; saved: string | null }) {
  const gainKey = tuning.mode === 'relative' ? 'sensitivity' : 'fovGain';
  return (
    <div className="menu settings">
      <h3 className="menu-h">Settings</h3>
      <label className="knob">
        Aim
        <select value={tuning.mode} onChange={(e) => onTune({ mode: e.target.value as Tuning['mode'] })}>
          {AIM_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label className="knob">
        Trigger
        <select value={tuning.trigger} onChange={(e) => onTune({ trigger: e.target.value as Tuning['trigger'] })}>
          <option value="tap">tap</option>
          <option value="flick">flick</option>
        </select>
      </label>
      <label className="knob">
        Sensitivity <output>{tuning[gainKey].toFixed(2)}</output>
        <input type="range" min={0.3} max={4} step={0.05} value={tuning[gainKey]} onChange={(e) => onTune({ [gainKey]: Number(e.target.value) })} />
      </label>
      <label className="knob">
        Smoothing <output>{tuning.minCutoff.toFixed(1)} Hz</output>
        <input type="range" min={0.2} max={6} step={0.1} value={tuning.minCutoff} onChange={(e) => onTune({ minCutoff: Number(e.target.value) })} />
      </label>
      <label className="knob">
        Hold
        <select value={tuning.orientation} onChange={(e) => onTune({ orientation: e.target.value as Tuning['orientation'] })}>
          <option value="portrait">upright</option>
          <option value="landscape">sideways</option>
        </select>
      </label>
      <div className="row">
        <button type="button" onClick={onSave}>
          Save as my default
        </button>
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </div>
      {saved && (
        <p className="muted small" role="status">
          {saved}
        </p>
      )}
    </div>
  );
}
