import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: process.env.STACKS_API_PROXY ? { proxy: { '/api': { target: process.env.STACKS_API_PROXY, changeOrigin: true } } } : {},
});
