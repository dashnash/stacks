import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, render, renderHook } from '@testing-library/react';
import { getNative, installFakeNative, NativeError } from '@stacks/native';
import { afterEach, describe, expect, it } from 'vitest';
import { absoluteUrl, useShare, useShareTarget } from '../src/index';
import { appSiteUrl, linkPreviewTags, stacksLinkPreview } from '../vite.mjs';

const fakeApp = (handlers: Parameters<typeof installFakeNative>[0]) => {
  const g = globalThis as unknown as Record<string, unknown>;
  const fake = installFakeNative(handlers, g as never);
  // The fake lives on the page's own window, like the app's injected bridge.
  return { fake, n: getNative(g as never) };
};

let remove: (() => void) | undefined;
afterEach(() => {
  remove?.();
  remove = undefined;
  window.history.replaceState(null, '', '/');
});

const flush = () => act(async () => {});

describe('useShareTarget', () => {
  it('sets what the Share button shares while mounted, again after a hash change, and clears it on unmount', async () => {
    const { fake, n } = fakeApp({ share: () => ({ completed: true }), 'share.page': () => ({}) });
    remove = fake.remove;
    window.location.hash = '#/book/1';
    function Page({ title }: { title: string }) {
      useShareTarget({ url: '#/book/1', title }, { native: n });
      return null;
    }
    const view = render(<Page title="One" />);
    await flush();
    view.rerender(<Page title="Uno" />);
    await flush();
    await act(async () => {
      window.location.hash = '#/book/1?x'; // jsdom fires hashchange on its own, a task later
      await new Promise((r) => setTimeout(r, 10));
    });
    view.unmount();
    await flush();
    const page = (h: string) => `${window.location.origin}/${h}`;
    expect(fake.log.map((l) => l.args)).toEqual([
      { page: page('#/book/1'), url: page('#/book/1'), title: 'One' },
      { page: page('#/book/1') },
      { page: page('#/book/1'), url: page('#/book/1'), title: 'Uno' },
      { page: page('#/book/1?x'), url: page('#/book/1'), title: 'Uno' },
      { page: page('#/book/1?x') },
    ]);
  });

  it('hides the button with null', async () => {
    const { fake, n } = fakeApp({ 'share.page': () => ({}) });
    remove = fake.remove;
    renderHook(() => useShareTarget(null, { native: n }));
    await flush();
    expect(fake.log[0]!.args).toEqual({ page: window.location.href, hidden: true });
  });

  it('does nothing in a browser or an app without the button', async () => {
    const { fake, n } = fakeApp({ share: () => ({ completed: true }) });
    remove = fake.remove;
    renderHook(() => useShareTarget(null, { native: n }));
    await flush();
    expect(fake.log).toEqual([]);
    expect(() => renderHook(() => useShareTarget({ title: 'x' }, { native: getNative({} as never) }))).not.toThrow();
  });
});

describe('useShare', () => {
  it('shares absolute links through the app and treats backing out as not shared', async () => {
    let answer: 'ok' | 'cancel' | 'fail' = 'ok';
    const { fake, n } = fakeApp({
      share: () => {
        if (answer === 'cancel') throw new NativeError('cancelled', 'Share was cancelled');
        if (answer === 'fail') throw new NativeError('failed', 'Nope');
        return { completed: true };
      },
    });
    remove = fake.remove;
    const { result } = renderHook(() => useShare({ native: n }));
    expect(result.current.available).toBe(true);
    await expect(result.current.share({ url: '#/book/1/comment/c1', title: 'A comment' })).resolves.toBe(true);
    expect(fake.log[0]!.args).toMatchObject({ url: `${window.location.origin}/#/book/1/comment/c1`, title: 'A comment' });
    answer = 'cancel';
    await expect(result.current.share({ url: '#/x' })).resolves.toBe(false);
    answer = 'fail';
    await expect(result.current.share({ url: '#/x' })).rejects.toMatchObject({ code: 'failed' });
  });

  it('is unavailable on a desktop browser without navigator.share', () => {
    const { result } = renderHook(() => useShare({ native: getNative({ navigator: {} } as never) }));
    expect(result.current.available).toBe(false);
  });

  it('makes links absolute against the page', () => {
    expect(absoluteUrl('#/a', 'https://hello.dashnash.ninja/#/b')).toBe('https://hello.dashnash.ninja/#/a');
    expect(absoluteUrl('https://x.example/y', 'https://hello.dashnash.ninja/')).toBe('https://x.example/y');
  });
});

