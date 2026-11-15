import { useState } from 'react';
import { native, type HapticEvent, type ImpactStyle, type NotificationType, type Orientation } from '@stacks/native';

const IMPACTS: ImpactStyle[] = ['light', 'medium', 'heavy', 'soft', 'rigid'];
const NOTIFICATIONS: NotificationType[] = ['success', 'warning', 'error'];
const ORIENTATIONS: Orientation[] = ['portrait', 'landscape', 'any'];
/** A heartbeat: two taps, then a soft buzz. */
export const SAMPLE_PATTERN: HapticEvent[] = [
  { t: 0, intensity: 1, sharpness: 0.6 },
  { t: 0.15, intensity: 0.7, sharpness: 0.4 },
  { t: 0.45, intensity: 0.5, sharpness: 0.1, duration: 0.4 },
];

interface Control {
  id: string;
  label: string;
  /** The bridge call it uses (to say "web fallback" when the app isn't there). */
  call: string;
  run: () => Promise<void>;
}

const controls: { title: string; items: Control[] }[] = [
  { title: 'Impacts', items: IMPACTS.map((s) => ({ id: `impact-${s}`, label: s, call: 'haptics.impact', run: () => native.haptics.impact(s) })) },
  { title: 'Notifications', items: NOTIFICATIONS.map((t) => ({ id: `note-${t}`, label: t, call: 'haptics.notification', run: () => native.haptics.notification(t) })) },
  { title: 'Pattern', items: [{ id: 'pattern', label: 'heartbeat', call: 'haptics.pattern', run: () => native.haptics.pattern(SAMPLE_PATTERN) }] },
  { title: 'Orientation lock', items: ORIENTATIONS.map((o) => ({ id: `orient-${o}`, label: o, call: 'screen.lockOrientation', run: () => native.screen.lockOrientation(o) })) },
  {
    title: 'Immersive',
    items: [
      { id: 'immersive-on', label: 'on', call: 'screen.immersive', run: () => native.screen.immersive(true) },
      { id: 'immersive-off', label: 'off', call: 'screen.immersive', run: () => native.screen.immersive(false) },
    ],
  },
  {
    title: 'Keep awake',
    items: [
      { id: 'awake-on', label: 'on', call: 'screen.keepAwake', run: () => native.screen.keepAwake(true) },
      { id: 'awake-off', label: 'off', call: 'screen.keepAwake', run: () => native.screen.keepAwake(false) },
    ],
  },
];

/** What a press did: `ok` (from the app), `web` (the browser's fallback ran), or the error code. */
export async function runControl(c: Control): Promise<string> {
  try {
    await c.run();
    return native.has(c.call) ? 'ok' : 'web';
  } catch (err) {
    return (err as { code?: string }).code ?? 'failed';
  }
}

export function Kit() {
  const [results, setResults] = useState<Record<string, string>>({});
  return (
    <section className="kit" aria-label="Kit">
      <p className="muted small">
        {native.available ? `In the app (${native.platform} ${native.version}).` : 'In a browser: haptics use vibration where there is any; screen controls mostly say unsupported.'}
      </p>
      {controls.map((group) => (
        <div key={group.title} className="kit-group">
          <h3>{group.title}</h3>
          <ul>
            {group.items.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={async () => { const r = await runControl(c); setResults((prev) => ({ ...prev, [c.id]: r })); }} aria-label={`${group.title}: ${c.label}`}>
                  {c.label}
                </button>
                <output className={`result result-${results[c.id] ?? 'none'}`} aria-label={`${group.title} ${c.label} result`}>
                  {results[c.id] ?? ''}
                </output>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
