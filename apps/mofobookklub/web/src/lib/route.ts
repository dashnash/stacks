import { useEffect, useState } from 'react';

/**
 * Hash routes, so the app works from any static host (and the single-file demo) with no
 * server rewrites. `#/book/<isbn>` is a book's page, `#/admin[/activity]` the admin page;
 * anything else (including in-page
 * anchors like `#shelf`) is the home page.
 */
export type AdminTab = 'members' | 'meeting' | 'activity';
export type Route =
  | { name: 'home'; anchor?: string }
  | { name: 'book'; isbn: string }
  | { name: 'admin'; tab: AdminTab };

export function parseRoute(hash: string): Route {
  const book = /^#\/book\/([\dXx-]+)\/?$/.exec(hash);
  if (book) return { name: 'book', isbn: book[1]! };
  const admin = /^#\/admin(?:\/(members|meeting|activity))?\/?$/.exec(hash);
  if (admin) return { name: 'admin', tab: (admin[1] as AdminTab | undefined) ?? 'members' };
  const anchor = hash.replace(/^#\/?/, '');
  return anchor ? { name: 'home', anchor } : { name: 'home' };
}

export const bookHref = (isbn: string) => `#/book/${isbn}`;
export const HOME_HREF = '#/';
export const adminHref = (tab: AdminTab = 'members') => (tab === 'members' ? '#/admin' : `#/admin/${tab}`);

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parseRoute(hash);
}
