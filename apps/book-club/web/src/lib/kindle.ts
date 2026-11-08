/**
 * Kindle books can't be bought in Amazon's phone app, only on the website. But on a phone with
 * the app installed, tapping an amazon.com link opens the app (iOS universal links), even from a
 * script redirect. Amazon's own apple-app-site-association file leaves out links marked "no deep
 * link": a `nodl=1` query parameter, or a `ref=nodl_…` path segment. This link carries both, so
 * the phone keeps it in the browser.
 */

/** The Kindle Store search for a book, by title and author (its Kindle edition has its own id, not the ISBN). */
export function kindleBuyUrl(book: { title: string; author?: string }): string {
  const terms = [book.title, book.author].filter((s) => s && s.trim()).join(' ');
  return `https://www.amazon.com/s/ref=nodl_kindle?k=${encodeURIComponent(terms)}&i=digital-text&nodl=1`;
}
