/**
 * Extra demo pages for `npm run verify-app` to screenshot, beyond the home page (signed out and as
 * every persona). Add the app's main inner pages, e.g. `{ name: 'event', hash: '#/e/harvest' }`; use
 * ids from api/demo-data.ts. `as` limits a page to some personas (by email); default is all of them.
 */
export interface ScreenshotPage {
  name: string;
  hash: string;
  as?: string[];
}

export const screenshotPages: ScreenshotPage[] = [
  { name: 'event', hash: '#/e/harvest' },
  { name: 'new', hash: '#/new', as: ['olive@demo.stacks'] },
];
