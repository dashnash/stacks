import { describe, expect, it } from 'vitest';
import { kindleBuyUrl } from '../../web/src/lib/kindle';

describe('kindleBuyUrl', () => {
  it('searches the Kindle Store by title and author', () => {
    expect(kindleBuyUrl({ title: 'Project Hail Mary', author: 'Andy Weir' })).toBe(
      'https://www.amazon.com/s/ref=nodl_kindle?k=Project%20Hail%20Mary%20Andy%20Weir&i=digital-text&nodl=1',
    );
    expect(kindleBuyUrl({ title: 'Salt & Fat?', author: '' })).toBe(
      'https://www.amazon.com/s/ref=nodl_kindle?k=Salt%20%26%20Fat%3F&i=digital-text&nodl=1',
    );
  });

  it("carries both of the markers Amazon's app links leave out, so phones stay in the browser", () => {
    const url = new URL(kindleBuyUrl({ title: 'Dune' }));
    expect(url.searchParams.get('nodl')).toBe('1');
    expect(url.pathname).toMatch(/\/ref=nodl_/);
  });
});
