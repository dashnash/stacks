import type { Lineup, MeetingView } from '../lib/types';

export interface MarqueeItem {
  title: string;
  note?: string;
}

/** What the ticker says: the picked book once there is one, otherwise The Lineup. */
export function marqueeItems(meeting: MeetingView | null, lineup: Lineup | undefined): MarqueeItem[] {
  if (meeting?.book) {
    return [{ title: 'Now reading' }, { title: meeting.book.title, note: `by ${meeting.book.author}` }];
  }
  const nominations = lineup?.nominations ?? [];
  if (nominations.length === 0) return [{ title: 'The Lineup is open', note: 'nominate a book below' }];
  return nominations.map((n) => ({
    title: n.book.title,
    note: `nominated by ${n.nominatedBy?.name ?? 'a member'}`,
  }));
}

/** A coral ticker band that scrolls the items forever (static with reduced motion). */
export function Marquee({ items, label }: { items: MarqueeItem[]; label: string }) {
  // Repeat the items so half the track is always wider than the screen, then
  // render that half twice so the -50% scroll loops seamlessly.
  const reps = Math.max(1, Math.ceil(6 / Math.max(1, items.length)));
  const half = Array.from({ length: reps }, () => items).flat();

  return (
    <section aria-label={label} className="marquee overflow-hidden border-b-2 border-ink bg-coral">
      <ul className="sr-only">
        {items.map((item, i) => (
          <li key={i}>
            {item.title}
            {item.note ? `, ${item.note}` : ''}
          </li>
        ))}
      </ul>
      <div aria-hidden className="marquee-track flex w-max py-3 sm:py-4">
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0 items-center">
            {half.map((item, i) => (
              <span key={i} className="flex items-center whitespace-nowrap">
                <span className="display text-[clamp(2rem,4.5vw,3.25rem)]">{item.title}</span>
                {item.note && <span className="voice ml-5 text-[clamp(1.5rem,3.4vw,2.5rem)]">{item.note}</span>}
                <span className="mx-6 text-[clamp(1.5rem,3vw,2.25rem)]">✺</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
