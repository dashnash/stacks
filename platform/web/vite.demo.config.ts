import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The portal with the real Platform API running in the browser on sample apps and people.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist-demo', emptyOutDir: true, rollupOptions: { input: 'demo.html' } },
});
