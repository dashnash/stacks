import { backfillCovers, ensureHiResCover, getBook, getBooks, resolveBook } from '../books/repo.js';
import type { Deps } from '../utils/deps.js';
import type { Handler } from '../utils/handler.js';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  optionalString,
  optionalUrl,
  requireIsoDate,
  requireString,
} from '../utils/http.js';
import {
  isAdmin,
  keys,
  strip,
  type Meeting,
  type Nomination,
  type NominationVote,
  type NominationVoteItem,
  type User,
} from '../utils/model.js';
import { commentCounts } from '../comments/routes.js';
import type { RequestContext } from '../utils/router.js';
import { getPeople, getUser, person, type Person } from '../users/repo.js';
import {
  deleteNomination,
  getMeeting,
  getNomination,
  getUpcomingMeeting,
  listLineup,
  listPastMeetings,
  saveMeeting,
  saveNomination,
} from './repo.js';

/** The leader runs their meeting; admins can always step in. */
function canManage(user: User, meeting: Meeting): boolean {
  return isAdmin(user) || user.email === meeting.leaderEmail;
}

function requireManager(user: User, meeting: Meeting): void {
  if (!canManage(user, meeting)) throw forbidden('Only the meeting leader or an admin can do that');
}

function requireUpcoming(meeting: Meeting): void {
  if (meeting.status === 'PAST') throw conflict('That meeting has already happened');
}

/** The member the last leader handed off to, if any. */
async function designatedNextLeader(deps: Deps): Promise<string | undefined> {
  const [latest] = await listPastMeetings(deps);
  return latest?.nextLeaderEmail;
}

async function requireApprovedUser(deps: Deps, email: string, field: string): Promise<User> {
  const user = await getUser(deps, email);
  if (!user) throw badRequest(`"${field}" must be an approved member`);
  return user;
}

/** A meeting with its leader, book and (if picked from The Lineup) who nominated it. */
async function meetingView(deps: Deps, meeting: Meeting, user: User) {
  const nominator = meeting.chosenNomination?.nominatedByEmail;
  const [book, people, [commentCount, bookCommentCount]] = await Promise.all([
    meeting.bookIsbn ? getBook(deps, meeting.bookIsbn) : Promise.resolve(undefined),
    getPeople(deps, [meeting.leaderEmail, ...(nominator ? [nominator] : [])]),
    commentCounts(deps, [
      { kind: 'meeting', id: meeting.id },
      ...(meeting.bookIsbn ? [{ kind: 'book' as const, id: meeting.bookIsbn }] : []),
    ]),
  ]);
  const { chosenNomination: _chosen, ...rest } = meeting;
  return {
    ...rest,
    leader: people.get(meeting.leaderEmail),
    book,
    nominatedBy: nominator ? people.get(nominator) : undefined,
    canManage: canManage(user, meeting),
    commentCount,
    bookCommentCount: meeting.bookIsbn ? bookCommentCount : 0,
  };
}

