# Stacks — agent instructions

Stacks is a monorepo platform for building small apps on AWS that share one Google sign-in, a catalog
and a central access grid. **Read `docs/PLATFORM_SPEC.md` before any platform work.** It is the source
of truth for architecture, decisions and the phased build plan.

## Current state

Phases 1-3 are built: `packages/*` (SDK) and `packages/modules/comments`, `platform/api` and
`platform/web`, the `hello` and `book-club` apps, `tools/migrate-book-club`, `infra/` and the
workflows. The Book Club cut-over itself is run by Dash (`docs/BOOK_CLUB_MIGRATION.md`). Next is
**Phase 4 — `/new-app`**.

## Commands

- `npm test`, `npm run typecheck`, `npm run lint` (import rule), `npm run build`
- `npm run demo -w apps/<slug>`: the app's in-browser demo; `npm run demo -w platform/web`: the portal's
- `cd infra && npx cdk synth -c env=staging [-c app=<slug>]`: no AWS credentials needed

## Where things are

- Package APIs: `packages/*/README.md` (read these, not the source, when building an app)
- Worked examples: `apps/hello/` (small: manifest, `api/routes.ts`, `api/demo-data.ts`, `web/src/App.tsx`, tests)
  and `apps/mofobookklub/` (large: comments module, content bucket, admin page on `/stacks/access`)
- Media of real people (photos) never goes in git: it lives in the app's content bucket.
- Conformance rules for all apps: `tools/app-conformance` (spec: "Account menu").

## Reference implementation

Most shared code is extracted from the MOFO Book Club Portal
([dashnash/MofoBookKlubPortal](https://github.com/dashnash/MofoBookKlubPortal)). The spec's
"Shared services" tables name the source file for each package. Port and generalize that code (keep
its tests) rather than rewriting from scratch.

## Rules

- Node 22, TypeScript, npm workspaces, Vitest. AWS CDK v2 in us-east-1.
- Only CI deploys. Never ask for or use AWS credentials in a session.
- `apps/*` may import only `@stacks/*` packages, never another app or `platform/` internals.
- **App tasks** (building or changing one app, e.g. via `/new-app`): edit only `apps/<slug>/`. If the
  app needs something the SDK lacks, stop and propose a separate platform change.
- **Platform tasks**: changes to `packages/`, `platform/`, `infra/` or `.github/` need review from
  `@dashnash` (`CODEOWNERS`). Keep each package's `README.md` an API cheat-sheet under ~300 lines; app
  agents read those instead of source.
- Every feature ships with tests; every app must keep a working in-browser demo mode.
- Every app has `<AccountMenu />` at the top right of its header and exports `App` + `demoOptions()`
  from `web/src/demo/setup.ts`; `tools/app-conformance` enforces both.
- If code and spec disagree, raise it; update `docs/PLATFORM_SPEC.md` in the same PR as the change.
