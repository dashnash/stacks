import { describe, expect, it } from 'vitest';
import { createExternalBookSource, googleCover } from '../../../api/books/sources.js';

type Responder = (url: string) => Response | undefined;

function fakeFetch(responder: Responder) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = input.toString();
    calls.push(url);
    return responder(url) ?? new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

const jsonRes = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A minimal JPEG whose header declares the given size, padded to look like a real file. */
function jpeg(width: number, height: number, bytes = 4000): Uint8Array<ArrayBuffer> {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const out = new Uint8Array(bytes);
  out.set([...head, ...sof]);
  return out;
}
const imageRes = (width: number, height = Math.round(width * 1.5), bytes?: number) =>
  new Response(jpeg(width, height, bytes), { status: 200 });

const ISBN = '9780593135204';
const OL_COVER = `https://covers.openlibrary.org/b/isbn/${ISBN}-L.jpg`;
const olData = {
  [`ISBN:${ISBN}`]: { title: 'Project Hail Mary', authors: [{ name: 'Andy Weir' }] },
};
const googleSearch = {
  items: [
    {
      id: 'vol123',
      volumeInfo: {
        title: 'Project Hail Mary',
        authors: ['Andy Weir'],
        description: 'A lone astronaut must save the earth.',
        imageLinks: { thumbnail: 'http://books.google.com/books/content?id=vol123&zoom=1&edge=curl' },
      },
    },
  ],
};
const googleVolume = {
  volumeInfo: {
    imageLinks: {
      thumbnail: 'http://books.google.com/books/content?id=vol123&zoom=1&edge=curl',
      extraLarge: 'http://books.google.com/books/content?id=vol123&zoom=6&edge=curl',
    },
  },
};

