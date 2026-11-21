/**
 * Build-time helpers for an app's `web/vite.config.ts`. Plain JavaScript (types in vite.d.mts):
 * Vite loads its config with Node, which can't import TypeScript from a workspace package.
 *
 *   import { stacksLinkPreview } from '@stacks/web/vite';
 *   plugins: [react(), stacksLinkPreview()]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * `https://<slug>.<production root>` (from the repo's `stacks.config.json`), or `DOMAIN_NAME`
 * when set. One build serves staging and production, so staging's previews point at production
 * (a link preview only needs an absolute URL that answers).
 */
export function appSiteUrl(appDir, env = process.env) {
  const domain = env.DOMAIN_NAME?.trim();
  if (domain) return `https://${domain}`;
  const { slug } = readJson(join(appDir, 'app.manifest.json'));
  for (let dir = resolve(appDir); ; dir = dirname(dir)) {
    const file = join(dir, 'stacks.config.json');
    if (existsSync(file)) {
      const root = readJson(file).environments?.production?.rootDomain;
      return root ? `https://${slug}.${root}` : '';
    }
    if (dirname(dir) === dir) return '';
  }
}

const escape = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The `<meta>` tags for an app's link preview, skipping any `html` already has. */
export function linkPreviewTags(html, app, opts) {
  const has = (attr, key) => new RegExp(`<meta[^>]*\\s${attr}=["']${key.replace(/[.:]/g, '\\$&')}["']`, 'i').test(html);
  const summary = app.tagline?.trim() || app.description?.trim() || '';
  const tags = [];
  if (summary) tags.push(['name', 'description', summary]);
  tags.push(['property', 'og:type', 'website'], ['property', 'og:site_name', app.name], ['property', 'og:title', app.name]);
  if (summary) tags.push(['property', 'og:description', summary]);
  if (opts.base) {
    tags.push(['property', 'og:url', `${opts.base}/`]);
    if (opts.hasImage) tags.push(['property', 'og:image', `${opts.base}/og-image.png`], ['property', 'og:image:alt', app.name]);
  }
  tags.push(['name', 'twitter:card', opts.base && opts.hasImage ? 'summary_large_image' : 'summary']);
  return tags.filter(([attr, key]) => !has(attr, key)).map(([attr, key, content]) => `<meta ${attr}="${key}" content="${escape(content)}" />`);
}

/**
 * Link previews (iMessage, Slack, WhatsApp, ...) for every page of the app: its name and tagline
 * from `app.manifest.json`, and `web/public/og-image.png` when there is one. The same card for
 * every page, so a private app's link shows nothing of its content. Tags the page already has
 * are kept as they are.
 */
export function stacksLinkPreview(opts = {}) {
  let webDir = process.cwd();
  return {
    name: 'stacks-link-preview',
    configResolved(config) {
      webDir = config.root;
    },
    transformIndexHtml(html) {
      const appDir = opts.appDir ?? resolve(webDir, '..');
      const manifest = readJson(join(appDir, 'app.manifest.json'));
      const base = opts.domain !== undefined ? (opts.domain.trim() ? `https://${opts.domain.trim()}` : '') : appSiteUrl(appDir);
      const tags = linkPreviewTags(html, manifest, { base, hasImage: existsSync(join(appDir, 'web', 'public', 'og-image.png')) });
      if (!tags.length) return html;
      return html.replace(/<\/head>/i, `    ${tags.join('\n    ')}\n  </head>`);
    },
  };
}
