import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Link previews (iMessage, Slack, ...) need absolute URLs in og:image and og:url. The deploy
 * passes the site's DOMAIN_NAME; without one (local builds) they fall back to relative paths.
 */
function siteUrl(): Plugin {
  const domain = process.env.DOMAIN_NAME?.trim();
  const base = domain ? `https://${domain}` : '';
  return { name: 'site-url', transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', base) };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), siteUrl()],
  build: { outDir: 'dist', emptyOutDir: true },
  // For local dev against a deployed copy: STACKS_API_PROXY=https://mofobookklub.test.iamdashnash.com
  server: process.env.STACKS_API_PROXY ? { proxy: { '/api': { target: process.env.STACKS_API_PROXY, changeOrigin: true, secure: true } } } : {},
});
