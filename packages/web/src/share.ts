import { useCallback, useEffect } from 'react';
import { native as pageNative, NativeError, type Native, type PageShareTarget } from '@stacks/native';

/** A link to share: `url` may be relative (`#/book/1/comment/c1`); title and text are optional. */
export interface ShareTarget {
  url?: string;
  title?: string;
  text?: string;
}

/** `url` made absolute against the page (`#/x` → `https://app.example/#/x`). */
export function absoluteUrl(url: string, base: string = window.location.href): string {
  return new URL(url, base).href;
}

/**
 * What the app's own Share button (DashyHQ, bottom right) shares while this component is mounted:
 * `{ url?, title?, text? }` changes it (defaults: the page's URL and title), `null` hides the
 * button. Unmounting goes back to the default. Outside the app, or in an older app, nothing happens.
 *
 * The setting is for the URL the page is on: it is sent again after a hash change or back/forward.
 * After a `history.pushState` of your own, remount the component (or change a dependency).
 */
export function useShareTarget(target: ShareTarget | null, opts: { native?: Native } = {}): void {
  const n = opts.native ?? pageNative;
  const hidden = target === null;
  const url = target?.url;
  const title = target?.title;
  const text = target?.text;
  useEffect(() => {
    if (!n.has('share.page')) return;
    // A hash route fires both popstate and hashchange: send once per URL.
    let sentFor: string | null = null;
    const send = () => {
      if (sentFor === window.location.href) return;
      sentFor = window.location.href;
      const t: PageShareTarget = hidden ? { hidden: true } : { url: url === undefined ? undefined : absoluteUrl(url), title, text };
      // A refusal (say an http link in local dev) only leaves the default in place.
      n.setPageShare(t).catch(() => {});
    };
    send();
    window.addEventListener('hashchange', send);
    window.addEventListener('popstate', send);
    return () => {
      window.removeEventListener('hashchange', send);
      window.removeEventListener('popstate', send);
      n.setPageShare(null).catch(() => {});
    };
  }, [n, hidden, url, title, text]);
}

export interface ShareHandle {
  /** There's a share sheet here: the app, or a browser with `navigator.share`. Render share buttons only then. */
  available: boolean;
  /** Opens the share sheet. True when shared, false when the person backed out; other failures throw `NativeError`. */
  share(target: ShareTarget): Promise<boolean>;
}

/** Share something of your app's own (a comment, an item): `share({ url: '#/items/7', title })`. */
export function useShare(opts: { native?: Native } = {}): ShareHandle {
  const n = opts.native ?? pageNative;
  const share = useCallback(
    async ({ url, title, text }: ShareTarget) => {
      try {
        const { completed } = await n.share({ url: url === undefined ? undefined : absoluteUrl(url), title, text });
        return completed;
      } catch (err) {
        if (err instanceof NativeError && err.code === 'cancelled') return false;
        throw err;
      }
    },
    [n],
  );
  return { available: n.canShare, share };
}
