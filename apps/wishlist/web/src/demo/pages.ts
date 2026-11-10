/**
 * Extra demo pages for `npm run verify-app` to screenshot, beyond the home page (signed out and as
 * every persona). `as` limits a page to some personas (by email); default is all of them.
 */
export interface ScreenshotPage {
  name: string;
  hash: string;
  as?: string[];
}

// New list ids are hashes of the owner's user id (listIdFor in api/model.ts); these are the demo's.
const NANA = 'b230e511d9e9c401';
const OLIVE = 'dca44f775f74c3dc';

export const screenshotPages: ScreenshotPage[] = [
  { name: 'nanas-list', hash: `#/l/${NANA}` },
  { name: 'own-list', hash: `#/l/${OLIVE}`, as: ['olive@demo.stacks'] },
  { name: 'claims', hash: '#/claims' },
];