describe('stacksLinkPreview', () => {
  const app = { name: 'Hello <Board>', tagline: 'Say "hi".', description: 'Longer.' };
  const html = '<html><head><title>Hello</title></head><body></body></html>';

  it('adds the app card with absolute URLs when it knows the domain', () => {
    const tags = linkPreviewTags(html, app, { base: 'https://hello.dashnash.ninja', hasImage: true });
    expect(tags).toEqual([
      '<meta name="description" content="Say &quot;hi&quot;." />',
      '<meta property="og:type" content="website" />',
      '<meta property="og:site_name" content="Hello &lt;Board&gt;" />',
      '<meta property="og:title" content="Hello &lt;Board&gt;" />',
      '<meta property="og:description" content="Say &quot;hi&quot;." />',
      '<meta property="og:url" content="https://hello.dashnash.ninja/" />',
      '<meta property="og:image" content="https://hello.dashnash.ninja/og-image.png" />',
      '<meta property="og:image:alt" content="Hello &lt;Board&gt;" />',
      '<meta name="twitter:card" content="summary_large_image" />',
    ]);
  });

  it('leaves out URLs in local builds and the image when there is none, and keeps tags the page has', () => {
    const own = '<head><meta property="og:title" content="Mine" /><meta name="description" content="Mine" /></head>';
    const tags = linkPreviewTags(own, app, { base: '', hasImage: true });
    expect(tags.join('\n')).not.toMatch(/og:url|og:image|og:title|name="description"/);
    expect(tags).toContain('<meta name="twitter:card" content="summary" />');
    expect(linkPreviewTags(html, app, { base: 'https://h', hasImage: false }).join('\n')).not.toMatch(/og:image/);
  });

  it('reads the manifest next to the web folder and writes the tags into the head', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'preview-'));
    mkdirSync(join(appDir, 'web', 'public'), { recursive: true });
    writeFileSync(join(appDir, 'app.manifest.json'), JSON.stringify({ name: 'Pantry', tagline: 'What we have.' }));
    writeFileSync(join(appDir, 'web', 'public', 'og-image.png'), '');
    const plugin = stacksLinkPreview({ domain: 'pantry.dashnash.ninja' });
    plugin.configResolved({ root: join(appDir, 'web') });
    const out = plugin.transformIndexHtml(html);
    expect(out).toContain('<meta property="og:title" content="Pantry" />');
    expect(out).toContain('<meta property="og:image" content="https://pantry.dashnash.ninja/og-image.png" />');
    expect(out.indexOf('og:title')).toBeLessThan(out.indexOf('</head>'));
    // Nothing to add: unchanged.
    expect(plugin.transformIndexHtml(out)).toBe(out);
  });

  it("points at the app's production site unless DOMAIN_NAME says otherwise", () => {
    const repo = mkdtempSync(join(tmpdir(), 'repo-'));
    const appDir = join(repo, 'apps', 'pantry');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(repo, 'stacks.config.json'), JSON.stringify({ environments: { production: { rootDomain: 'dashnash.ninja' } } }));
    writeFileSync(join(appDir, 'app.manifest.json'), JSON.stringify({ slug: 'pantry', name: 'Pantry' }));
    expect(appSiteUrl(appDir, {})).toBe('https://pantry.dashnash.ninja');
    expect(appSiteUrl(appDir, { DOMAIN_NAME: 'pantry.test.dashnash.ninja' })).toBe('https://pantry.test.dashnash.ninja');
    const lone = mkdtempSync(join(tmpdir(), 'lone-'));
    writeFileSync(join(lone, 'app.manifest.json'), JSON.stringify({ slug: 'x', name: 'X' }));
    expect(appSiteUrl(lone, {})).toBe('');
  });
});
