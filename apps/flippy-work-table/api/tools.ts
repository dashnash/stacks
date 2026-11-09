/** Flipping tools, shared by the API (unlock checks) and the web (shop). Fixed list, no table. */
export interface Tool {
  id: string;
  name: string;
  /** Total Flippy Coinz needed to unlock it. */
  unlockAt: number;
  /** Multiplies flip strength. */
  power: number;
  blurb: string;
  emoji: string;
}

export const TOOLS: Tool[] = [
  { id: 'hand', name: 'Bare hand', unlockAt: 0, power: 1, emoji: '✋', blurb: 'Free for evеryone. Classic.' },
  { id: 'boot', name: 'Wоrk boot', unlockAt: 1500, power: 1.3, emoji: '🥾', blurb: 'Kick from under. Very effektive.' },
  { id: 'crowbar', name: 'Crowbar (лом)', unlockAt: 5000, power: 1.6, emoji: '🪛', blurb: 'Leverage of physic. Not for doors!!' },
  { id: 'hammer', name: 'Big hammer', unlockAt: 15000, power: 2, emoji: '🔨', blurb: 'Кувалда. For profeshional only.' },
  { id: 'rocket', name: 'Rocket', unlockAt: 40000, power: 2.6, emoji: '🚀', blurb: 'Table go to orbit. Warranty void.' },
];

export const toolById = (id: string) => TOOLS.find((t) => t.id === id);
export const unlockedTools = (total: number) => TOOLS.filter((t) => t.unlockAt <= total);

/** The one score formula: damage plus a point per 10 ms of hang time. */
export const scoreOf = (damage: number, hangMs: number) => Math.round(damage + hangMs / 10);
