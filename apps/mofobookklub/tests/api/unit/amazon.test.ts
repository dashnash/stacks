import { describe, expect, it } from 'vitest';
import { defaultAmazonUrl } from '../../../api/books/amazon.js';

describe('defaultAmazonUrl', () => {
  it('links 978 ISBN-13s to the product page by ISBN-10', () => {
    expect(defaultAmazonUrl('9780593135204')).toBe('https://www.amazon.com/dp/0593135202');
    expect(defaultAmazonUrl('978-0-441-17271-9')).toBe('https://www.amazon.com/dp/0441172717');
    expect(defaultAmazonUrl('9780306406157')).toBe('https://www.amazon.com/dp/0306406152');
    // Check digit 10 is written X.
    expect(defaultAmazonUrl('9780804429573')).toBe('https://www.amazon.com/dp/080442957X');
  });

  it('passes ISBN-10s straight through', () => {
    expect(defaultAmazonUrl('080442957x')).toBe('https://www.amazon.com/dp/080442957X');
  });

  it('searches for 979 ISBNs, which have no ISBN-10', () => {
    expect(defaultAmazonUrl('9791032305690')).toBe('https://www.amazon.com/s?k=9791032305690&i=stripbooks');
  });
});
