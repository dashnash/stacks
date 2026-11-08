import { badRequest } from '../utils/http.js';

/**
 * The Amazon page for a book. ISBN-13s that start with 978 have an ISBN-10, which is
 * Amazon's product id for print books (amazon.com/dp/<isbn10>). Others (979…) have no
 * ISBN-10, so they go to an Amazon book search for the ISBN instead.
 */
export function defaultAmazonUrl(isbn: string): string {
  const digits = isbn.replace(/[^\dXx]/g, '').toUpperCase();
  if (digits.length === 10) return `https://www.amazon.com/dp/${digits}`;
  if (digits.length === 13 && digits.startsWith('978')) {
    const core = digits.slice(3, 12);
    const sum = [...core].reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
    const check = (11 - (sum % 11)) % 11;
    return `https://www.amazon.com/dp/${core}${check === 10 ? 'X' : check}`;
  }
  return `https://www.amazon.com/s?k=${encodeURIComponent(digits || isbn)}&i=stripbooks`;
}

/** Amazon's own hosts and its short-link domains. */
const AMAZON_HOST = /(^|\.)amazon\.(com|ca|co\.uk|com\.au|de|fr|es|it|nl|se|in|co\.jp|com\.mx|com\.br|sg|ae|sa|pl|com\.tr|com\.be|ie)$/;
const SHORT_HOSTS = new Set(['a.co', 'amzn.to', 'amzn.eu', 'amzn.asia']);

/** Check an admin-entered Amazon link: https, and on an Amazon domain so it can't send members elsewhere. */
export function validateAmazonUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw badRequest('The Amazon link must be a full https:// address');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(AMAZON_HOST.test(host) || SHORT_HOSTS.has(host))) {
    throw badRequest('The Amazon link must be an https:// link to an Amazon site');
  }
  return url.toString();
}
