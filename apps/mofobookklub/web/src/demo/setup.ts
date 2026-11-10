import type { DemoOptions } from '@stacks/demo';
import { manifest } from '../../../api/manifest';
import { routes } from '../../../api/routes';
import type { Deps } from '../../../api/utils/deps';
import { DemoBooks, DemoFaces, PERSONAS, seed } from './server';

/**
 * The app's UI and demo setup, in the shape every Stacks app exports from
 * `web/src/demo/setup.ts` (the demo build and the conformance test both use it).
 */
export { default as App } from '../App';

export const demoOptions = (): DemoOptions<Deps> => ({
  manifest,
  routes,
  extend: (base) => {
    // The demo ships no photos: critics get a silhouette until an admin adds faces (this tab only).
    const faces = new DemoFaces();
    return { ...base, books: new DemoBooks(), faces, signImageUrl: (key) => faces.signUrl(key), random: Math.random };
  },
  personas: PERSONAS.filter((p) => p.role !== 'PENDING').map((p) => ({ email: p.email, name: p.name, role: p.role, blurb: p.blurb })),
  pending: [
    ...PERSONAS.filter((p) => p.role === 'PENDING').map((p) => ({ email: p.email, name: p.name })),
    { email: 'riley@demo.bookklub', name: 'Riley Chen' },
  ],
  seed: (deps) => seed(deps.store),
  storageKey: 'bookklub.demo.v10',
});
