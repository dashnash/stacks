/**
 * Extra demo pages for `npm run verify-app` to screenshot, beyond the home page (signed out and as
 * every persona). `as` limits a page to some personas (by email); default is all of them.
 */
export interface ScreenshotPage {
  name: string;
  hash: string;
  as?: string[];
}

// List ids are hashes of the owner's email (listIdFor in api/model.ts); these are the demo's.
const NANA = 'a568b83327ec564d';
const OLIVE = 'b3b25e42c64aafb2';

export const screenshotPages: ScreenshotPage[] = [
  { name: 'nanas-list', hash: `#/l/${NANA}` },
  { name: 'own-list', hash: `#/l/${OLIVE}`, as: ['olive@demo.stacks'] },
  { name: 'claims', hash: '#/claims' },
];
