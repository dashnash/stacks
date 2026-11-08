import type { AppManifest, CspDirective } from '@stacks/manifest';

const DIRECTIVE_NAMES: Record<CspDirective, string> = {
  imgSrc: 'img-src',
  connectSrc: 'connect-src',
  scriptSrc: 'script-src',
  styleSrc: 'style-src',
  fontSrc: 'font-src',
  frameSrc: 'frame-src',
  mediaSrc: 'media-src',
};

/**
 * The platform's default policy (from Book Club's, without Google sign-in: apps never talk to
 * Google) plus the manifest's additions. The portal bar script is allowed from the auth origin.
 */
export function buildCsp(manifest: AppManifest, opts: { authOrigin: string }): string {
  const base: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", opts.authOrigin],
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https://lh3.googleusercontent.com'],
    // The platform: silent sign-in asks it from the page.
    'connect-src': ["'self'", opts.authOrigin],
    'frame-src': ["'none'"],
    'media-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  for (const [directive, sources] of Object.entries(manifest.csp ?? {}) as [CspDirective, string[]][]) {
    const name = DIRECTIVE_NAMES[directive];
    const current = base[name]!.filter((s) => s !== "'none'");
    base[name] = [...new Set([...current, ...sources])];
  }
  return Object.entries(base)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}
