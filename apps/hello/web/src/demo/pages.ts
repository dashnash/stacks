/**
 * Extra demo pages for `npm run verify-app` to screenshot, beyond the home page (signed out and as
 * every persona). `#/duo` (see demo.tsx) is two personas in one Live dots room; the picture waits
 * until the second player's board shows both dots.
 */
export interface ScreenshotPage {
  name: string;
  hash: string;
  as?: string[];
  waitFor?: string;
}

export const screenshotPages: ScreenshotPage[] = [
  { name: 'live-dots-two-players', hash: '#/duo', as: ['olive@demo.stacks'], waitFor: '.duo-pane:nth-child(2) .dot:nth-child(2)' },
];
