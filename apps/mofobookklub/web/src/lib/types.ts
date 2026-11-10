// The response shapes the app reads. Domain types the backend defines (roles, users, people,
// book search results, audit events) are imported from it rather than copied, so the two can't
// drift apart. Type-only imports add nothing to the bundle; isAdmin is a one-liner.
import type { MeetingPhase, Role, ThreadKind } from '../../../api/utils/model';
import type { Person } from '../../../api/users/repo';

/**
 * The signed-in member: `name` is the name shown everywhere (their display name from the
 * platform profile), `role` their Book Club role.
 */
export interface User {
  /** Platform user id. */
  id: string;
  name: string;
  role: Role;
  pictureUrl?: string;
}

export type { AuditEvent } from '@stacks/api';
export type { BookCandidate, CoverCandidate, Edition } from '../../../api/utils/deps';
export type { MeetingPhase, Person, Role, ThreadKind };
export { isAdmin } from '../../../api/utils/model';

export interface Book {
  isbn: string;
  title: string;
  author: string;
  coverUrl?: string;
  /** Pixel width of the cover image, when the backend measured it. */
  coverWidth?: number;
  description?: string;
  publisher?: string;
  /** As the source gives it, e.g. "2021", "2021-05-04" or "May 4, 2021". */
  publishedDate?: string;
  pageCount?: number;
  subjects?: string[];
}

/** A book as its details page shows it. */
export interface BookPageBook extends Book {
  /** Always set: an admin's link, or the one built from the ISBN. */
  amazonUrl: string;
  amazonUrlIsCustom: boolean;
  coverPinned?: boolean;
  editedAt?: string;
}

export interface BookDetails {
  book: BookPageBook;
  /** Its Lineup card, when the book is on The Lineup. */
  nomination: Omit<NominationView, 'book' | 'commentCount'> | null;
  /** Meetings that read (or will read) it, upcoming first. */
  meetings: { id: string; title: string; dateTime: string; status: 'UPCOMING' | 'PAST'; leader?: Person }[];
  commentCount: number;
  /** Admins, and the member who nominated the book. */
  canEdit: boolean;
}

/** Changes to a book (by an admin or its nominator). null clears a field (no image, default Amazon link). */
export interface BookUpdate {
  title?: string;
  author?: string;
  publisher?: string | null;
  publishedDate?: string | null;
  pageCount?: number | null;
  subjects?: string[] | null;
  description?: string | null;
  coverUrl?: string | null;
  coverWidth?: number;
  amazonUrl?: string | null;
}

export interface NominationView {
  id: string;
  createdAt: string;
  book: Book;
  nominatedBy?: Person;
  canWithdraw: boolean;
  /** Members who want to read it. The Lineup is sorted by this. */
  votes: number;
  myVote: boolean;
  /** Comments in the book's thread. */
  commentCount: number;
}

export interface Meeting {
  id: string;
  title: string;
  dateTime: string;
  videoUrl?: string;
  leaderId: string;
  bookIsbn?: string;
  status: 'UPCOMING' | 'PAST';
  phase: MeetingPhase;
  nextLeaderId?: string;
  createdAt: string;
}

export interface MeetingView extends Meeting {
  leader?: Person;
  book?: Book;
  /** Who nominated the book, when it was picked from The Lineup. */
  nominatedBy?: Person;
  canManage: boolean;
  /** Comments in the meeting's thread, and in its book's. */
  commentCount: number;
  bookCommentCount: number;
}

/** The Lineup: the club's standing list of nominations. */
export interface Lineup {
  nominations: NominationView[];
  /** Whether the viewer can pick a book from here for the upcoming meeting (its leader, or an admin). */
  canPick: boolean;
  meetingId: string | null;
}

/** Pick a meeting's book from The Lineup, or any book by ISBN. */
export type BookChoice = { nominationId: string } | { isbn: string };

export type NextMeetingResponse =
  | { meeting: MeetingView }
  | { meeting: null; nextLeader: Person | null; canCreateNext: boolean };

export interface PastMeeting extends Meeting {
  leader?: Person;
  book?: Book;
  commentCount: number;
  bookCommentCount: number;
}

/** What a discussion thread is about. */
export interface CommentView {
  id: string;
  parentId: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  body: string;
  author: Person | null;
  canEdit: boolean;
  canDelete: boolean;
}

/** A critic's quote: unsigned, with one of the shared faces (or the quote's own photo). */
export interface EasterEgg {
  id: string;
  quote: string;
  imageUrl: string | null;
}

/** One of the shared face photos (admins). `url` is a short-lived link. */
export interface FacePhotoView {
  name: string;
  url: string;
}

export interface MeetingInput {
  title?: string;
  dateTime: string;
  videoUrl?: string;
  leaderId?: string;
}

/** Book details for signed-out visitors: nothing about members. */
export type PublicBook = Pick<
  Book,
  'isbn' | 'title' | 'author' | 'coverUrl' | 'publisher' | 'publishedDate' | 'pageCount'
>;

/** A book on the public shelf (signed-out pages): book details only, nothing about members. */
export interface PublicShelfBook {
  readOn: string;
  book: PublicBook;
}

export interface PublicShelf {
  /** The current headliner, once the next meeting's book is picked. */
  current: { meetsOn: string; book: PublicBook } | null;
  books: PublicShelfBook[];
}

/** A book's public page. */
export interface PublicBookPage {
  book: PublicBook & Pick<Book, 'description' | 'subjects'> & { amazonUrl: string };
  readOn: string[];
  meetsOn: string | null;
}
