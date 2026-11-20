/**
 * Extra demo pages for `npm run verify-app` to screenshot, beyond the title screen (signed out and as
 * every persona). `#/autoplay` starts a room, pairs the demo's pretend phone and starts Round 1;
 * `#/autoplay/tuning` does the same on the Range with the tuning panel open.
 */
export interface ScreenshotPage {
  name: string;
  hash: string;
  as?: string[];
  waitFor?: string;
}

export const screenshotPages: ScreenshotPage[] = [
  { name: 'mid-round', hash: '#/autoplay', as: ['max@demo.stacks'], waitFor: '.hud .shells' },
  { name: 'tuning-panel', hash: '#/autoplay/tuning', as: ['max@demo.stacks'], waitFor: '.hud .score' },
  { name: 'telemetry', hash: '#/telemetry', waitFor: '.telemetry table' },
];
