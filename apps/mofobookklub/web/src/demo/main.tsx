import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createDemo, DemoApp } from '@stacks/demo';
import { manifest } from '../../../api/manifest';
import { routes } from '../../../api/routes';
import type { Deps } from '../../../api/utils/deps';
import App from '../App';
import '../index.css';
import { DemoBooks, PERSONAS, seed } from './server';

const demo = createDemo<Deps>({
  manifest,
  routes,
  extend: (base) => ({
    ...base,
    books: new DemoBooks(),
    // The demo ships no photos: critics without their own picture get a silhouette.
    signImageUrl: async (key) => key,
    listFacePhotos: async () => [],
    random: Math.random,
  }),
  personas: PERSONAS.filter((p) => p.role !== 'PENDING').map((p) => ({ email: p.email, name: p.name, role: p.role, blurb: p.blurb })),
  pending: [
    ...PERSONAS.filter((p) => p.role === 'PENDING').map((p) => ({ email: p.email, name: p.name })),
    { email: 'riley@demo.bookklub', name: 'Riley Chen' },
  ],
  seed: (deps) => seed(deps.store),
  storageKey: 'bookklub.demo.v9',
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DemoApp demo={demo}>
      <App />
    </DemoApp>
  </StrictMode>,
);
