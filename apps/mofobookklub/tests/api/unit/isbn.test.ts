import { describe, expect, it } from 'vitest';
import { looksLikeIsbn, normalizeIsbn } from '../../../api/books/isbn.js';

describe('normalizeIsbn', () => {
  it('accepts a valid ISBN-13 with hyphens', () => {
    expect(normalizeIsbn('978-0-593-13520-4')).toBe('9780593135204');
  });

  it('converts a valid ISBN-10 to ISBN-13', () => {
    expect(normalizeIsbn('0-441-17271-7')).toBe('9780441172719');
  });

  it('handles an X check digit', () => {
    expect(normalizeIsbn('080442957X')).toBe('9780804429573');
  });

  it('rejects bad checksums and junk', () => {
    expect(normalizeIsbn('9780593135205')).toBeNull();
    expect(normalizeIsbn('0441172718')).toBeNull();
    expect(normalizeIsbn('Project Hail Mary')).toBeNull();
  });
});

describe('looksLikeIsbn', () => {
  it('distinguishes ISBN-ish input from titles', () => {
    expect(looksLikeIsbn('978-0-593-13520-4')).toBe(true);
    expect(looksLikeIsbn('080442957X')).toBe(true);
    expect(looksLikeIsbn('Dune')).toBe(false);
    expect(looksLikeIsbn('1984')).toBe(false);
  });
});
