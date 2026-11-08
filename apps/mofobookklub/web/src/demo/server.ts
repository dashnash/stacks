/**
 * Book Club's demo data: sample members, a believable club (a shelf of past reads, a meeting
 * taking nominations, discussions) and a fake book catalog. `main.tsx` runs the real API on it
 * in the browser through @stacks/demo.
 */
import type { BookCandidate, BookSource, CoverCandidate, Edition } from '../../../api/utils/deps';
import { keys, meetingItem, type Meeting, type Role, type ThreadTarget } from '../../../api/utils/model';
import type { Store } from '@stacks/api';
import quotes from '../../../content/eggs/quotes.json';
import { DEMO_CATALOG } from './catalog';

/** Sample members (the platform's job now: these are the demo's stand-in for its grants). */
export interface Persona {
  email: string;
  name: string;
  role: Role | 'PENDING';
  blurb: string;
}

export const ADMIN_EMAIL = 'you@demo.bookklub';

export const PERSONAS: Persona[] = [
  { email: ADMIN_EMAIL, name: 'You (Owner)', role: 'OWNER', blurb: 'Can do everything, including making people admins' },
  { email: 'jane@demo.bookklub', name: 'Jane Okafor', role: 'MEMBER', blurb: "Leading this month's meeting" },
  { email: 'marcus@demo.bookklub', name: 'Marcus Bell', role: 'MEMBER', blurb: 'Regular member' },
  { email: 'priya@demo.bookklub', name: 'Priya Raman', role: 'ADMIN', blurb: 'An admin (not the owner)' },
  { email: 'theo@demo.bookklub', name: 'Theo Lindqvist', role: 'MEMBER', blurb: 'Regular member' },
  { email: 'sam@demo.bookklub', name: 'Sam Whitaker', role: 'PENDING', blurb: 'Just signed up, waiting for approval' },
];

// Bump when the sample data changes, so returning viewers get the new seed.

export class DemoBooks implements BookSource {
  async lookupIsbn(isbn: string) {
    return DEMO_CATALOG.find((b) => b.isbn === isbn) ?? null;
  }
  async search(query: string): Promise<BookCandidate[]> {
    const q = query.toLowerCase();
    return DEMO_CATALOG.filter((b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q));
  }
  /** Every catalog book matching all the search words (the demo has one edition per book). */
  async searchEditions(query: string): Promise<Edition[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return DEMO_CATALOG.filter((b) => words.every((w) => `${b.title} ${b.author}`.toLowerCase().includes(w))).map(
      (b) => ({
        ...b,
        coverUrl: b.coverUrl && new URL(b.coverUrl, globalThis.location?.href ?? 'https://demo.local/').href,
        source: 'Demo library',
      }),
    );
  }
  /** The demo has one mock cover per book. Absolute, since admins can only save https:// cover links. */
  async coverCandidates(isbn: string): Promise<CoverCandidate[]> {
    const book = DEMO_CATALOG.find((b) => b.isbn === isbn);
    if (!book?.coverUrl) return [];
    return [
      {
        url: new URL(book.coverUrl, globalThis.location?.href ?? 'https://demo.local/').href,
        width: book.coverWidth ?? 0,
        source: 'Demo library',
      },
    ];
  }
}

