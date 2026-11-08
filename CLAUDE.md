# Stacks — agent instructions

Stacks is a monorepo platform for building small apps on AWS that share one Google sign-in, a catalog
and a central access grid. **Read `docs/PLATFORM_SPEC.md` before any platform work.** It is the source
of truth for architecture, decisions and the phased build plan.

## Current state

The repo holds the spec only. Building starts at **Phase 1 — Foundations** in the spec's Build plan.
Work phase by phase; do not start a phase until the previous phase's gate is demonstrated.

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
- If code and spec disagree, raise it; update `docs/PLATFORM_SPEC.md` in the same PR as the change.
