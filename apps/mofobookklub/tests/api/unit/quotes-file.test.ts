import { describe, expect, it } from 'vitest';
import quotes from '../../../content/eggs/quotes.json';
import { eggsFromQuotesFile, type QuoteFileEntry } from '../../../api/easter-egg/quotes-file.js';

describe('scripts/easter-eggs/quotes.json', () => {
  const entries = quotes as QuoteFileEntry[];

  it('has unique ids and a quote and critic for every entry', () => {
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    for (const e of entries) {
      expect(e.quote.trim(), e.id).not.toBe('');
      expect(e.characterName.trim(), e.id).not.toBe('');
    }
  });

  it('only references photos with a supported image extension', () => {
    for (const e of entries.filter((e) => e.image)) expect(e.image, e.id).toMatch(/\.(jpe?g|png|webp|gif)$/i);
  });

  it('maps photos to keys under eggs/', () => {
    expect(eggsFromQuotesFile([{ id: 'a', quote: 'q', characterName: 'c', image: 'a.jpg' }])[0]!.imageKey).toBe('eggs/a.jpg');
  });
});
