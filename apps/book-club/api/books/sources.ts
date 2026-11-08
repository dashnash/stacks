import type { BookCandidate, BookSource, CoverCandidate, Edition } from '../utils/deps.js';
import type { Book } from '../utils/model.js';
import { imageDimensions } from './image-size.js';
import { normalizeIsbn } from './isbn.js';

type Fetch = typeof fetch;

/** Open Library serves a tiny 1x1 GIF when a cover is missing; anything this small is not a real cover. */
export const MIN_COVER_BYTES = 1000;
/** Covers at least this wide are sharp on the meeting poster, so we stop looking for a bigger one. */
export const HI_RES_COVER_WIDTH = 600;
const TIMEOUT_MS = 5000;

/** A cover image we downloaded and measured. */
export interface MeasuredCover {
  url: string;
  /** Pixel width, or 0 if the format couldn't be measured. */
  width: number;
}

export interface ExternalBookSourceOptions {
  fetch?: Fetch;
  googleApiKey?: string;
}

/**
 * Book metadata from Open Library, falling back to Google Books when Open
 * Library has no usable cover or is missing metadata (see TRD section 4).
 */
export function createExternalBookSource(opts: ExternalBookSourceOptions = {}): BookSource {
  const doFetch: Fetch = opts.fetch ?? fetch;
  const googleKey = opts.googleApiKey ? `&key=${encodeURIComponent(opts.googleApiKey)}` : '';

  async function getJson<T>(url: string): Promise<T | null> {
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  /** Download an image and measure it. Missing images and placeholders (tiny files) give undefined. */
  async function measure(fetchUrl: string, publicUrl = fetchUrl): Promise<MeasuredCover | undefined> {
    try {
      const res = await doFetch(fetchUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return undefined;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength < MIN_COVER_BYTES) return undefined;
      return { url: publicUrl, width: imageDimensions(bytes)?.width ?? 0 };
    } catch {
      return undefined;
    }
  }

  /** The widest of several candidate covers, measured in parallel. Missing/placeholder images drop out. */
  async function widest(candidates: { fetchUrl: string; publicUrl?: string }[]): Promise<MeasuredCover | undefined> {
    const unique = [...new Map(candidates.map((c) => [c.publicUrl ?? c.fetchUrl, c])).values()];
    const measured = await Promise.all(unique.map((c) => measure(c.fetchUrl, c.publicUrl)));
    return measured
      .filter((m): m is MeasuredCover => !!m)
      .sort((a, b) => b.width - a.width)[0];
  }

  /**
   * Open Library cover candidates for an ISBN. Covers are often attached to another
   * edition or to the work rather than this exact ISBN, so besides the by-ISBN image this
   * reads the edition record and, when the edition has none, its work's covers.
   */
  async function openLibraryCandidates(isbn: string, maxIds = 2) {
    const olIsbnUrl = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
    const candidates = [{ fetchUrl: `${olIsbnUrl}?default=false`, publicUrl: olIsbnUrl }];

    const edition = await getJson<{ covers?: number[]; works?: { key: string }[] }>(`https://openlibrary.org/isbn/${isbn}.json`);
    let ids = (edition?.covers ?? []).filter((id) => id > 0);
    const workKey = edition?.works?.[0]?.key;
    if (ids.length === 0 && workKey) {
      const work = await getJson<{ covers?: number[] }>(`https://openlibrary.org${workKey}.json`);
      ids = (work?.covers ?? []).filter((id) => id > 0);
    }
    for (const id of ids.slice(0, maxIds)) {
      const url = `https://covers.openlibrary.org/b/id/${id}-L.jpg`;
      candidates.push({ fetchUrl: `${url}?default=false`, publicUrl: url });
    }
    return candidates;
  }

  /**
   * Google Books cover candidates for a volume. Search results only carry thumbnails, so this
   * asks the volume endpoint for large/extraLarge links, and also requests the thumbnail at
   * 800px wide (Google's image server resizes on request).
   */
  async function googleCandidates(volumeId: string | undefined, searchLinks?: Record<string, string>) {
    const detail = volumeId
      ? await getJson<{ volumeInfo?: { imageLinks?: Record<string, string> } }>(
          `https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(volumeId)}${googleKey ? `?${googleKey.slice(1)}` : ''}`,
        )
      : null;
    const links = { ...searchLinks, ...detail?.volumeInfo?.imageLinks };
    const urls = ['extraLarge', 'large', 'medium', 'small', 'thumbnail']
      .map((size) => links[size] && cleanGoogleUrl(links[size]))
      .filter((u): u is string => !!u);
    const thumb = links.thumbnail ? cleanGoogleUrl(links.thumbnail) : undefined;
    if (thumb) urls.push(`${thumb}&fife=w800`);
    return urls.map((fetchUrl) => ({ fetchUrl }));
  }

  async function openLibraryMetadata(isbn: string): Promise<Partial<Book>> {
    type OlData = Record<
      string,
      {
        title?: string;
        authors?: { name: string }[];
        publishers?: { name: string }[];
        publish_date?: string;
        number_of_pages?: number;
        subjects?: { name: string }[];
      }
    >;
    const data = await getJson<OlData>(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
    );
    const entry = data?.[`ISBN:${isbn}`];
    if (!entry?.title) return {};
    return {
      title: entry.title,
      author: entry.authors?.map((a) => a.name).join(', ') || undefined,
      publisher: entry.publishers?.[0]?.name,
      publishedDate: entry.publish_date,
      pageCount: entry.number_of_pages || undefined,
      subjects: tidySubjects(entry.subjects?.map((x) => x.name)),
    };
  }

  type GoogleHit = {
    id?: string;
    imageLinks?: Record<string, string>;
    title?: string;
    author?: string;
    description?: string;
    publisher?: string;
    publishedDate?: string;
    pageCount?: number;
    categories?: string[];
  };

  async function googleVolumes(q: string, maxResults = 1): Promise<GoogleHit[]> {
    const data = await getJson<GoogleVolumes>(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${maxResults}${googleKey}`,
    );
    return (data?.items ?? []).map((item) => ({
      id: item.id,
      imageLinks: item.volumeInfo.imageLinks,
      title: item.volumeInfo.title,
      author: item.volumeInfo.authors?.join(', '),
      description: item.volumeInfo.description,
      publisher: item.volumeInfo.publisher,
      publishedDate: item.volumeInfo.publishedDate,
      pageCount: item.volumeInfo.pageCount || undefined,
      categories: item.volumeInfo.categories,
    }));
  }

  /**
   * Google's record for an ISBN, plus (when that edition has no cover) another edition of
   * the same title and author that does.
   */
  async function googleBooks(isbn: string, title?: string, author?: string, allEditions = false) {
    const [byIsbn] = await googleVolumes(`isbn:${isbn}`);
    let coverHit = byIsbn?.imageLinks ? byIsbn : undefined;
    const t = title ?? byIsbn?.title;
    const a = author ?? byIsbn?.author;
    let others: GoogleHit[] = [];
    if ((!coverHit || allEditions) && t) {
      others = await googleVolumes(`intitle:"${t}"${a ? ` inauthor:"${a.split(',')[0]}"` : ''}`, 5);
      coverHit ??= others.find((h) => h.imageLinks);
    }
    return { meta: byIsbn, coverHit, hits: [...(byIsbn ? [byIsbn] : []), ...others] };
  }

  const fromGoogle = (g: GoogleHit): Partial<Book> =>
    defined({
      title: g.title,
      author: g.author,
      description: g.description,
      publisher: g.publisher,
      publishedDate: g.publishedDate,
      pageCount: g.pageCount,
      subjects: tidySubjects(g.categories),
    });

  return {
    async lookupIsbn(input) {
      const isbn = normalizeIsbn(input);
      if (!isbn) return null;

      const [ol, olCandidates] = await Promise.all([openLibraryMetadata(isbn), openLibraryCandidates(isbn)]);
      let cover = await widest(olCandidates);
      let meta: Partial<Book> = ol;

      // Google fills missing metadata, and is asked for a sharper cover when Open Library's is small.
      const coverTooSmall = !cover || cover.width < HI_RES_COVER_WIDTH;
      const missing = DETAIL_FIELDS.some((f) => meta[f] === undefined);
      if (coverTooSmall || missing) {
        const google = await googleBooks(isbn, meta.title, meta.author);
        if (google.meta) meta = { ...fromGoogle(google.meta), ...defined(meta) };
        if (coverTooSmall && google.coverHit) {
          const googleCover = await widest(await googleCandidates(google.coverHit.id, google.coverHit.imageLinks));
          if (googleCover && (!cover || googleCover.width > cover.width)) cover = googleCover;
        }
      }

      if (!meta.title) return null;
      return {
        ...defined({
          publisher: meta.publisher,
          publishedDate: meta.publishedDate,
          pageCount: meta.pageCount,
          subjects: meta.subjects,
          description: meta.description,
        }),
        isbn,
        title: meta.title,
        author: meta.author ?? 'Unknown author',
        coverUrl: cover?.url,
        coverWidth: cover?.width || undefined,
      };
    },

    async coverCandidates(input, title, author) {
      const isbn = normalizeIsbn(input);
      if (!isbn) return [];
      const [olCandidates, google] = await Promise.all([openLibraryCandidates(isbn, 4), googleBooks(isbn, title, author, true)]);
      const googleHits = google.hits.filter((h) => h.imageLinks).slice(0, 4);
      const [ol, ...fromGoogle] = await Promise.all([
        Promise.all(olCandidates.map((c) => measure(c.fetchUrl, c.publicUrl))),
        // Google lists several sizes of the same image per volume; keep the widest of each.
        ...googleHits.map(async (h) => [await widest(await googleCandidates(h.id, h.imageLinks))]),
      ]);
      const found: CoverCandidate[] = [
        ...ol.filter((m): m is MeasuredCover => !!m).map((m) => ({ ...m, source: 'Open Library' })),
        ...fromGoogle.flat().filter((m): m is MeasuredCover => !!m).map((m) => ({ ...m, source: 'Google Books' })),
      ];
      const unique = [...new Map(found.map((c) => [c.url, c])).values()];
      return unique.sort((a, b) => b.width - a.width);
    },

    async searchEditions(query) {
      const q = encodeURIComponent(query.trim());
      if (!q) return [];
      type OlDocs = {
        docs?: {
          title?: string;
          author_name?: string[];
          isbn?: string[];
          cover_i?: number;
          publisher?: string[];
          first_publish_year?: number;
          number_of_pages_median?: number;
          subject?: string[];
        }[];
      };
      const [ol, google] = await Promise.all([
        getJson<OlDocs>(
          `https://openlibrary.org/search.json?q=${q}&limit=8&fields=title,author_name,isbn,cover_i,publisher,first_publish_year,number_of_pages_median,subject`,
        ),
        getJson<GoogleVolumes>(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=8${googleKey}`),
      ]);
      const editions: (Edition & { fetchUrl?: string })[] = [];
      for (const doc of ol?.docs ?? []) {
        if (!doc.title) continue;
        const coverUrl = doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : undefined;
        editions.push({
          title: doc.title,
          author: doc.author_name?.join(', ') ?? 'Unknown author',
          isbn: pickIsbn(doc.isbn ?? []),
          coverUrl,
          fetchUrl: coverUrl && `${coverUrl}?default=false`,
          publisher: doc.publisher?.[0],
          publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : undefined,
          pageCount: doc.number_of_pages_median || undefined,
          subjects: tidySubjects(doc.subject),
          source: 'Open Library',
        });
      }
      for (const item of google?.items ?? []) {
        const info = item.volumeInfo;
        if (!info.title) continue;
        const thumb = info.imageLinks?.thumbnail ? cleanGoogleUrl(info.imageLinks.thumbnail) : undefined;
        // Google's image server resizes on request: ask for a cover wide enough for the poster.
        const coverUrl = thumb ? `${thumb}&fife=w800` : googleCover(info.imageLinks);
        editions.push({
          title: info.title,
          author: info.authors?.join(', ') ?? 'Unknown author',
          isbn: pickIsbn((info.industryIdentifiers ?? []).map((id) => id.identifier)),
          coverUrl,
          publisher: info.publisher,
          publishedDate: info.publishedDate,
          pageCount: info.pageCount || undefined,
          description: info.description,
          subjects: tidySubjects(info.categories),
          source: 'Google Books',
        });
      }
      // Measure the covers (in parallel); drop images that turn out to be missing placeholders.
      const measured = await Promise.all(
        editions.map((e) => (e.coverUrl ? measure(e.fetchUrl ?? e.coverUrl, e.coverUrl) : Promise.resolve(undefined))),
      );
      return editions.map(({ fetchUrl: _f, ...e }, i) => {
        const m = measured[i];
        const out: Edition = m ? { ...e, coverWidth: m.width } : { ...e, coverUrl: undefined };
        return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Edition;
      });
    },

    async search(query) {
      const q = encodeURIComponent(query.trim());
      type OlSearch = {
        docs?: {
          title?: string;
          author_name?: string[];
          isbn?: string[];
          cover_i?: number;
          cover_edition_key?: string;
          first_publish_year?: number;
        }[];
      };
      // Ask both at once: Open Library leads, Google fills covers it lacks and adds books it missed.
      const [ol, google] = await Promise.all([
        getJson<OlSearch>(
          `https://openlibrary.org/search.json?q=${q}&limit=10&fields=title,author_name,isbn,cover_i,cover_edition_key,first_publish_year`,
        ),
        getJson<GoogleVolumes>(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=10${googleKey}`),
      ]);

      const fromGoogle: BookCandidate[] = [];
      for (const item of google?.items ?? []) {
        const info = item.volumeInfo;
        const isbn = pickIsbn((info.industryIdentifiers ?? []).map((id) => id.identifier));
        if (!isbn || !info.title) continue;
        const year = Number.parseInt(info.publishedDate ?? '', 10);
        fromGoogle.push({
          isbn,
          title: info.title,
          author: info.authors?.join(', ') ?? 'Unknown author',
          coverUrl: googleCover(info.imageLinks),
          year: Number.isNaN(year) ? undefined : year,
        });
      }
      const googleByIsbn = new Map(fromGoogle.map((g) => [g.isbn, g]));
      const googleByTitle = new Map(fromGoogle.filter((g) => g.coverUrl).map((g) => [g.title.toLowerCase(), g]));

      const fromOl: BookCandidate[] = [];
      for (const doc of ol?.docs ?? []) {
        const isbn = pickIsbn(doc.isbn ?? []);
        if (!isbn || !doc.title) continue;
        const coverUrl = doc.cover_i
          ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
          : doc.cover_edition_key
            ? `https://covers.openlibrary.org/b/olid/${doc.cover_edition_key}-M.jpg`
            : (googleByIsbn.get(isbn)?.coverUrl ?? googleByTitle.get(doc.title.toLowerCase())?.coverUrl);
        fromOl.push({
          isbn,
          title: doc.title,
          author: doc.author_name?.join(', ') ?? 'Unknown author',
          coverUrl,
          year: doc.first_publish_year,
        });
      }
      return dedupe([...fromOl, ...fromGoogle]).slice(0, 12);
    },
  };
}

