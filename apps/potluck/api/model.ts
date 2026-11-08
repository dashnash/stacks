import { badRequest, type Item } from '@stacks/api';

/** Each potluck is one partition: the event, its dish sign-ups and its RSVPs (one query loads a page). */
export const COURSES = ['mains', 'sides', 'desserts', 'drinks'] as const;
export type Course = (typeof COURSES)[number];
export const COURSE_LABEL: Record<Course, string> = { mains: 'Mains', sides: 'Sides', desserts: 'Desserts', drinks: 'Drinks' };
export const COURSE_EMOJI: Record<Course, string> = { mains: '🍲', sides: '🥗', desserts: '🍰', drinks: '🥤' };

export const TAGS = ['vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'nut-free'] as const;
export type Tag = (typeof TAGS)[number];

export const RSVP_STATUSES = ['going', 'maybe', 'no'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export const MAX_PER_COURSE = 20;
export const MAX_GUESTS = 5;
/** A potluck stays on the upcoming list until this long after it starts. */
export const STILL_ON_MS = 6 * 3_600_000;

export type Needs = Record<Course, number>;

export interface PotluckEvent {
  id: string;
  title: string;
  startsAt: string;
  place: string;
  notes: string;
  needs: Needs;
  hostEmail: string;
  hostName: string;
  cancelled: boolean;
  createdAt: string;
}

export interface Dish {
  id: string;
  eventId: string;
  course: Course;
  name: string;
  serves: number | null;
  tags: Tag[];
  bringerEmail: string;
  bringerName: string;
  createdAt: string;
}

export interface Rsvp {
  eventId: string;
  email: string;
  name: string;
  status: RsvpStatus;
  guests: number;
  updatedAt: string;
}

export const keys = {
  event: (id: string) => ({ PK: `EVENT#${id}`, SK: 'EVENT' }),
  eventIndex: (e: Pick<PotluckEvent, 'id' | 'startsAt'>) => ({ GSI1PK: 'EVENTS', GSI1SK: `${e.startsAt}#${e.id}` }),
  dish: (eventId: string, id: string) => ({ PK: `EVENT#${eventId}`, SK: `DISH#${id}` }),
  rsvp: (eventId: string, email: string) => ({ PK: `EVENT#${eventId}`, SK: `RSVP#${email}` }),
};

export type EventItem = Item & PotluckEvent;
export type DishItem = Item & Dish;
export type RsvpItem = Item & Rsvp;

/** `needs` from a request: every course a whole number 0-20 (missing courses keep `fallback`). */
export function parseNeeds(raw: unknown, fallback?: Needs): Needs {
  if (raw === undefined && fallback) return fallback;
  if (typeof raw !== 'object' || raw === null) throw badRequest('"needs" must say how many of each course');
  const out = {} as Needs;
  for (const c of COURSES) {
    const v = (raw as Record<string, unknown>)[c] ?? fallback?.[c] ?? 0;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_PER_COURSE) throw badRequest(`"needs.${c}" must be a whole number from 0 to ${MAX_PER_COURSE}`);
    out[c] = v;
  }
  if (!COURSES.some((c) => out[c] > 0)) throw badRequest('A potluck needs at least one dish');
  return out;
}

export function parseCourse(raw: unknown): Course {
  if (!COURSES.includes(raw as Course)) throw badRequest(`"course" must be one of ${COURSES.join(', ')}`);
  return raw as Course;
}

export function parseTags(raw: unknown): Tag[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((t) => !TAGS.includes(t as Tag))) throw badRequest(`"tags" may only include ${TAGS.join(', ')}`);
  return [...new Set(raw as Tag[])];
}
