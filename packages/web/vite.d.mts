/** The part of a Vite plugin this uses (structural, so this package needs no Vite types). */
export interface LinkPreviewPlugin {
  name: string;
  configResolved(config: { root: string }): void;
  transformIndexHtml(html: string): string;
}

export interface LinkPreviewOptions {
  /** The app's folder (holding `app.manifest.json`). Default: the parent of Vite's root (`apps/<slug>/web`). */
  appDir?: string;
  /** The site's host for absolute URLs ("" for none). Default: `appSiteUrl`'s. */
  domain?: string;
}

export function appSiteUrl(appDir: string, env?: Record<string, string | undefined>): string;
export function linkPreviewTags(html: string, app: { name: string; tagline?: string; description?: string }, opts: { base: string; hasImage: boolean }): string[];
export function stacksLinkPreview(opts?: LinkPreviewOptions): LinkPreviewPlugin;
