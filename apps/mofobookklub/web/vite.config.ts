import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { appSiteUrl, stacksLinkPreview } from '@stacks/web/vite';
import { defineConfig, type Plugin } from 'vite';

const appDir = fileURLToPath(new URL('..', import.meta.url));

/**
 * Link previews (iMessage, Slack, ...) need absolute URLs in og:image and og:url: the app's
 * production site (or DOMAIN_NAME when set). index.html has its own tags; stacksLinkPreview
 * adds only what it lacks.
 */
function siteUrl(): Plugin {
  const base = appSiteUrl(appDir);
  return { name: 'site-url', transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', base) };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), siteUrl(), stacksLinkPreview({ appDir })],
  build: { outDir: 'dist', emptyOutDir: true },
  // For local dev against a deployed copy: STACKS_API_PROXY=https://mofobookklub.test.dashnash.ninja
  server: process.env.STACKS_API_PROXY ? { proxy: { '/api': { target: process.env.STACKS_API_PROXY, changeOrigin: true, secure: true } } } : {},
});
