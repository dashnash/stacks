import type { Course, PotluckEvent, RsvpStatus, Tag } from '../../api/model';

export type EventSummary = PotluckEvent & { filled: Record<Course, number>; headcount: number; myRsvp: RsvpStatus | null; myDishes: number };
export interface DishView {
  id: string;
  course: Course;
  name: string;
  serves: number | null;
  tags: Tag[];
  bringerName: string;
  mine: boolean;
  canRemove: boolean;
}
export interface RsvpView {
  name: string;
  status: RsvpStatus;
  guests: number;
  mine: boolean;
}
export interface EventDetail {
  event: PotluckEvent & { hostName: string };
  canEdit: boolean;
  dishes: DishView[];
  rsvps: RsvpView[];
  headcount: number;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
export const whenText = (iso: string) => `${dayFmt.format(new Date(iso))} · ${timeFmt.format(new Date(iso))}`;
export const isOver = (e: PotluckEvent) => Date.parse(e.startsAt) + 6 * 3_600_000 < Date.now();
