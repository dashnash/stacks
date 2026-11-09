import { contentStore, createLambdaHandler } from '@stacks/api/lambda';
import quotes from '../content/eggs/quotes.json';
import { createExternalBookSource } from './books/sources.js';
import { eggsFromQuotesFile, FACES_PREFIX, type QuoteFileEntry } from './easter-egg/quotes-file.js';
import { manifest } from './manifest';
import { routes } from './routes';
import type { Deps } from './utils/deps.js';

const content = contentStore();

export const handler = createLambdaHandler<Deps>({
  manifest,
  routes,
  extend: (base) => ({
    ...base,
    books: createExternalBookSource({ googleApiKey: async () => base.secret?.('GOOGLE_BOOKS_API_KEY') }),
    signImageUrl: (key) => content.signUrl(key),
    faces: {
      list: () => content.list(FACES_PREFIX),
      put: (key, body, type) => content.put(key, body, type),
      delete: (key) => content.delete(key),
    },
    random: Math.random,
    bundledEasterEggs: eggsFromQuotesFile(quotes as QuoteFileEntry[]),
  }),
});
