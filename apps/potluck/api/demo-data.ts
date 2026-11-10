import { fixtureUserId, type AppDeps } from '@stacks/api';
import type { Persona } from '@stacks/demo';
import { keys, type Course, type Dish, type PotluckEvent, type Rsvp, type RsvpStatus, type Tag } from './model';

/** One persona per role (top role first, so "Sign in" in the demo shows every control). */
export const personas: Persona[] = [
  { email: "olive@demo.stacks", name: "Olive", role: "HOST", blurb: "hosts most of the potlucks" },
  { email: "max@demo.stacks", name: "Max", role: "GUEST", blurb: "always brings dessert" },
  // Neighbours who bring dishes in the sample data: members, so their names show.
  { email: 'rosa@demo.stacks', name: 'Rosa', role: 'GUEST', blurb: 'a neighbour' },
  { email: 'dev@demo.stacks', name: 'Dev', role: 'GUEST', blurb: 'a neighbour' },
  { email: 'kim@demo.stacks', name: 'Kim', role: 'GUEST', blurb: 'a neighbour' },
];

/** Sample data for the demo: two upcoming potlucks (one nearly full) and one that's over. */
export async function seed(deps: AppDeps): Promise<void> {
  // People are stored by user id; demo personas get `fixtureUserId(email)`.
  const people = personas.map((p) => fixtureUserId(p.email));
  const host = people[0]!;
  const day = 86_400_000;
  // Local time: in the demo this runs in the visitor's browser, so 6 PM reads as 6 PM.
  const at = (days: number, hour: number) => {
    const d = new Date(deps.now().getTime() + days * day);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const created = deps.now().toISOString();

  const events: PotluckEvent[] = [
    { id: 'harvest', title: 'Fall Harvest Potluck', startsAt: at(5, 17), place: '14 Maple Court (back yard)', notes: 'Bring a chair if you have one. Kids welcome!', needs: { mains: 3, sides: 4, desserts: 2, drinks: 2 }, hostId: host, cancelled: false, createdAt: created },
    { id: 'game-night', title: 'Game Night Snacks', startsAt: at(12, 19), place: "Max's place, 3B", notes: 'Finger food only: we will be holding cards.', needs: { mains: 0, sides: 3, desserts: 2, drinks: 2 }, hostId: host, cancelled: false, createdAt: created },
    { id: 'summer', title: 'Summer Send-off', startsAt: at(-30, 16), place: 'Riverside Park, pavilion 2', notes: '', needs: { mains: 2, sides: 2, desserts: 2, drinks: 1 }, hostId: host, cancelled: false, createdAt: created },
  ];
  for (const e of events) await deps.store.put({ ...keys.event(e.id), ...keys.eventIndex(e), ...e });

  const dishes: [string, Course, string, number | null, Tag[], number][] = [
    ['harvest', 'mains', 'Butternut squash lasagna', 10, ['vegetarian'], 0],
    ['harvest', 'mains', 'Slow-cooker pulled pork', 12, ['gluten-free', 'dairy-free'], 2],
    ['harvest', 'sides', 'Kale & apple salad', 8, ['vegan', 'gluten-free', 'nut-free'], 1],
    ['harvest', 'sides', 'Cornbread', 12, ['vegetarian'], 3],
    ['harvest', 'desserts', 'Apple crumble', 10, ['vegetarian'], 4],
    ['harvest', 'drinks', 'Hot cider', null, ['vegan', 'gluten-free'], 0],
    ['game-night', 'sides', 'Seven-layer dip', 8, ['vegetarian', 'gluten-free'], 1],
    ['game-night', 'desserts', 'Brownie bites', 20, ['vegetarian'], 3],
    ['summer', 'mains', 'Grilled veggie skewers', 8, ['vegan'], 2],
  ];
  for (const [i, [eventId, course, name, serves, tags, who]] of dishes.entries()) {
    const p = people[who]!;
    const dish: Dish = { id: `d${i + 1}`, eventId, course, name, serves, tags, bringerId: p, createdAt: created };
    await deps.store.put({ ...keys.dish(eventId, dish.id), ...dish });
  }

  const rsvps: [string, number, RsvpStatus, number][] = [
    ['harvest', 0, 'going', 1],
    ['harvest', 1, 'going', 0],
    ['harvest', 2, 'going', 2],
    ['harvest', 3, 'maybe', 0],
    ['harvest', 4, 'going', 0],
    ['game-night', 0, 'going', 0],
    ['game-night', 3, 'going', 1],
    ['game-night', 4, 'no', 0],
  ];
  for (const [eventId, who, status, guests] of rsvps) {
    const p = people[who]!;
    const rsvp: Rsvp = { eventId, userId: p, status, guests, updatedAt: created };
    await deps.store.put({ ...keys.rsvp(eventId, p), ...rsvp });
  }
}
