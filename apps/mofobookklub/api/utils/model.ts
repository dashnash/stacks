import type { Item } from './store.js';

// ---------------------------------------------------------------------------
// Entities (see "Data Schema" in docs/ARCHITECTURE.md)
// ---------------------------------------------------------------------------

/**
 * The manifest's roles. OWNER and ADMIN can manage access (the platform enforces who may grant
 * what); "admins can…" in this app means either.
 */
export type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

/** Admins and the owner: everything that says "admins can…" applies to both. */
export function isAdmin(user: Pick<User, 'role'>): boolean {
  return user.role === 'ADMIN' || user.role === 'OWNER';
}

export interface User {
  /** Platform user id: what meetings, nominations, votes and edits record. */
  id: string;
  role: Role;
  /** Their name as Google gives it (refreshed at each sign-in). Shown only as a first name. */
  name: string;
  /** A name they chose on their settings page, shown instead of their first name. */
  displayName?: string;
  pictureUrl?: string;
  createdAt: string;
}

/** Longest display name a member can choose. */
export const MAX_DISPLAY_NAME = 30;

/** The first name in a Google name ("Dashiell Nash" → "Dashiell"); for an email, the part before the @. */
export function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first.split('@')[0] || name;
}

/** How the site shows someone: the name they chose, or else their first name. */
export function shownName(user: Pick<User, 'name' | 'displayName'>): string {
  return user.displayName?.trim() || firstName(user.name);
}

/**
 * `status` is the spec's coarse UPCOMING/PAST flag; `phase` drives the leader's workflow:
 * PLANNING (no book yet) -> SELECTED (the leader picked the book) -> PAST.
 */
export type MeetingStatus = 'UPCOMING' | 'PAST';
export type MeetingPhase = 'PLANNING' | 'SELECTED' | 'PAST';
/** Phases written by the earlier voting workflow; read as PLANNING. */
type LegacyMeetingPhase = 'NOMINATING' | 'VOTING';

export interface Meeting {
  id: string;
  title: string;
  dateTime: string;
  videoUrl?: string;
  leaderId: string;
  bookIsbn?: string;
  status: MeetingStatus;
  phase: MeetingPhase;
  /**
   * The Lineup nomination the book was picked from. It was taken off the Lineup,
   * so it is kept here to give credit and to put back if the leader changes the book.
   */
  chosenNomination?: Nomination;
  /** Set by the outgoing leader when the meeting is completed. */
  nextLeaderId?: string;
  createdAt: string;
}

/** Map phases from the earlier voting workflow onto the current ones. */
export function normalizeMeeting(meeting: Omit<Meeting, 'phase'> & { phase: MeetingPhase | LegacyMeetingPhase }): Meeting {
  const phase = meeting.phase === 'NOMINATING' || meeting.phase === 'VOTING' ? 'PLANNING' : meeting.phase;
  return { ...meeting, phase };
}

export interface Book {
  isbn: string;
  title: string;
  author: string;
  coverUrl?: string;
  /** Pixel width of `coverUrl` when it was measured. */
  coverWidth?: number;
  /** When we last searched for a higher-resolution cover (ISO date-time). */
  coverCheckedAt?: string;
  /** An admin chose the cover (or chose no image), so automatic lookups leave it alone. */
  coverPinned?: boolean;
  description?: string;
  publisher?: string;
  /** As the source gives it: "2021", "2021-05" or "2021-05-04". */
  publishedDate?: string;
  pageCount?: number;
  /** Genres / subjects, a handful at most. */
  subjects?: string[];
  /** An admin-set Amazon page; otherwise the link is built from the ISBN. */
  amazonUrl?: string;
  /** When we last filled in missing details (publisher, pages, ...) from the book sources. */
  metadataCheckedAt?: string;
  /** Who last edited the details by hand (user id), and when. */
  editedBy?: string;
  editedAt?: string;
}

/** A book on The Lineup: the club's standing list of nominations, not tied to a meeting. */
export interface Nomination {
  id: string;
  bookIsbn: string;
  nominatedById: string;
  createdAt: string;
}

/** A vote for a book on The Lineup. */
export interface NominationVote {
  nominationId: string;
  userId: string;
  createdAt: string;
}

/** What a discussion thread is about: a book (by ISBN) or a meeting (by id). */
export type ThreadKind = 'book' | 'meeting';
export interface ThreadTarget {
  kind: ThreadKind;
  id: string;
}

/** A comment in a thread. `parentId` makes it a reply. Deleted comments with replies keep their place. */
export interface Comment {
  id: string;
  parentId?: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt?: string;
  deleted?: boolean;
}

export interface EasterEgg {
  id: string;
  /** S3 object key in the easter egg assets bucket. Served to clients as a presigned `imageUrl`. */
  imageKey?: string;
  quote: string;
  /** Older quotes carried a critic's name. It is never shown: quotes are unsigned, whoever's face is on them. */
  characterName?: string;
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

export const keys = {
  meeting: (id: string) => ({ PK: `MEETING#${id}`, SK: `MEETING#${id}` }),
  meetingPartition: (id: string) => `MEETING#${id}`,
  meetingsByStatus: (status: MeetingStatus) => `MEETINGS#${status}`,

  /** The Lineup lives in one partition. */
  lineupPartition: 'LINEUP',
  nomination: (id: string) => ({ PK: 'LINEUP', SK: `NOMINATION#${id}` }),
  /** One item per member per nomination; prefix VOTE#<nominationId># lists a nomination's votes. */
  nominationVote: (nominationId: string, userId: string) => ({ PK: 'LINEUP', SK: `VOTE#${nominationId}#${userId}` }),
  nominationVotePrefix: (nominationId: string) => `VOTE#${nominationId}#`,

  /** A discussion thread: every comment on one book or one meeting. */
  thread: (target: ThreadTarget) => `THREAD#${target.kind.toUpperCase()}#${target.id}`,
  comment: (target: ThreadTarget, commentId: string) => ({
    PK: `THREAD#${target.kind.toUpperCase()}#${target.id}`,
    SK: `COMMENT#${commentId}`,
  }),
  /** A thread's visible comment count, kept beside its comments so lists needn't load them all. */
  threadCount: (target: ThreadTarget) => ({ PK: `THREAD#${target.kind.toUpperCase()}#${target.id}`, SK: 'COUNT' }),

  book: (isbn: string) => ({ PK: `BOOK#${isbn}`, SK: `BOOK#${isbn}` }),

  easterEggPartition: 'EASTEREGG',
  easterEgg: (id: string) => ({ PK: 'EASTEREGG', SK: `EGG#${id}` }),
};

export type MeetingItem = Item & Meeting;
export type BookItem = Item & Book;
export type NominationItem = Item & Nomination;
export type EasterEggItem = Item & EasterEgg;
export type NominationVoteItem = Item & NominationVote;
export type CommentItem = Item & Comment;

/** Strip storage keys before returning an item to a client. */
export function strip<T extends object>(item: Item & T): T {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { PK, SK, GSI1PK, GSI1SK, ...rest } = item;
  return rest as unknown as T;
}

export function meetingItem(meeting: Meeting): MeetingItem {
  return {
    ...keys.meeting(meeting.id),
    GSI1PK: keys.meetingsByStatus(meeting.status),
    GSI1SK: meeting.dateTime,
    ...meeting,
  };
}
