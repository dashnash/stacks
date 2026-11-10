import { badRequest, conflict, forbidden, notFound, optionalInt, requireString, strip, type AppDeps, type AppRoutes } from '@stacks/api';
import { assertOpen, loadEvent } from './events';
import { keys, MAX_GUESTS, parseCourse, parseTags, RSVP_STATUSES, type Dish, type DishItem, type Rsvp, type RsvpStatus } from './model';

export function dishRoutes(api: AppRoutes<AppDeps>) {
  api
    .member(
      'PUT',
      '/events/:id/rsvp',
      async (req, v) => {
        const { event } = await loadEvent(v.deps, req.params.id!);
        assertOpen(v.deps, event);
        const status = req.body.status as RsvpStatus;
        if (!RSVP_STATUSES.includes(status)) throw badRequest(`"status" must be one of ${RSVP_STATUSES.join(', ')}`);
        const guests = status === 'going' ? (optionalInt(req.body, 'guests', 0, MAX_GUESTS) ?? 0) : 0;
        const rsvp: Rsvp = { eventId: event.id, userId: v.user.id, status, guests, updatedAt: v.deps.now().toISOString() };
        await v.deps.store.put({ ...keys.rsvp(event.id, v.user.id), ...rsvp });
        return { body: { rsvp: { ...rsvp, name: v.user.name } }, audit: { label: event.title, status, guests } };
      },
      { audit: 'rsvp.set' },
    )
    .member(
      'POST',
      '/events/:id/dishes',
      async (req, v) => {
        const { event, dishes } = await loadEvent(v.deps, req.params.id!);
        assertOpen(v.deps, event);
        const course = parseCourse(req.body.course);
        if (dishes.filter((d) => d.course === course).length >= event.needs[course]) throw conflict(`${course} are covered: pick another course`);
        const dish: Dish = {
          id: v.deps.newId(),
          eventId: event.id,
          course,
          name: requireString(req.body, 'name', 60),
          serves: optionalInt(req.body, 'serves', 1, 100) ?? null,
          tags: parseTags(req.body.tags),
          bringerId: v.user.id,
          createdAt: v.deps.now().toISOString(),
        };
        await v.deps.store.put({ ...keys.dish(event.id, dish.id), ...dish });
        return { status: 201, body: { dish: { ...dish, bringerName: v.user.name } }, audit: { label: `${dish.name} (${course}) for ${event.title}` } };
      },
      { audit: 'dish.add' },
    )
    .member(
      'PATCH',
      '/events/:id/dishes/:dishId',
      async (req, v) => {
        const found = await v.deps.store.get<DishItem>(keys.dish(req.params.id!, req.params.dishId!).PK, keys.dish(req.params.id!, req.params.dishId!).SK);
        if (!found) throw notFound('That dish is gone');
        if (found.bringerId !== v.user.id) throw forbidden('You can only change your own dish');
        const dish: Dish = {
          ...(strip(found) as Dish),
          name: req.body.name === undefined ? found.name : requireString(req.body, 'name', 60),
          serves: req.body.serves === undefined ? found.serves : (optionalInt(req.body, 'serves', 1, 100) ?? null),
          tags: req.body.tags === undefined ? found.tags : parseTags(req.body.tags),
        };
        await v.deps.store.put({ ...keys.dish(dish.eventId, dish.id), ...dish });
        return { body: { dish }, audit: { label: dish.name } };
      },
      { audit: 'dish.update' },
    )
    .member(
      'DELETE',
      '/events/:id/dishes/:dishId',
      async (req, v) => {
        const k = keys.dish(req.params.id!, req.params.dishId!);
        const found = await v.deps.store.get<DishItem>(k.PK, k.SK);
        if (!found) throw notFound('That dish is gone');
        // Your own dish, or any dish if you're a host.
        if (found.bringerId !== v.user.id && !v.canManageAccess) throw forbidden('You can only remove your own dish');
        await v.deps.store.delete(k.PK, k.SK);
        return { body: { ok: true }, audit: { label: found.name, bringer: found.bringerId } };
      },
      { audit: 'dish.remove' },
    );
}