interface GoogleVolumes {
  items?: {
    id?: string;
    volumeInfo: {
      title?: string;
      authors?: string[];
      description?: string;
      publisher?: string;
      publishedDate?: string;
      pageCount?: number;
      categories?: string[];
      industryIdentifiers?: { type: string; identifier: string }[];
      imageLinks?: Record<string, string>;
    };
  }[];
}

/** Google Books image links: force HTTPS and drop the fake page-curl effect. */
export function cleanGoogleUrl(url: string): string {
  return url.replace(/^http:/, 'https:').replace('&edge=curl', '');
}

/** Pick the largest Google Books image link (used for search-result thumbnails). */
export function googleCover(links?: Record<string, string>): string | undefined {
  if (!links) return undefined;
  const url =
    links.extraLarge ?? links.large ?? links.medium ?? links.small ?? links.thumbnail ?? links.smallThumbnail;
  return url ? cleanGoogleUrl(url) : undefined;
}

/** Prefer a valid ISBN-13; otherwise convert the first valid ISBN-10. */
function pickIsbn(candidates: string[]): string | undefined {
  const normalized = candidates.map((c) => normalizeIsbn(c)).filter((c): c is string => c !== null);
  return normalized.find((c) => c.startsWith('978') || c.startsWith('979')) ?? normalized[0];
}

function dedupe(candidates: BookCandidate[]): BookCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) => (seen.has(c.isbn) ? false : (seen.add(c.isbn), true)));
}

/** The details lookups fill in; when any is missing after Open Library, Google is asked too. */
const DETAIL_FIELDS = ['title', 'author', 'description', 'publisher', 'publishedDate', 'pageCount'] as const;

/** Drop undefined values, so spreading one object over another only overrides what it has. */
function defined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

/** A few distinct, readable subjects (Open Library lists dozens, many of them catalog codes). */
export function tidySubjects(subjects?: string[]): string[] | undefined {
  if (!subjects?.length) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of subjects) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || name.length > 40 || /[=:]|\d{3}/.test(name) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length === 5) break;
  }
  return out.length ? out : undefined;
}
