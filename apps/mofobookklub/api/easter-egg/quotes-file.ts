import type { EasterEgg } from '../utils/model.js';

/** One entry in content/eggs/quotes.json. */
export interface QuoteFileEntry {
  id: string;
  quote: string;
  /** File name in content/eggs/, deployed to the content bucket under eggs/. */
  image?: string;
}

/** S3 key a quote's photo is deployed to. */
export const imageKeyFor = (image: string) => `eggs/${image}`;

/** Where the shared faces live in the content bucket. Admins upload them on the admin page; never kept in git. */
export const FACES_PREFIX = 'eggs/faces/';

export function eggsFromQuotesFile(entries: readonly QuoteFileEntry[]): EasterEgg[] {
  return entries.map((e) => ({
    id: e.id,
    quote: e.quote,
    imageKey: e.image ? imageKeyFor(e.image) : undefined,
  }));
}
