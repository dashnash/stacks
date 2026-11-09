import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { buildDefines } from './build-info';

export default defineConfig({
  plugins: [react()],
  // The deployed commit, for the footer's build link.
  define: buildDefines(),
  build: { outDir: 'dist', emptyOutDir: true },
  server: process.env.STACKS_API_PROXY ? { proxy: { '/api': { target: process.env.STACKS_API_PROXY, changeOrigin: true } } } : {},
});
