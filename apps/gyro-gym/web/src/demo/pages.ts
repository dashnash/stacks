/**
 * Extra demo pages for `npm run verify-app` to screenshot, beyond the home page (signed out and as
 * every persona). Add the app's main inner pages, e.g. `{ name: 'event', hash: '#/e/harvest' }`; use
 * ids from api/demo-data.ts. `as` limits a page to some personas (by email); default is all of them.
 * `waitFor` is a CSS selector to wait for before the picture (a page that connects to something first).
 */
export interface ScreenshotPage {
  name: string;
  hash: string;
  as?: string[];
  waitFor?: string;
}

export const screenshotPages: ScreenshotPage[] = [
  { name: 'kit', hash: '#/kit' },
  { name: 'maze', hash: '#/maze' },
];