/** Fill a fresh store with a believable club: a shelf of past reads and a meeting taking nominations. */
export async function seed(store: Store, now = new Date()): Promise<void> {
  const created = new Date(now.getTime() - 400 * 86_400_000).toISOString();
  for (const book of DEMO_CATALOG) await store.put({ ...keys.book(book.isbn), ...book });

  const month = (offset: number, day = 18) => {
    const d = new Date(now);
    d.setMonth(d.getMonth() + offset, day);
    d.setHours(19, 0, 0, 0);
    return d.toISOString();
  };
  const past: [string, string, string][] = [
    // [isbn, leader, title]
    ['9781635575637', 'marcus@demo.bookklub', 'Piranesi'],
    ['9780679731726', 'priya@demo.bookklub', 'The Remains of the Day'],
    ['9780316556347', 'theo@demo.bookklub', 'Circe'],
    ['9780804172448', ADMIN_EMAIL, 'Station Eleven'],
    ['9780143110439', 'marcus@demo.bookklub', 'A Gentleman in Moscow'],
    ['9780553418026', 'priya@demo.bookklub', 'The Martian'],
    ['9780307744432', 'theo@demo.bookklub', 'The Night Circus'],
  ];
  for (const [i, [isbn, leaderEmail]] of past.entries()) {
    const meeting: Meeting = {
      id: `past-${i + 1}`,
      title: 'Book Klub',
      dateTime: month(-(i + 1)),
      leaderEmail,
      bookIsbn: isbn,
      status: 'PAST',
      phase: 'PAST',
      // The most recent meeting handed off to Jane, who scheduled the current one.
      nextLeaderEmail: i === 0 ? 'jane@demo.bookklub' : past[i - 1]![1],
      createdAt: month(-(i + 2)),
    };
    await store.put(meetingItem(meeting));
  }

  const upcoming = new Date(now.getTime() + 12 * 86_400_000);
  upcoming.setHours(19, 0, 0, 0);
  const current: Meeting = {
    id: 'current',
    title: `${upcoming.toLocaleDateString('en-US', { month: 'long' })} Book Klub`,
    dateTime: upcoming.toISOString(),
    videoUrl: 'https://meet.google.com/',
    leaderEmail: 'jane@demo.bookklub',
    status: 'UPCOMING',
    phase: 'PLANNING',
    createdAt: now.toISOString(),
  };
  await store.put(meetingItem(current));
  // The Lineup: the club's standing list of nominations, waiting for a leader to pick one.
  const lineup: [string, string][] = [
    ['9780593135204', 'marcus@demo.bookklub'],
    ['9780593318171', 'priya@demo.bookklub'],
    ['9780593321201', 'theo@demo.bookklub'],
    ['9780063251922', 'jane@demo.bookklub'],
    ['9780385547345', ADMIN_EMAIL],
  ];
  for (const [i, [isbn, by]] of lineup.entries()) {
    await store.put({
      ...keys.nomination(`seed-${i + 1}`),
      id: `seed-${i + 1}`,
      bookIsbn: isbn,
      nominatedByEmail: by,
      createdAt: new Date(now.getTime() - (lineup.length - i) * 3_600_000).toISOString(),
    });
  }

  // Votes on The Lineup (seed-1 is Project Hail Mary, seed-2 Klara and the Sun, seed-4 Demon Copperhead).
  const votes: [string, string][] = [
    ['seed-1', 'priya@demo.bookklub'],
    ['seed-1', 'theo@demo.bookklub'],
    ['seed-1', 'jane@demo.bookklub'],
    ['seed-2', 'marcus@demo.bookklub'],
    ['seed-4', ADMIN_EMAIL],
    ['seed-4', 'priya@demo.bookklub'],
  ];
  for (const [nominationId, userEmail] of votes) {
    await store.put({
      ...keys.nominationVote(nominationId, userEmail),
      nominationId,
      userEmail,
      createdAt: now.toISOString(),
    });
  }

  // A few conversations: [thread, id, parent, author, body, minutes ago].
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const comments: [ThreadTarget, string, string | undefined, string, string, number][] = [
    [
      { kind: 'book', id: '9780593135204' },
      'c1',
      undefined,
      'marcus@demo.bookklub',
      'Rocky is the best character in sci-fi. Fight me.',
      300,
    ],
    [{ kind: 'book', id: '9780593135204' }, 'c2', 'c1', 'priya@demo.bookklub', 'No fight needed. Fist my bump.', 240],
    [{ kind: 'book', id: '9780593135204' }, 'c3', 'c2', 'theo@demo.bookklub', 'Amaze amaze amaze.', 200],
    [
      { kind: 'book', id: '9780593318171' },
      'c4',
      undefined,
      'priya@demo.bookklub',
      'Ishiguro does quiet devastation better than anyone. Bring tissues.',
      1500,
    ],
    [
      { kind: 'meeting', id: 'current' },
      'c5',
      undefined,
      'jane@demo.bookklub',
      "I'll send a reading schedule once we pick. Vote on the Lineup!",
      90,
    ],
    [
      { kind: 'meeting', id: 'current' },
      'c6',
      'c5',
      'theo@demo.bookklub',
      'Can we aim for half the book by the 10th?',
      45,
    ],
    [
      { kind: 'book', id: '9781635575637' },
      'c7',
      undefined,
      'theo@demo.bookklub',
      'The House is the best setting I have read in years.',
      4000,
    ],
    [
      { kind: 'meeting', id: 'past-1' },
      'c8',
      undefined,
      'marcus@demo.bookklub',
      'Great discussion last night, thanks for hosting!',
      3000,
    ],
  ];
  for (const [target, id, parentId, authorEmail, body, minutes] of comments) {
    await store.put({
      ...keys.comment(target, id),
      id,
      ...(parentId ? { parentId } : {}),
      authorEmail,
      body,
      createdAt: ago(minutes),
    });
  }

  // Some history for the admin page's activity log, matching the sample data above.
  const nameOf = (email: string) => PERSONAS.find((p) => p.email === email)?.name ?? email;
  const history: [number, string, string, string?, Record<string, unknown>?][] = [
    // [minutes ago, who, action, label, details]
    [2880, 'marcus@demo.bookklub', 'auth.login', undefined, { role: 'MEMBER' }],
    [2870, 'marcus@demo.bookklub', 'nomination.create', 'Project Hail Mary', { input: { isbn: '9780593135204' } }],
    [1600, 'priya@demo.bookklub', 'auth.login', undefined, { role: 'MEMBER' }],
    [1550, 'priya@demo.bookklub', 'nomination.create', 'Klara and the Sun', { input: { isbn: '9780593318171' } }],
    [
      1500,
      'priya@demo.bookklub',
      'comment.post',
      'Klara and the Sun',
      { input: { body: 'Ishiguro does quiet devastation better than anyone. Bring tissues.' } },
    ],
    [1450, 'priya@demo.bookklub', 'vote.add', 'Project Hail Mary'],
    [
      300,
      'marcus@demo.bookklub',
      'comment.post',
      'Project Hail Mary',
      { input: { body: 'Rocky is the best character in sci-fi. Fight me.' } },
    ],
    [
      240,
      'priya@demo.bookklub',
      'comment.post',
      'Project Hail Mary',
      { input: { body: 'No fight needed. Fist my bump.', parentId: 'c1' } },
    ],
    [
      200,
      'theo@demo.bookklub',
      'comment.post',
      'Project Hail Mary',
      { input: { body: 'Amaze amaze amaze.', parentId: 'c2' } },
    ],
    [
      120,
      ADMIN_EMAIL,
      'book.edit',
      'Project Hail Mary',
      { changes: { publisher: { from: null, to: 'Ballantine Books' }, pageCount: { from: null, to: 496 } } },
    ],
    [
      90,
      'jane@demo.bookklub',
      'comment.post',
      'November Book Klub',
      { input: { body: "I'll send a reading schedule once we pick. Vote on the Lineup!" } },
    ],
    [60, 'sam@demo.bookklub', 'auth.login', undefined, { role: 'PENDING' }],
    [
      45,
      'theo@demo.bookklub',
      'comment.post',
      'November Book Klub',
      { input: { body: 'Can we aim for half the book by the 10th?', parentId: 'c5' } },
    ],
  ];
  for (const [i, [minutes, email, action, label, details]] of history.entries()) {
    const at = ago(minutes);
    await store.put({
      PK: `AUDIT#${at.slice(0, 7)}`,
      SK: `${at}#seed-${i}`,
      id: `seed-${i}`,
      at,
      actorEmail: email,
      actorName: nameOf(email),
      action,
      ...(label ? { label } : {}),
      ...(details ? { details } : {}),
    });
  }

  for (const q of quotes as { id: string; quote: string; characterName: string }[]) {
    await store.put({ ...keys.easterEgg(q.id), id: q.id, quote: q.quote, characterName: q.characterName });
  }
}

