/**
 * The look you picked: saved per person (`/prefs`) when signed in, in this browser otherwise. The
 * title screen and the tuning panel change it; the screen draws with it and tells the room, and the
 * phone follows the room.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApi, useStacks } from '@stacks/web';
import { DEFAULT_THEME, isThemeChoice, THEME_IDS, THEME_PALETTES, type ThemeChoice } from '../../game/themes';
import { drawThumb } from './draw';
import { THEMES } from './themes';

/** Where the look is kept in this browser (signed out, the demo). */
export const STORAGE_KEY = 'sky-shot:theme';

function readLocal(): ThemeChoice {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return isThemeChoice(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}
function writeLocal(c: ThemeChoice) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // Storage blocked (private window): the choice lasts this visit.
  }
}

interface LookState {
  look: ThemeChoice;
  setLook: (c: ThemeChoice) => void;
  /** Saving to your account failed (the look still applies here). */
  error: Error | null;
}

const LookContext = createContext<LookState>({ look: DEFAULT_THEME, setLook: () => undefined, error: null });

export function LookProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { status, session } = useStacks();
  const signedIn = status === 'signedIn' && !!session;
  const [look, setLookState] = useState<ThemeChoice>(readLocal);
  const [error, setError] = useState<Error | null>(null);
  const changed = useRef(false);

  // Signed in: your saved look wins, unless you already changed it on this visit.
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    api.get<{ theme: ThemeChoice | null }>('/prefs').then(
      ({ theme }) => {
        if (live && theme && isThemeChoice(theme) && !changed.current) {
          setLookState(theme);
          writeLocal(theme);
        }
      },
      () => undefined, // Not fatal: the look in this browser stays.
    );
    return () => {
      live = false;
    };
  }, [api, signedIn, session?.user.id]);

  const setLook = useCallback(
    (c: ThemeChoice) => {
      changed.current = true;
      setLookState(c);
      writeLocal(c);
      setError(null);
      if (signedIn) api.put('/prefs', { theme: c }).catch((err: Error) => setError(err));
    },
    [api, signedIn],
  );
  const value = useMemo(() => ({ look, setLook, error }), [look, setLook, error]);
  return <LookContext.Provider value={value}>{children}</LookContext.Provider>;
}

export const useLook = () => useContext(LookContext);

/** A small still of a theme. */
export function LookThumb({ choice }: { choice: ThemeChoice }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    const ctx = el?.getContext?.('2d');
    if (!el || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth || 160;
    const h = el.clientHeight || 90;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawThumb(ctx, w, h, choice);
  }, [choice.id, choice.palette]);
  return <canvas ref={ref} className="look-thumb" aria-hidden="true" />;
}

/** The title screen's picker: a card per theme, and its palettes when it has more than one. */
export function LookPicker() {
  const { look, setLook, error } = useLook();
  const palettes = THEME_PALETTES[look.id];
  const theme = THEMES[look.id];
  return (
    <section className="look panel" aria-labelledby="look-h">
      <h2 id="look-h">Look</h2>
      <div className="look-cards" role="radiogroup" aria-label="Look">
        {THEME_IDS.map((id) => {
          const choice = id === look.id ? look : { id, palette: THEME_PALETTES[id][0] };
          return (
            <button key={id} type="button" role="radio" aria-checked={id === look.id} className="look-card" onClick={() => id !== look.id && setLook(choice)}>
              <LookThumb choice={choice} />
              <span>{THEMES[id].name}</span>
            </button>
          );
        })}
      </div>
      {palettes.length > 1 && (
        <div className="look-palettes" role="radiogroup" aria-label={`${theme.name} palette`}>
          {palettes.map((key) => (
            <button key={key} type="button" role="radio" aria-checked={key === look.palette} onClick={() => setLook({ id: look.id, palette: key })}>
              {theme.palettes[key]!.name}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="error small" role="alert">
          Couldn't save your look to your account ({error.message}). It still applies in this browser.
        </p>
      )}
    </section>
  );
}

/** The tuning panel's compact version. */
export function LookSelect() {
  const { look, setLook } = useLook();
  const options = THEME_IDS.flatMap((id) => THEME_PALETTES[id].map((palette) => ({ id, palette, label: THEME_PALETTES[id].length > 1 ? `${THEMES[id].name} · ${THEMES[id].palettes[palette]!.name}` : THEMES[id].name })));
  return (
    <div className="knob">
      <label htmlFor="look-select">Look (L)</label>
      <select
        id="look-select"
        value={`${look.id}/${look.palette}`}
        onChange={(e) => {
          const [id, palette] = e.target.value.split('/');
          const c = { id, palette };
          if (isThemeChoice(c)) setLook(c);
        }}
      >
        {options.map((o) => (
          <option key={`${o.id}/${o.palette}`} value={`${o.id}/${o.palette}`}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
