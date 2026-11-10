# @stacks/comments

Threaded comments on anything (manifest module `comments`). Ported from Book Club.

```ts
import { commentRoutes, commentCounts } from '@stacks/comments';

commentRoutes(api, {
  targets: {
    // kind in the URL -> does it exist? (canonical id + label for the activity log)
    book: async (id, deps) => { const b = await getBook(deps, id); return b && { id: b.isbn, label: b.title }; },
  },
  maxLength: 2000,                       // optional
  canModerate: (v) => v.canManageAccess, // optional: who may delete anyone's comment
});

const [n] = await commentCounts(deps.store, [{ kind: 'book', id: isbn }]);
```

Routes (members only): `GET|POST /threads/:kind/:id` (`{ body, parentId? }`),
`PATCH|DELETE /threads/:kind/:id/comments/:commentId`. Responses carry `author` (display name,
"Former member" once they lose access), `canEdit`, `canDelete`. A deleted comment with replies is
blanked so replies keep their place. Keys: `THREAD#<KIND>#<id>` / `COMMENT#<id>` and `COUNT`.

`migrateComments` (an `ItemMigration`) turns stored `authorEmail` into `authorId` for the user-id cut-over; apps with the module compose it into `api/migrations/user-ids.ts`.
