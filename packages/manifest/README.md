# @stacks/manifest

Types and validation for `apps/<slug>/app.manifest.json`. See the spec's "App manifest" section for
every field. `validateManifest(json)` returns `{ ok, manifest | errors[] }` with every problem at
once; `parseManifest(json, source)` throws one readable error. Helpers: `canManageAccess(manifest, role)`,
`roleDef`, `hasModule`, `MODULES`, `RESERVED_SLUGS`, `secretParameterName(envTag, slug, name)`.

Rules worth knowing: slugs are 3-30 chars `[a-z0-9-]`; `topRole` must `canManageAccess`; public apps
need a `defaultRole` that cannot manage access; CSP additions must be https origins (max 10 per directive);
`secrets` are at most 10 `{ name: "UPPER_CASE", description?, optional? }`, with names only (never values);
`needsEmail: true` (off by default) gives the app people's email addresses: a platform decision, reviewed by the code owners.

`modules`: `comments`, `votes`, `contentPacks`, `uploads`, `notifications`, `scheduledJobs`, `email`,
`realtime` (live events over an AppSync Event API of the app's own; see `@stacks/api` "Realtime").
