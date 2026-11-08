/**
 * Normalise user input to a canonical ISBN-13 (digits only), or return null if
 * it isn't a valid ISBN-10/13. Canonicalising means the same book nominated by
 * its ISBN-10 and ISBN-13 is recognised as one book.
 */
export function normalizeIsbn(input: string): string | null {
  const raw = input.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(raw)) return isValidIsbn10(raw) ? isbn10To13(raw) : null;
  if (/^\d{13}$/.test(raw)) return isValidIsbn13(raw) ? raw : null;
  return null;
}

/** True when the input looks like someone typed an ISBN (rather than a title). */
export function looksLikeIsbn(input: string): boolean {
  return /^[\d\s-]{9,17}[\dXx]?$/.test(input.trim());
}

function isValidIsbn10(isbn: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = isbn[i]!;
    const value = ch === 'X' ? 10 : Number(ch);
    if (ch === 'X' && i !== 9) return false;
    sum += value * (10 - i);
  }
  return sum % 11 === 0;
}

function isValidIsbn13(isbn: string): boolean {
  return isbn13CheckDigit(isbn.slice(0, 12)) === Number(isbn[12]);
}

function isbn13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

function isbn10To13(isbn10: string): string {
  const first12 = `978${isbn10.slice(0, 9)}`;
  return `${first12}${isbn13CheckDigit(first12)}`;
}
