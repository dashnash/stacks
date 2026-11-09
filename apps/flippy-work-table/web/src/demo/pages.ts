/**
 * Extra demo pages for `npm run verify-app` to screenshot, beyond the home page (signed out and as
 * every persona). `as` limits a page to some personas (by email); default is all of them.
 */
export interface ScreenshotPage {
  name: string;
  hash: string;
  as?: string[];
}

export const screenshotPages: ScreenshotPage[] = [
  { name: 'top', hash: '#/top' },
  { name: 'shop', hash: '#/shop' },
];
