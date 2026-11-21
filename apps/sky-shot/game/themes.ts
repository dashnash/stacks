/**
 * Which looks exist, shared by the game server, the API and the web UI. Only ids and palette keys
 * live here (the server and API validate against them); the drawing is in `web/src/themes/`.
 *
 * A theme changes how the game is drawn and worded, never the game itself (spec #144).
 */

/** Each theme and its palettes, the first palette being the theme's default. */
export const THEME_PALETTES = {
  dusk: ['dusk'],
  neon: ['midnight', 'amber'],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type ThemeId = keyof typeof THEME_PALETTES;
export const THEME_IDS = Object.keys(THEME_PALETTES) as ThemeId[];

export interface ThemeChoice {
  id: ThemeId;
  palette: string;
}

export const DEFAULT_THEME: ThemeChoice = { id: 'dusk', palette: 'dusk' };

export function isThemeChoice(v: unknown): v is ThemeChoice {
  if (!v || typeof v !== 'object') return false;
  const { id, palette } = v as { id?: unknown; palette?: unknown };
  if (typeof id !== 'string' || typeof palette !== 'string' || !Object.hasOwn(THEME_PALETTES, id)) return false;
  return (THEME_PALETTES[id as ThemeId] as readonly string[]).includes(palette);
}

/** How a choice is written in telemetry: `"koi/rice"`. */
export const themeTag = (c: ThemeChoice) => `${c.id}/${c.palette}`;

/** Every `themeTag` there is (for the telemetry filter). */
export const THEME_TAGS = THEME_IDS.flatMap((id) => THEME_PALETTES[id].map((palette) => themeTag({ id, palette })));
