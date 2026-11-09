# App template

`npm run new-app -- <slug>` copies this folder into `apps/<slug>/` (see `tools/new-app`). It is not a
workspace: it is never built or tested here; the scaffold test builds and tests a copy.

Placeholders: `__SLUG__`, `__TITLE__` (the app's name; HTML-escaped in `.html`) and
`/*__PERSONAS__*/ []` in `api/demo-data.ts` (one demo persona per role). Everything else reads the
manifest at runtime.

What a new app gets, and what to replace:

| Keep | Replace with the app's own features |
| --- | --- |
| `api/index.ts`, `api/manifest.ts`, `web/src/main.tsx`, `web/src/demo.tsx`, `web/src/demo/setup.ts`, vite and test config | `api/routes.ts` (starter notes), `api/demo-data.ts` (seed), `web/src/demo/pages.ts` (pages to screenshot), `web/src/App.tsx` (below the header), `web/src/styles.css`, `tests/api.test.ts`, `tests/app.test.tsx` |

Keep `<AccountMenu />` at the top right of the header, and keep `web/src/demo/setup.ts` exporting `App`
and `demoOptions()`: `tools/app-conformance` checks both.
