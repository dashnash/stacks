import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The credential-free demo: the real UI and the real API running in the browser on sample data.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  base: './',
  build: { outDir: 'dist-demo', emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('demo.html', import.meta.url)) } },
  server: { open: '/demo.html' },
});
