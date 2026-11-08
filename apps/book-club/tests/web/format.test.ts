import { describe, expect, it } from 'vitest';
import { formatPublished } from '../../web/src/lib/format';
import { bookHref, parseRoute } from '../../web/src/lib/route';

describe('formatPublished', () => {
  it('formats ISO-style dates and leaves free text alone', () => {
    expect(formatPublished('2021-05-04')).toBe('May 4, 2021');
    expect(formatPublished('2021-05')).toBe('May 2021');
    expect(formatPublished('2021')).toBe('2021');
    expect(formatPublished('Spring 2021')).toBe('Spring 2021');
  });
});

describe('routes', () => {
  it('reads book pages and treats everything else as home', () => {
    expect(parseRoute(bookHref('9780593135204'))).toEqual({ name: 'book', isbn: '9780593135204' });
    expect(parseRoute('#shelf')).toEqual({ name: 'home', anchor: 'shelf' });
    expect(parseRoute('#/')).toEqual({ name: 'home' });
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/book/<script>')).toEqual({ name: 'home', anchor: 'book/<script>' });
  });
});
