import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { stacksLinkPreview } from '@stacks/web/vite';
import { defineConfig } from 'vite';

// The real app. `npm run dev` proxies /api to a deployed copy when STACKS_API_PROXY is set.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Link previews (iMessage, Slack, ...): the app's name and tagline from app.manifest.json.
  plugins: [react(), stacksLinkPreview()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: process.env.STACKS_API_PROXY ? { proxy: { '/api': { target: process.env.STACKS_API_PROXY, changeOrigin: true } } } : {},
});
