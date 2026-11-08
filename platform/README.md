# platform/

The platform itself, deployed as `stacks-<env>-platform`.

- `api/`: the Platform API (one Lambda). Portal sign-in with Google, master sessions on
  `auth.<domain>`, the app handshake (`GET /authorize`, `POST /api/apps/:slug/token`, PKCE),
  grants and access requests, app registration from the SSM registry, the access grid rules,
  notifications, the central audit feed, sign-out everywhere. `tests/e2e.test.ts` runs two real
  apps and the platform together through the whole flow.
- `web/`: the portal SPA: catalog, sign-in, app pages, profile, inbox, access grid, activity log.
  `npm run demo -w platform/web` runs it on the real Platform API in the browser with sample data.

Apps never import from here (the import rule enforces it); they reach the platform through
`@stacks/api`'s platform client.
