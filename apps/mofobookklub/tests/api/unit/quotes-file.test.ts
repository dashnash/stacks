import { describe, expect, it } from 'vitest';
import quotes from '../../../content/eggs/quotes.json';
import { eggsFromQuotesFile, type QuoteFileEntry } from '../../../api/easter-egg/quotes-file.js';

describe('scripts/easter-eggs/quotes.json', () => {
  const entries = quotes as QuoteFileEntry[];

  it('has unique ids and a quote for every entry', () => {
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    for (const e of entries) expect(e.quote.trim(), e.id).not.toBe('');
  });

  it('signs no quote with a name: any face can go on any quote', () => {
    for (const e of entries) expect(Object.keys(e).sort(), e.id).toEqual(e.image ? ['id', 'image', 'quote'] : ['id', 'quote']);
  });

  it('only references photos with a supported image extension', () => {
    for (const e of entries.filter((e) => e.image)) expect(e.image, e.id).toMatch(/\.(jpe?g|png|webp|gif)$/i);
  });

  it('maps photos to keys under eggs/', () => {
    expect(eggsFromQuotesFile([{ id: 'a', quote: 'q', image: 'a.jpg' }])[0]!.imageKey).toBe('eggs/a.jpg');
  });
});
