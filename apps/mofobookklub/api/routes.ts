import { type AppRoutes, type HttpMethod, type RouteOptions, type Viewer } from '@stacks/api';
import { commentRoutes } from '@stacks/comments';
import { normalizeIsbn } from './books/isbn.js';
import { getBook } from './books/repo.js';
import * as bookRoutes from './books/routes.js';
import { deleteFace, listFaces, uploadFaces } from './easter-egg/faces.js';
import { randomEasterEgg } from './easter-egg/routes.js';
import { getMeeting } from './meetings/repo.js';
import * as meetings from './meetings/routes.js';
import { listApprovedUsers } from './users/repo.js';
import type { Deps } from './utils/deps.js';
import type { Handler } from './utils/handler.js';
import type { Role, User } from './utils/model.js';

/** Book Club's handlers take (req, user, deps); this is the signed-in viewer in that shape. */
export const toUser = (v: Viewer<Deps>): User => ({
  id: v.user.id,
  email: v.user.email,
  name: v.user.name,
  displayName: v.user.name,
  pictureUrl: v.user.pictureUrl,
  role: v.role as Role,
  createdAt: '',
});

/**
 * Book Club's API on Stacks. Sign-in, sessions, members and roles come from the platform; the
 * activity log (`GET /admin/audit`) and access controls (`/stacks/access`) from the SDK.
 */
export function routes(api: AppRoutes<Deps>) {
  const member = (method: HttpMethod, path: string, handler: Handler, audit?: string) =>
    api.member(method, path, (req, v) => handler(req, toUser(v), v.deps), audit ? ({ audit } satisfies RouteOptions) : undefined);
  // Owners and admins (the roles that manage access).
  const admin = (method: HttpMethod, path: string, handler: Handler, audit?: string) =>
    api.approver(method, path, (req, v) => handler(req, toUser(v), v.deps), audit ? ({ audit } satisfies RouteOptions) : undefined);

  // Public: the signed-out home page and book pages (book details only, nothing about members).
  api.public('GET', '/public/shelf', async (_req, ctx) => bookRoutes.getPublicShelf(ctx.deps));
  api.public('GET', '/public/books/:isbn', async (req, ctx) => bookRoutes.getPublicBook(ctx.deps, req.params.isbn!));

  member('GET', '/meetings/next', meetings.getNextMeeting);
  member('GET', '/meetings/history', meetings.getHistory);
  member('POST', '/meetings', meetings.createMeeting, 'meeting.create');
  member('PATCH', '/meetings/:id', meetings.updateMeeting, 'meeting.edit');
  member('POST', '/meetings/:id/book', meetings.chooseBook, 'meeting.pick_book');
  member('DELETE', '/meetings/:id/book', meetings.clearBook, 'meeting.clear_book');
  member('POST', '/meetings/:id/complete', meetings.completeMeeting, 'meeting.complete');

  member('GET', '/nominations', meetings.getLineup);
  member('POST', '/nominations', meetings.nominate, 'nomination.create');
  member('DELETE', '/nominations/:id', meetings.withdrawNomination, 'nomination.withdraw');
  member('POST', '/nominations/:id/vote', meetings.voteForNomination, 'vote.add');
  member('DELETE', '/nominations/:id/vote', meetings.removeVote, 'vote.remove');

  commentRoutes(api, {
    targets: {
      book: async (id, deps) => {
        const isbn = normalizeIsbn(id);
        const book = isbn ? await getBook(deps, isbn) : undefined;
        return book ? { id: book.isbn, label: book.title } : null;
      },
      meeting: async (id, deps) => {
        const meeting = await getMeeting(deps, id).catch(() => null);
        return meeting ? { id: meeting.id, label: meeting.title } : null;
      },
    },
  });

  member('GET', '/books/search', meetings.searchBooks);
  member('GET', '/books/editions', bookRoutes.searchEditions);
  member('GET', '/books/:isbn', meetings.getBookByIsbn);
  member('GET', '/books/:isbn/details', bookRoutes.getBookDetails);
  // Admins, or the member who nominated the book (checked in the handler).
  member('PATCH', '/books/:isbn', bookRoutes.updateBook, 'book.edit');
  member('GET', '/books/:isbn/lookup', bookRoutes.lookUpBookAgain);

  member('GET', '/easter-egg/random', randomEasterEgg);
  // The shared face photos on the critics' quotes. Uploads log themselves (one entry per batch).
  admin('GET', '/admin/faces', listFaces);
  admin('POST', '/admin/faces', uploadFaces);
  admin('DELETE', '/admin/faces/:name', deleteFace, 'critic.photo_delete');

  // Members, for pickers such as "who leads next?".
  member('GET', '/users', async (_req, _user, deps) => ({
    body: { users: (await listApprovedUsers(deps)).map((u) => ({ id: u.id, email: u.email, name: u.name, pictureUrl: u.pictureUrl, role: u.role })) },
  }));
}
