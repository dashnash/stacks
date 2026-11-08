import type { Deps } from '../utils/deps.js';
import { notFound } from '../utils/http.js';
import {
  keys,
  meetingItem,
  normalizeMeeting,
  strip,
  type Meeting,
  type MeetingItem,
  type Nomination,
  type NominationItem,
} from '../utils/model.js';

export async function getMeeting(deps: Deps, id: string): Promise<Meeting> {
  const { PK, SK } = keys.meeting(id);
  const item = await deps.store.get<MeetingItem>(PK, SK);
  if (!item) throw notFound(`Meeting ${id} not found`);
  return normalizeMeeting(strip(item));
}

/** The single meeting that hasn't happened yet, if there is one. */
export async function getUpcomingMeeting(deps: Deps): Promise<Meeting | undefined> {
  const items = await deps.store.queryGsi1<MeetingItem>(keys.meetingsByStatus('UPCOMING'));
  return items[0] ? normalizeMeeting(strip(items[0])) : undefined;
}

/** Past meetings, most recent first. */
export async function listPastMeetings(deps: Deps): Promise<Meeting[]> {
  const items = await deps.store.queryGsi1<MeetingItem>(keys.meetingsByStatus('PAST'), { descending: true });
  return items.map((i) => normalizeMeeting(strip(i)));
}

/** Every meeting: the upcoming one (if any) first, then past meetings, most recent first. */
export async function listMeetings(deps: Deps): Promise<Meeting[]> {
  const [upcoming, past] = await Promise.all([getUpcomingMeeting(deps), listPastMeetings(deps)]);
  return upcoming ? [upcoming, ...past] : past;
}

export async function saveMeeting(deps: Deps, meeting: Meeting): Promise<void> {
  // Drop fields from the earlier voting workflow (results) when a meeting is re-saved.
  const { results: _results, ...rest } = meeting as Meeting & { results?: unknown };
  await deps.store.put(meetingItem(rest));
}

/** The Lineup, oldest nomination first. */
export async function listLineup(deps: Deps): Promise<Nomination[]> {
  await migrateMeetingNominations(deps);
  const items = await deps.store.query<NominationItem>(keys.lineupPartition, 'NOMINATION#');
  return items.map((i) => toNomination(strip(i))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getNomination(deps: Deps, id: string): Promise<Nomination | undefined> {
  const { PK, SK } = keys.nomination(id);
  const item = await deps.store.get<NominationItem>(PK, SK);
  return item ? toNomination(strip(item)) : undefined;
}

export async function saveNomination(deps: Deps, nomination: Nomination): Promise<void> {
  await deps.store.put({ ...keys.nomination(nomination.id), ...toNomination(nomination) });
}

export async function deleteNomination(deps: Deps, id: string): Promise<void> {
  const { PK, SK } = keys.nomination(id);
  await deps.store.delete(PK, SK);
}

function toNomination(n: Nomination): Nomination {
  return { id: n.id, bookIsbn: n.bookIsbn, nominatedByEmail: n.nominatedByEmail, createdAt: n.createdAt };
}

/**
 * Nominations used to belong to a meeting (PK MEETING#<id>). Move any the upcoming
 * meeting still has onto The Lineup, so nothing nominated before the change is lost.
 * Votes from the old ranked-choice workflow are no longer used and are left as is.
 */
async function migrateMeetingNominations(deps: Deps): Promise<void> {
  const meeting = await getUpcomingMeeting(deps);
  if (!meeting) return;
  const legacy = await deps.store.query<NominationItem>(keys.meetingPartition(meeting.id), 'NOMINATION#');
  for (const item of legacy) {
    await saveNomination(deps, strip(item));
    await deps.store.delete(item.PK, item.SK);
  }
}
