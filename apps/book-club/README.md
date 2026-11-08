# MOFO Book Klub (`book-club`)

The club's next meeting, The Lineup of nominations, the shelf of past reads, and a discussion for
every book and meeting. Ported from `dashnash/MofoBookKlubPortal` onto Stacks; the cut-over is in
`docs/BOOK_CLUB_MIGRATION.md`.

| Path | What |
| --- | --- |
| `app.manifest.json` | Private; roles Owner / Admin / Member; modules `comments`, `contentPacks` |
| `api/routes.ts` | Route table. Handlers in `books/`, `meetings/`, `easter-egg/` are Book Club's, unchanged in shape |
| `api/users/repo.ts` | Members and names now come from the platform (`@stacks/api` `appMembers`/`getPeople`) |
| `api/index.ts` | Lambda entry: book sources, the content bucket for critic photos |
| `content/eggs/` | `quotes.json` (in git). Face photos live only in the content bucket |
| `web/` | The UI (React + Tailwind). `src/lib/api.ts` is the typed client over the Stacks session |
| `web/src/demo/` | Demo data and fake catalog; `npm run demo -w apps/book-club` |
| `tests/api`, `tests/web` | Book Club's original tests, running on the Stacks test harness |

What changed in the move:
- Sign-in, waiting for approval and roles are the platform's. The admin page's member controls
  read and write platform grants (`/stacks/access`), with the platform's rules.
- Display names are set on the platform profile; the settings page links there.
- Comments use the shared `@stacks/comments` module (same storage keys).
- Removing someone no longer deletes their Lineup votes; they're credited to "Former member" like
  comments and nominations.
