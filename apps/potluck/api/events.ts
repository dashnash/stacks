import { appMembers, forbidden, notFound, optionalString, requireIsoDate, requireString, strip, type AppDeps, type AppRoutes } from '@stacks/api';
import { COURSES, keys, parseNeeds, STILL_ON_MS, type DishItem, type EventItem, type PotluckEvent, type RsvpItem } from './model';

export async function loadEvent(deps: AppDeps, id: string) {
  const items = await deps.store.query<EventItem | DishItem | RsvpItem>(`EVENT#${id}`);
  const event = items.find((i) => i.SK === 'EVENT') as EventItem | undefined;
  if (!event) throw notFound('That potluck is gone');
  return {
    event: strip(event) as PotluckEvent,
    dishes: items.filter((i) => i.SK.startsWith('DISH#')).map((i) => strip(i as DishItem)),
    rsvps: items.filter((i) => i.SK.startsWith('RSVP#')).map((i) => strip(i as RsvpItem)),
  };
}

export async function upcomingEvents(deps: AppDeps): Promise<PotluckEvent[]> {
  const from = new Date(deps.now().getTime() - STILL_ON_MS).toISOString();
  return (await deps.store.queryGsi1<EventItem>('EVENTS')).filter((e) => e.startsAt >= from).map((e) => strip(e) as PotluckEvent);
}

/** Whether a potluck can still take sign-ups and RSVPs. */
export function assertOpen(deps: AppDeps, event: PotluckEvent) {
  if (event.cancelled) throw forbidden('This potluck was cancelled');
  if (Date.parse(event.startsAt) + STILL_ON_MS < deps.now().getTime()) throw forbidden('This potluck is over');
}

function fields(body: Record<string, unknown>, current?: PotluckEvent) {
  return {
    title: current && body.title === undefined ? current.title : requireString(body, 'title', 80),
    startsAt: current && body.startsAt === undefined ? current.startsAt : new Date(requireIsoDate(body, 'startsAt')).toISOString(),
    place: current && body.place === undefined ? current.place : requireString(body, 'place', 200),
    notes: current && body.notes === undefined ? current.notes : (optionalString(body, 'notes', 1000) ?? ''),
    needs: parseNeeds(body.needs, current?.needs),
  };
}

export function eventRoutes(api: AppRoutes<AppDeps>) {
  api
    // Signed-out visitors learn only how many potlucks are coming up: no titles, places or names.
    .public('GET', '/public/summary', async (_req, ctx) => ({
      body: { upcoming: (await upcomingEvents(ctx.deps)).filter((e) => !e.cancelled).length },
    }))
    .member('GET', '/events', async (_req, v) => {
      const events = await upcomingEvents(v.deps);
      const withCounts = await Promise.all(
        events.map(async (e) => {
          const { dishes, rsvps } = await loadEvent(v.deps, e.id);
          const filled = Object.fromEntries(COURSES.map((c) => [c, dishes.filter((d) => d.course === c).length]));
          const going = rsvps.filter((r) => r.status === 'going');
          const mine = rsvps.find((r) => r.email === v.user.email);
          return {
            ...e,
            filled,
            headcount: going.reduce((n, r) => n + 1 + r.guests, 0),
            myRsvp: mine?.status ?? null,
            myDishes: dishes.filter((d) => d.bringerEmail === v.user.email).length,
          };
        }),
      );
      return { body: { events: withCounts, canHost: v.canManageAccess } };
    })
    .member('GET', '/events/:id', async (req, v) => {
      const { event, dishes, rsvps } = await loadEvent(v.deps, req.params.id!);
      const isHost = v.canManageAccess;
      return {
        body: {
          event,
          canEdit: isHost,
          dishes: dishes.map(({ bringerEmail, ...d }) => ({ ...d, mine: bringerEmail === v.user.email, canRemove: isHost || bringerEmail === v.user.email })),
          rsvps: rsvps.map(({ email, ...r }) => ({ ...r, mine: email === v.user.email })),
          headcount: rsvps.filter((r) => r.status === 'going').reduce((n, r) => n + 1 + r.guests, 0),
        },
      };
    })
    .role(
      ['HOST'],
      'POST',
      '/events',
      async (req, v) => {
        const now = v.deps.now().toISOString();
        const event: PotluckEvent = { id: v.deps.newId(), ...fields(req.body), hostEmail: v.user.email, hostName: v.user.name, cancelled: false, createdAt: now };
        await v.deps.store.put({ ...keys.event(event.id), ...keys.eventIndex(event), ...event });
        // Tell everyone else (platform inbox badge).
        const link = `${v.deps.config.appOrigin}/#/e/${event.id}`;
        const members = (await appMembers(v.deps)).filter((m) => m.email !== v.user.email);
        await Promise.all(members.map((m) => v.deps.platform.notify(m.email, `New potluck: ${event.title} (${new Date(event.startsAt).toDateString()})`, link).catch(() => undefined)));
        return { status: 201, body: { event }, audit: { label: event.title, notified: members.length } };
      },
      { audit: 'event.create' },
    )
    .role(
      ['HOST'],
      'PATCH',
      '/events/:id',
      async (req, v) => {
        const { event: current } = await loadEvent(v.deps, req.params.id!);
        if (current.cancelled) throw forbidden('This potluck was cancelled');
        const event: PotluckEvent = { ...current, ...fields(req.body, current) };
        // The index key carries the start time, so a new date moves it on the upcoming list.
        await v.deps.store.put({ ...keys.event(event.id), ...keys.eventIndex(event), ...event });
        return { body: { event }, audit: { label: event.title } };
      },
      { audit: 'event.update' },
    )
    .role(
      ['HOST'],
      'POST',
      '/events/:id/cancel',
      async (req, v) => {
        const { event } = await loadEvent(v.deps, req.params.id!);
        const cancelled = { ...event, cancelled: true };
        await v.deps.store.put({ ...keys.event(event.id), ...keys.eventIndex(event), ...cancelled });
        return { body: { event: cancelled }, audit: { label: event.title } };
      },
      { audit: 'event.cancel' },
    );
}
