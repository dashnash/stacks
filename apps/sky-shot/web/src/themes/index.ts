/**
 * The looks, by id. Adding a theme: its palettes in `game/themes.ts` (the server and API check
 * against those), its drawing here. `themes.test.ts` checks the two agree.
 */
import type { CSSProperties } from 'react';
import { DEFAULT_THEME, THEME_IDS, THEME_PALETTES, type ThemeChoice, type ThemeId } from '../../../game/themes';
import { dusk } from './dusk';
import { koi } from './koi';
import { neon } from './neon';
import { stars } from './stars';
import type { Palette, Theme } from './types';

export type { Effect, HitCopy, Palette, Theme } from './types';

export const THEMES: Record<ThemeId, Theme> = { dusk, koi, neon, stars };

export function themeOf(choice: ThemeChoice): { theme: Theme; palette: Palette } {
  const theme = THEMES[choice.id] ?? THEMES[DEFAULT_THEME.id];
  const palette = theme.palettes[choice.palette] ?? theme.palettes[THEME_PALETTES[theme.id][0]]!;
  return { theme, palette };
}

/** The next theme (its default palette), for the `L` key. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  const id = THEME_IDS[(THEME_IDS.indexOf(choice.id) + 1) % THEME_IDS.length]!;
  return { id, palette: THEME_PALETTES[id][0] };
}

/** The palette's CSS custom properties, for a `style` prop. */
export const lookStyle = (choice: ThemeChoice) => themeOf(choice).palette.css as CSSProperties;
