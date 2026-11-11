/**
 * Extra demo pages for `npm run verify-app` to screenshot, beyond the home page (signed out and as
 * every persona). Ids come from api/demo-data.ts. `as` limits a page to some personas (by email).
 */
export interface ScreenshotPage {
  name: string;
  hash: string;
  as?: string[];
}

export const screenshotPages: ScreenshotPage[] = [
  { name: 'weekly-shop', hash: '#/l/weekly-shop' },
  { name: 'costco-run', hash: '#/l/costco-run' },
];
