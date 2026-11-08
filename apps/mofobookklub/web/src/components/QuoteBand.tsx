import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../lib/auth';
import type { EasterEgg } from '../lib/types';

/**
 * The critic's quote that closes the page: a random parody review from the
 * easter egg collection with the critic's photo, and a button for another.
 * Hidden when none are seeded.
 */
export function QuoteBand() {
  const api = useApi();
  const [quote, setQuote] = useState<EasterEgg | null>(null);
  const [loading, setLoading] = useState(false);

  const shuffle = useCallback(
    async (excludeId?: string) => {
      setLoading(true);
      try {
        setQuote((await api.randomEasterEgg(excludeId)) ?? null);
      } catch {
        // No quotes seeded (404) or a network blip: keep whatever is showing.
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void shuffle();
  }, [shuffle]);

  if (!quote) return null;
  return (
    <section
      aria-label="From our literary critics"
      className="grid items-end gap-6 bg-ink px-4 py-10 text-paper sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-10 sm:px-6 sm:py-14"
    >
      <CriticPortrait quote={quote} />
      <div className="min-w-0">
        <blockquote className="voice max-w-[26ch] text-[clamp(2rem,4.6vw,3.75rem)] leading-[1.02]">“{quote.quote}”</blockquote>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <span className="display text-2xl text-sun">— {quote.characterName}</span>
          <button type="button" className="btn-inverse" disabled={loading} onClick={() => void shuffle(quote.id)}>
            ✺ Another one
          </button>
        </div>
      </div>
    </section>
  );
}

const PLACEHOLDER_BACKGROUNDS = ['fill-lav', 'fill-sun', 'fill-coral'];

/**
 * The critic's photo, cropped square in a poster frame. Critics without a
 * photo get a silhouette in one of the poster colors (stable per critic).
 */
function CriticPortrait({ quote }: { quote: EasterEgg }) {
  const frame =
    'block aspect-square w-32 shrink-0 overflow-hidden border-2 border-paper shadow-[8px_8px_0_rgb(var(--c-coral))] sm:w-48 lg:w-56';
  if (quote.imageUrl) {
    return (
      <img key={quote.id} src={quote.imageUrl} alt={quote.characterName} loading="lazy" className={`${frame} bg-paper object-cover`} />
    );
  }
  const hash = [...quote.id].reduce((n, ch) => n + ch.charCodeAt(0), 0);
  return (
    <svg aria-hidden viewBox="0 0 100 100" className={frame}>
      <rect width="100" height="100" className={PLACEHOLDER_BACKGROUNDS[hash % PLACEHOLDER_BACKGROUNDS.length]} />
      <circle cx="50" cy="40" r="18" className="fill-ink" />
      <path d="M16 100 Q20 64 50 62 Q80 64 84 100 Z" className="fill-ink" />
    </svg>
  );
}