/** Every Lineup vote, grouped by nomination. */
async function lineupVotes(deps: Deps): Promise<Map<string, NominationVote[]>> {
  const items = await deps.store.query<NominationVoteItem>(keys.lineupPartition, 'VOTE#');
  const byNomination = new Map<string, NominationVote[]>();
  for (const v of items.map((i) => strip(i) as NominationVote)) {
    byNomination.set(v.nominationId, [...(byNomination.get(v.nominationId) ?? []), v]);
  }
  return byNomination;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const getNextMeeting: Handler = async (_req, user, deps) => {
  const meeting = await getUpcomingMeeting(deps);
  if (meeting) {
    // The chosen book headlines the poster; upgrade its cover once if it was stored small.
    if (meeting.bookIsbn) await ensureHiResCover(deps, meeting.bookIsbn);
    return { body: { meeting: await meetingView(deps, meeting, user) } };
  }

  const nextLeaderEmail = await designatedNextLeader(deps);
  return {
    body: {
      meeting: null,
      nextLeader: nextLeaderEmail ? person(await getUser(deps, nextLeaderEmail), nextLeaderEmail) : null,
      canCreateNext: isAdmin(user) || nextLeaderEmail === user.email,
    },
  };
};

export const getHistory: Handler = async (_req, _user, deps) => {
  const meetings = await listPastMeetings(deps);
  const isbns = meetings.flatMap((m) => (m.bookIsbn ? [m.bookIsbn] : []));
  await backfillCovers(deps, isbns);
  const [books, people, counts] = await Promise.all([
    getBooks(deps, isbns),
    getPeople(
      deps,
      meetings.map((m) => m.leaderEmail),
    ),
    Promise.all(
      meetings.map((m) =>
        commentCounts(deps, [
          { kind: 'meeting', id: m.id },
          ...(m.bookIsbn ? [{ kind: 'book' as const, id: m.bookIsbn }] : []),
        ]),
      ),
    ),
  ]);
  return {
    body: {
      meetings: meetings.map((m, i) => ({
        ...m,
        leader: people.get(m.leaderEmail),
        book: m.bookIsbn ? books.get(m.bookIsbn) : undefined,
        commentCount: counts[i]![0] ?? 0,
        bookCommentCount: m.bookIsbn ? (counts[i]![1] ?? 0) : 0,
      })),
    },
  };
};

// ---------------------------------------------------------------------------
// Leader workflow: create, edit, pick the book, wrap up
// ---------------------------------------------------------------------------

export const createMeeting: Handler = async (req, user, deps) => {
  if (await getUpcomingMeeting(deps)) throw conflict('There is already an upcoming meeting');

  let leaderEmail = user.email;
  if (isAdmin(user)) {
    const requested = optionalString(req.body, 'leaderEmail')?.toLowerCase();
    if (requested) leaderEmail = (await requireApprovedUser(deps, requested, 'leaderEmail')).email;
  } else {
    if ((await designatedNextLeader(deps)) !== user.email) {
      throw forbidden('Only the member the last leader handed off to (or an admin) can create the next meeting');
    }
    if (req.body.leaderEmail !== undefined && req.body.leaderEmail !== user.email) {
      throw forbidden('Only admins can assign someone else as leader');
    }
  }

  const dateTime = requireIsoDate(req.body, 'dateTime');
  const meeting: Meeting = {
    id: deps.newId(),
    title: optionalString(req.body, 'title') ?? 'Book Club',
    dateTime,
    videoUrl: optionalUrl(req.body, 'videoUrl'),
    leaderEmail,
    status: 'UPCOMING',
    phase: 'PLANNING',
    createdAt: deps.now().toISOString(),
  };
  await saveMeeting(deps, meeting);
  return { status: 201, body: { meeting: await meetingView(deps, meeting, user) }, audit: { label: meeting.title } };
};

export const updateMeeting: Handler = async (req, user, deps) => {
  const meeting = await getMeeting(deps, req.params.id!);
  requireManager(user, meeting);
  if (meeting.status === 'PAST') throw conflict('Past meetings cannot be edited');

  const updated: Meeting = { ...meeting };
  if (req.body.title !== undefined) updated.title = requireString(req.body, 'title');
  if (req.body.dateTime !== undefined) updated.dateTime = requireIsoDate(req.body, 'dateTime');
  if (req.body.videoUrl !== undefined) updated.videoUrl = optionalUrl(req.body, 'videoUrl');
  if (req.body.leaderEmail !== undefined) {
    if (!isAdmin(user)) throw forbidden('Only admins can reassign the leader');
    const email = requireString(req.body, 'leaderEmail').toLowerCase();
    updated.leaderEmail = (await requireApprovedUser(deps, email, 'leaderEmail')).email;
  }
  await saveMeeting(deps, updated);
  return { body: { meeting: await meetingView(deps, updated, user) }, audit: { label: updated.title } };
};

/**
 * Pick the book for a meeting, either from The Lineup (`nominationId`) or any book
 * (`isbn`). A book picked from The Lineup comes off it; a previously picked Lineup
 * book goes back on, so changing your mind never loses a nomination.
 */
export const chooseBook: Handler = async (req, user, deps) => {
  const meeting = await getMeeting(deps, req.params.id!);
  requireManager(user, meeting);
  requireUpcoming(meeting);

  const nominationId = optionalString(req.body, 'nominationId');
  const isbnInput = optionalString(req.body, 'isbn');
  if (!nominationId === !isbnInput) throw badRequest('Send either "nominationId" or "isbn"');

  let nomination: Nomination | undefined;
  let isbn: string;
  if (nominationId) {
    nomination = await getNomination(deps, nominationId);
    if (!nomination) throw notFound('That nomination is no longer on The Lineup');
    isbn = (await resolveBook(deps, nomination.bookIsbn)).isbn;
  } else {
    isbn = (await resolveBook(deps, isbnInput!)).isbn;
    // Picking a book that happens to be on The Lineup counts as picking that nomination.
    nomination = (await listLineup(deps)).find((n) => n.bookIsbn === isbn);
  }

  await returnToLineup(deps, meeting, nomination?.id);
  if (nomination) await deleteNomination(deps, nomination.id);

  const updated: Meeting = { ...meeting, phase: 'SELECTED', bookIsbn: isbn, chosenNomination: nomination };
  await saveMeeting(deps, updated);
  await ensureHiResCover(deps, isbn);
  const view = await meetingView(deps, updated, user);
  return { body: { meeting: view }, audit: { label: view.book?.title ?? isbn } };
};

/** Un-pick the book. If it came from The Lineup it goes back there. */
export const clearBook: Handler = async (req, user, deps) => {
  const meeting = await getMeeting(deps, req.params.id!);
  requireManager(user, meeting);
  requireUpcoming(meeting);
  await returnToLineup(deps, meeting);
  const updated: Meeting = { ...meeting, phase: 'PLANNING', bookIsbn: undefined, chosenNomination: undefined };
  await saveMeeting(deps, updated);
  return { body: { meeting: await meetingView(deps, updated, user) }, audit: { label: meeting.title } };
};

/** Put a meeting's previously picked Lineup book back, unless it is being picked again. */
async function returnToLineup(deps: Deps, meeting: Meeting, keepNominationId?: string): Promise<void> {
  const previous = meeting.chosenNomination;
  if (previous && previous.id !== keepNominationId) await saveNomination(deps, previous);
}

export const completeMeeting: Handler = async (req, user, deps) => {
  const meeting = await getMeeting(deps, req.params.id!);
  requireManager(user, meeting);
  requireUpcoming(meeting);
  if (!meeting.bookIsbn) throw conflict('Pick the book before wrapping up the meeting');

  const email = requireString(req.body, 'nextLeaderEmail').toLowerCase();
  const nextLeader = await requireApprovedUser(deps, email, 'nextLeaderEmail');

  // Re-keys the item onto the PAST GSI partition.
  const updated: Meeting = { ...meeting, status: 'PAST', phase: 'PAST', nextLeaderEmail: nextLeader.email };
  await saveMeeting(deps, updated);
  return { body: { meeting: updated }, audit: { label: meeting.title } };
};

// ---------------------------------------------------------------------------
// The Lineup: the club's standing list of nominations
// ---------------------------------------------------------------------------

/** A nomination as The Lineup shows it to `user`: who nominated it and its votes. */
function nominationCard(n: Nomination, user: User, votes: { userEmail: string }[], nominatedBy: Person | undefined) {
  return {
    id: n.id,
    createdAt: n.createdAt,
    nominatedBy,
    canWithdraw: n.nominatedByEmail === user.email || isAdmin(user),
    votes: votes.length,
    myVote: votes.some((v) => v.userEmail === user.email),
  };
}

export const getLineup: Handler = async (_req, user, deps) => {
  const [lineup, meeting] = await Promise.all([listLineup(deps), getUpcomingMeeting(deps)]);
  await backfillCovers(
    deps,
    lineup.map((n) => n.bookIsbn),
  );
  const [books, people, votes, counts] = await Promise.all([
    getBooks(
      deps,
      lineup.map((n) => n.bookIsbn),
    ),
    getPeople(
      deps,
      lineup.map((n) => n.nominatedByEmail),
    ),
    lineupVotes(deps),
    commentCounts(
      deps,
      lineup.map((n) => ({ kind: 'book' as const, id: n.bookIsbn })),
    ),
  ]);
  const views = lineup.map((n, i) => ({
    ...nominationCard(n, user, votes.get(n.id) ?? [], people.get(n.nominatedByEmail)),
    book: books.get(n.bookIsbn) ?? { isbn: n.bookIsbn, title: n.bookIsbn, author: '' },
    commentCount: counts[i] ?? 0,
  }));
  // Most-wanted first; ties keep nomination order (oldest first).
  views.sort((a, b) => b.votes - a.votes || a.createdAt.localeCompare(b.createdAt));
  return {
    body: {
      nominations: views,
      // Who can pick a book from here for the upcoming meeting.
      canPick: !!meeting && canManage(user, meeting),
      meetingId: meeting?.id ?? null,
    },
  };
};

/** The Lineup card for one book (what getLineup returns for it), or null when it isn't on The Lineup. */
export async function nominationForBook(deps: Deps, isbn: string, user: User) {
  const nomination = (await listLineup(deps)).find((n) => n.bookIsbn === isbn);
  if (!nomination) return null;
  const [people, votes] = await Promise.all([
    getPeople(deps, [nomination.nominatedByEmail]),
    deps.store.query<NominationVoteItem>(keys.lineupPartition, keys.nominationVotePrefix(nomination.id)),
  ]);
  return nominationCard(nomination, user, votes, people.get(nomination.nominatedByEmail));
}

export const nominate: Handler = async (req, user, deps) => {
  const book = await resolveBook(deps, requireString(req.body, 'isbn'));
  const [lineup, meeting] = await Promise.all([listLineup(deps), getUpcomingMeeting(deps)]);
  if (lineup.some((n) => n.bookIsbn === book.isbn)) throw conflict(`"${book.title}" is already on The Lineup`);
  if (meeting?.bookIsbn === book.isbn) throw conflict(`"${book.title}" is already the pick for the next meeting`);

  const nomination: Nomination = {
    id: deps.newId(),
    bookIsbn: book.isbn,
    nominatedByEmail: user.email,
    createdAt: deps.now().toISOString(),
  };
  await saveNomination(deps, nomination);
  return { status: 201, body: { nomination: { ...nomination, book } }, audit: { label: book.title } };
};

/** Members can withdraw their own nominations; admins can remove any. */
export const withdrawNomination: Handler = async (req, user, deps) => {
  const nomination = await getNomination(deps, req.params.id!);
  if (!nomination) throw notFound('Nomination not found');
  if (nomination.nominatedByEmail !== user.email && !isAdmin(user)) {
    throw forbidden('You can only withdraw your own nominations');
  }
  await deleteNomination(deps, nomination.id);
  await deleteVotes(deps, nomination.id);
  const book = await getBook(deps, nomination.bookIsbn);
  return {
    body: { ok: true },
    audit: { label: book?.title ?? nomination.bookIsbn, nominatedBy: nomination.nominatedByEmail },
  };
};

async function deleteVotes(deps: Deps, nominationId: string): Promise<void> {
  const items = await deps.store.query<NominationVoteItem>(
    keys.lineupPartition,
    keys.nominationVotePrefix(nominationId),
  );
  await Promise.all(items.map((i) => deps.store.delete(i.PK, i.SK)));
}

/** One vote per member per Lineup book; voting again is harmless. */
export const voteForNomination: Handler = async (req, user, deps) => {
  const nomination = await getNomination(deps, req.params.id!);
  if (!nomination) throw notFound('That book is no longer on The Lineup');
  const vote: NominationVote = {
    nominationId: nomination.id,
    userEmail: user.email,
    createdAt: deps.now().toISOString(),
  };
  await deps.store.put({ ...keys.nominationVote(nomination.id, user.email), ...vote });
  return { body: { ok: true }, audit: { label: (await getBook(deps, nomination.bookIsbn))?.title } };
};

export const removeVote: Handler = async (req, user, deps) => {
  const { PK, SK } = keys.nominationVote(req.params.id!, user.email);
  await deps.store.delete(PK, SK);
  const nomination = await getNomination(deps, req.params.id!);
  const book = nomination && (await getBook(deps, nomination.bookIsbn));
  return { body: { ok: true }, audit: book ? { label: book.title } : {} };
};

export const searchBooks: Handler = async (req, _user, deps) => {
  const q = (req.query.q ?? '').trim();
  if (q.length < 2) throw badRequest('Search query "q" must be at least 2 characters');
  return { body: { results: await deps.books.search(q) } };
};

export const getBookByIsbn: Handler = async (req, _user, deps) => {
  return { body: { book: await resolveBook(deps, req.params.isbn!) } };
};
