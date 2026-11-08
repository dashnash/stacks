import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { buildDefines } from './build-info';

/** The credential-free demo: the real UI and real API in the browser on sample data (no photos). */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  base: './',
  // Mock book covers for the sample catalog (generated, no real artwork). Demo build only.
  publicDir: fileURLToPath(new URL('demo-public', import.meta.url)),
  define: buildDefines(),
  build: { outDir: 'dist-demo', emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('demo.html', import.meta.url)) } },
  server: { open: '/demo.html' },
});