describe('createExternalBookSource.lookupIsbn', () => {
  it('keeps a high-resolution Open Library cover without asking Google for one', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes('openlibrary.org/api/books')) return jsonRes(olData);
      if (url.includes('covers.openlibrary.org')) return imageRes(800);
      if (url.includes('volumes?q=')) return jsonRes(googleSearch);
    });
    const book = await createExternalBookSource({ fetch: fn }).lookupIsbn(ISBN);
    expect(book).toEqual({
      isbn: ISBN,
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      coverUrl: OL_COVER,
      coverWidth: 800,
      // Open Library's data API has no description, so it is filled from Google Books.
      description: 'A lone astronaut must save the earth.',
    });
    // Metadata came from the Google search, but no Google cover was needed.
    expect(calls.some((c) => c.includes('/volumes/vol123') || c.includes('books.google.com'))).toBe(false);
  });

  it("swaps a small Open Library cover for Google's extra-large one", async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes('openlibrary.org/api/books')) return jsonRes(olData);
      if (url.includes('covers.openlibrary.org')) return imageRes(320);
      if (url.includes('volumes?q=')) return jsonRes(googleSearch);
      if (url.includes('/volumes/vol123')) return jsonRes(googleVolume);
      if (url.includes('zoom=6')) return imageRes(1280);
    });
    const book = await createExternalBookSource({ fetch: fn }).lookupIsbn(ISBN);
    expect(book?.coverUrl).toBe('https://books.google.com/books/content?id=vol123&zoom=6');
    expect(book?.coverWidth).toBe(1280);
    expect(calls).toContain('https://books.google.com/books/content?id=vol123&zoom=6');
  });

  it("keeps Open Library's cover when Google's best is smaller", async () => {
    const { fn } = fakeFetch((url) => {
      if (url.includes('openlibrary.org/api/books')) return jsonRes(olData);
      if (url.includes('covers.openlibrary.org')) return imageRes(400);
      if (url.includes('volumes?q=')) return jsonRes(googleSearch);
      if (url.includes('/volumes/vol123')) return jsonRes({ volumeInfo: { imageLinks: googleSearch.items[0]!.volumeInfo.imageLinks } });
      if (url.includes('books.google.com')) return imageRes(128);
    });
    const book = await createExternalBookSource({ fetch: fn }).lookupIsbn(ISBN);
    expect(book).toMatchObject({ coverUrl: OL_COVER, coverWidth: 400 });
  });

  it('falls back to Google Books when Open Library returns the 1x1 placeholder', async () => {
    const { fn } = fakeFetch((url) => {
      if (url.includes('openlibrary.org/api/books')) return jsonRes(olData);
      if (url.includes('covers.openlibrary.org')) return imageRes(1, 1, 43);
      if (url.includes('volumes?q=')) return jsonRes(googleSearch);
      if (url.includes('/volumes/vol123')) return jsonRes(googleVolume);
      if (url.includes('zoom=6')) return imageRes(900);
    });
    const book = await createExternalBookSource({ fetch: fn }).lookupIsbn(ISBN);
    expect(book).toMatchObject({ coverUrl: 'https://books.google.com/books/content?id=vol123&zoom=6', coverWidth: 900 });
  });

  it('falls back to Google Books when the Open Library cover 404s', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes('openlibrary.org/api/books')) return jsonRes({});
      if (url.includes('volumes?q=')) return jsonRes(googleSearch);
    });
    const book = await createExternalBookSource({ fetch: fn }).lookupIsbn(ISBN);
    expect(book?.title).toBe('Project Hail Mary');
    expect(calls.some((c) => c.includes('default=false'))).toBe(true);
  });

  it("finds Open Library's cover through the edition record when the by-ISBN image is missing", async () => {
    const { fn } = fakeFetch((url) => {
      if (url.includes('openlibrary.org/api/books')) return jsonRes(olData);
      if (url === `https://openlibrary.org/isbn/${ISBN}.json`) return jsonRes({ covers: [-1, 8765], works: [{ key: '/works/OL1W' }] });
      if (url.includes('/b/id/8765-L.jpg')) return imageRes(900);
      if (url.includes('volumes?q=isbn')) return jsonRes({ items: [{ volumeInfo: { description: 'desc' } }] });
    });
    const book = await createExternalBookSource({ fetch: fn }).lookupIsbn(ISBN);
    expect(book).toMatchObject({ coverUrl: 'https://covers.openlibrary.org/b/id/8765-L.jpg', coverWidth: 900 });
  });

  it("falls back to the work's covers when this edition has none", async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes('openlibrary.org/api/books')) return jsonRes(olData);
      if (url === `https://openlibrary.org/isbn/${ISBN}.json`) return jsonRes({ works: [{ key: '/works/OL1W' }] });
      if (url === 'https://openlibrary.org/works/OL1W.json') return jsonRes({ covers: [4321] });
      if (url.includes('/b/id/4321-L.jpg')) return imageRes(700);
    });
    const book = await createExternalBookSource({ fetch: fn }).lookupIsbn(ISBN);
    expect(book?.coverUrl).toBe('https://covers.openlibrary.org/b/id/4321-L.jpg');
    expect(calls).toContain('https://openlibrary.org/works/OL1W.json');
  });

  it("borrows another Google edition's cover when this ISBN has none anywhere", async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes('openlibrary.org/api/books')) return jsonRes(olData);
      if (url.includes('volumes?q=isbn')) return jsonRes({ items: [{ id: 'bare', volumeInfo: { title: 'Project Hail Mary', authors: ['Andy Weir'] } }] });
      if (url.includes('volumes?q=intitle')) return jsonRes(googleSearch);
      if (url.includes('/volumes/vol123')) return jsonRes(googleVolume);
      if (url.includes('zoom=6')) return imageRes(1100);
    });
    const book = await createExternalBookSource({ fetch: fn }).lookupIsbn(ISBN);
    expect(book).toMatchObject({ coverUrl: 'https://books.google.com/books/content?id=vol123&zoom=6', coverWidth: 1100 });
    expect(calls.some((c) => c.includes(encodeURIComponent('intitle:"Project Hail Mary" inauthor:"Andy Weir"')))).toBe(true);
  });

  it("asks Google's image server for an 800px version of a thumbnail", async () => {
    const { fn } = fakeFetch((url) => {
      if (url.includes('openlibrary.org/api/books')) return jsonRes(olData);
      if (url.includes('volumes?q=isbn')) return jsonRes(googleSearch);
      if (url.includes('/volumes/vol123')) return jsonRes({});
      if (url.includes('fife=w800')) return imageRes(800);
      if (url.includes('books.google.com')) return imageRes(128);
    });
    const book = await createExternalBookSource({ fetch: fn }).lookupIsbn(ISBN);
    expect(book).toMatchObject({ coverUrl: 'https://books.google.com/books/content?id=vol123&zoom=1&fife=w800', coverWidth: 800 });
  });

  it('normalises ISBN-10 input before looking it up', async () => {
    const { fn, calls } = fakeFetch(() => undefined);
    await createExternalBookSource({ fetch: fn }).lookupIsbn('0-441-17271-7');
    expect(calls[0]).toContain('9780441172719');
  });

  it('returns null when nobody knows the book', async () => {
    const { fn } = fakeFetch(() => undefined);
    expect(await createExternalBookSource({ fetch: fn }).lookupIsbn(ISBN)).toBeNull();
  });

  it('returns null for an invalid ISBN without any network calls', async () => {
    const { fn, calls } = fakeFetch(() => undefined);
    expect(await createExternalBookSource({ fetch: fn }).lookupIsbn('not-an-isbn')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('survives network errors', async () => {
    const fn = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    expect(await createExternalBookSource({ fetch: fn }).lookupIsbn(ISBN)).toBeNull();
  });
});

describe('createExternalBookSource.search', () => {
  it('maps Open Library search results, preferring ISBN-13', async () => {
    const { fn } = fakeFetch((url) => {
      if (url.includes('search.json'))
        return jsonRes({
          docs: [
            { title: 'Dune', author_name: ['Frank Herbert'], isbn: ['0441172717', '9780441172719'], cover_i: 42, first_publish_year: 1965 },
            { title: 'No ISBN', author_name: ['X'] },
          ],
        });
    });
    const results = await createExternalBookSource({ fetch: fn }).search('dune');
    expect(results).toEqual([
      {
        isbn: '9780441172719',
        title: 'Dune',
        author: 'Frank Herbert',
        coverUrl: 'https://covers.openlibrary.org/b/id/42-M.jpg',
        year: 1965,
      },
    ]);
  });

  it("fills covers Open Library lacks from Google's results, and adds books only Google found", async () => {
    const { fn } = fakeFetch((url) => {
      if (url.includes('search.json'))
        return jsonRes({
          docs: [
            { title: 'Dune', author_name: ['Frank Herbert'], isbn: ['9780441172719'] },
            { title: 'Piranesi', author_name: ['Susanna Clarke'], isbn: ['9781635575637'], cover_edition_key: 'OL123M' },
          ],
        });
      if (url.includes('googleapis.com'))
        return jsonRes({
          items: [
            { volumeInfo: { title: 'Dune', authors: ['Frank Herbert'], industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780441172719' }], imageLinks: { thumbnail: 'http://g/dune' } } },
            { volumeInfo: { title: 'Circe', authors: ['Madeline Miller'], industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780316556347' }] } },
          ],
        });
    });
    const results = await createExternalBookSource({ fetch: fn }).search('books');
    expect(results.map((r) => [r.title, r.coverUrl])).toEqual([
      ['Dune', 'https://g/dune'],
      ['Piranesi', 'https://covers.openlibrary.org/b/olid/OL123M-M.jpg'],
      ['Circe', undefined],
    ]);
  });

  it('falls back to Google Books when Open Library has no results', async () => {
    const { fn } = fakeFetch((url) => {
      if (url.includes('search.json')) return jsonRes({ docs: [] });
      if (url.includes('googleapis.com'))
        return jsonRes({
          items: [
            {
              volumeInfo: {
                title: 'Dune',
                authors: ['Frank Herbert'],
                publishedDate: '1990-09-01',
                industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780441172719' }],
              },
            },
          ],
        });
    });
    const results = await createExternalBookSource({ fetch: fn }).search('dune');
    expect(results).toEqual([{ isbn: '9780441172719', title: 'Dune', author: 'Frank Herbert', coverUrl: undefined, year: 1990 }]);
  });

  it('retries anonymously when Google rejects the key, and logs why once (never the key)', async () => {
    const warnings: string[] = [];
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes('search.json')) return jsonRes({ docs: [] });
      if (url.includes('googleapis.com') && url.includes('key='))
        return new Response(JSON.stringify({ error: { code: 403, message: 'Requests from referer <empty> are blocked.', details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] } }), { status: 403 });
      if (url.includes('googleapis.com'))
        return jsonRes({ items: [{ volumeInfo: { title: 'Dune', authors: ['Frank Herbert'], industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780441172719' }] } }] });
    });
    const source = createExternalBookSource({ fetch: fn, googleApiKey: 'secret-key', warn: (m) => warnings.push(m) });
    expect((await source.search('dune')).map((b) => b.title)).toEqual(['Dune']);
    await source.search('dune again');
    expect(calls.some((u) => u.includes('googleapis.com') && !u.includes('key='))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('API_KEY_HTTP_REFERRER_BLOCKED');
    expect(warnings[0]).not.toContain('secret-key');
  });

  it('logs when the key cannot be read', async () => {
    const warnings: string[] = [];
    const { fn } = fakeFetch((url) => (url.includes('search.json') ? jsonRes({ docs: [] }) : url.includes('googleapis.com') ? jsonRes({ items: [] }) : undefined));
    await createExternalBookSource({ fetch: fn, googleApiKey: () => Promise.reject(Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' })), warn: (m) => warnings.push(m) }).search('dune');
    expect(warnings).toEqual([expect.stringContaining('AccessDeniedException')]);
  });

  it('adds the API key (from the app secret) to Google Books calls only, and works without one', async () => {
    const responder: Responder = (url) => (url.includes('search.json') ? jsonRes({ docs: [] }) : url.includes('googleapis.com') ? jsonRes({ items: [] }) : undefined);
    const withKey = fakeFetch(responder);
    await createExternalBookSource({ fetch: withKey.fn, googleApiKey: async () => 'k 1' }).search('dune');
    expect(withKey.calls.filter((u) => u.includes('googleapis.com')).every((u) => new URL(u).searchParams.get('key') === 'k 1')).toBe(true);
    expect(withKey.calls.filter((u) => !u.includes('googleapis.com')).some((u) => u.includes('key='))).toBe(false);

    // Not set yet, or SSM unreachable: Google is still asked, anonymously.
    for (const googleApiKey of [async () => undefined, async () => Promise.reject(new Error('ssm down'))]) {
      const anon = fakeFetch(responder);
      await createExternalBookSource({ fetch: anon.fn, googleApiKey, warn: () => undefined }).search('dune');
      expect(anon.calls.some((u) => u.includes('googleapis.com') && !u.includes('key='))).toBe(true);
    }
  });
});

describe('googleCover', () => {
  it('prefers the largest image', () => {
    expect(googleCover({ thumbnail: 'http://t', large: 'http://l' })).toBe('https://l');
    expect(googleCover(undefined)).toBeUndefined();
  });
});

describe('book details from the sources', () => {
  it("reads publisher, date, pages and subjects, preferring Open Library's and filling gaps from Google", async () => {
    const { fn } = fakeFetch((url) => {
      if (url.includes('openlibrary.org/api/books'))
        return jsonRes({
          [`ISBN:${ISBN}`]: {
            ...olData[`ISBN:${ISBN}`],
            publishers: [{ name: 'Ballantine Books' }],
            number_of_pages: 476,
            subjects: [{ name: 'Science fiction' }, { name: 'science fiction' }, { name: 'nyt:combined=2021-05-23' }, { name: 'Astronauts' }],
          },
        });
      if (url.includes('covers.openlibrary.org')) return imageRes(800);
      if (url.includes('volumes?q='))
        return jsonRes({
          items: [{ ...googleSearch.items[0], volumeInfo: { ...googleSearch.items[0]!.volumeInfo, publisher: 'Random House', publishedDate: '2021-05-04', pageCount: 496 } }],
        });
    });
    const book = await createExternalBookSource({ fetch: fn }).lookupIsbn(ISBN);
    expect(book).toMatchObject({
      publisher: 'Ballantine Books',
      pageCount: 476,
      publishedDate: '2021-05-04',
      subjects: ['Science fiction', 'Astronauts'],
      description: 'A lone astronaut must save the earth.',
    });
  });

  it('lists every cover it can find for an admin, widest first, without duplicates', async () => {
    const { fn } = fakeFetch((url) => {
      if (url.includes(`openlibrary.org/isbn/${ISBN}.json`)) return jsonRes({ covers: [111, 222] });
      if (url.includes(`b/isbn/${ISBN}`)) return imageRes(300);
      if (url.includes('b/id/111')) return imageRes(900);
      if (url.includes('b/id/222')) return new Response('x', { status: 200 }); // placeholder-sized: dropped
      if (url.includes('volumes?q=')) return jsonRes(googleSearch);
      if (url.includes('/volumes/vol123')) return jsonRes(googleVolume);
      if (url.includes('zoom=6')) return imageRes(1280);
      if (url.includes('books.google.com')) return imageRes(128);
    });
    const covers = await createExternalBookSource({ fetch: fn }).coverCandidates(ISBN, 'Project Hail Mary', 'Andy Weir');
    expect(covers.map((c) => [c.width, c.source])).toEqual([
      [1280, 'Google Books'],
      [900, 'Open Library'],
      [300, 'Open Library'],
    ]);
  });
});

describe('searching editions by free text', () => {
  it('returns Open Library and Google editions with measured covers and their details', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes('openlibrary.org/search.json'))
        return jsonRes({
          docs: [
            { title: 'Dune', author_name: ['Frank Herbert'], isbn: ['9780441172719'], cover_i: 42, publisher: ['Ace'], first_publish_year: 1965, number_of_pages_median: 412 },
            { title: 'Dune Messiah', author_name: ['Frank Herbert'], cover_i: 43 },
          ],
        });
      if (url.includes('b/id/42')) return imageRes(800);
      if (url.includes('b/id/43')) return new Response('x', { status: 200 }); // placeholder: no cover
      if (url.includes('volumes?q='))
        return jsonRes({
          items: [
            {
              id: 'g1',
              volumeInfo: {
                title: 'Dune (Deluxe Edition)',
                authors: ['Frank Herbert'],
                publisher: 'Penguin',
                publishedDate: '2019-10-01',
                pageCount: 688,
                description: 'Spice.',
                industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780593099322' }],
                imageLinks: { thumbnail: 'http://books.google.com/books/content?id=g1&zoom=1&edge=curl' },
              },
            },
          ],
        });
      if (url.includes('books.google.com')) return imageRes(800);
    });
    const editions = await createExternalBookSource({ fetch: fn }).searchEditions('dune herbert');
    expect(calls.some((c) => c.includes('search.json?q=dune%20herbert'))).toBe(true);
    expect(editions).toEqual([
      {
        title: 'Dune',
        author: 'Frank Herbert',
        isbn: '9780441172719',
        coverUrl: 'https://covers.openlibrary.org/b/id/42-L.jpg',
        coverWidth: 800,
        publisher: 'Ace',
        publishedDate: '1965',
        pageCount: 412,
        source: 'Open Library',
      },
      { title: 'Dune Messiah', author: 'Frank Herbert', source: 'Open Library' },
      {
        title: 'Dune (Deluxe Edition)',
        author: 'Frank Herbert',
        isbn: '9780593099322',
        coverUrl: 'https://books.google.com/books/content?id=g1&zoom=1&fife=w800',
        coverWidth: 800,
        publisher: 'Penguin',
        publishedDate: '2019-10-01',
        pageCount: 688,
        description: 'Spice.',
        source: 'Google Books',
      },
    ]);
  });
});
