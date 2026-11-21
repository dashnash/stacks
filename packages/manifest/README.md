# @stacks/manifest

Types and validation for `apps/<slug>/app.manifest.json`. See the spec's "App manifest" section for
every field. `validateManifest(json)` returns `{ ok, manifest | errors[] }` with every problem at
once; `parseManifest(json, source)` throws one readable error. Helpers: `canManageAccess(manifest, role)`,
`roleDef`, `hasModule`, `MODULES`, `RESERVED_SLUGS`, `secretParameterName(envTag, slug, name)`.

Rules worth knowing: slugs are 3-30 chars `[a-z0-9-]`; `topRole` must `canManageAccess`; public apps
need a `defaultRole` that cannot manage access; CSP additions must be https origins (max 10 per directive);
`secrets` are at most 10 `{ name: "UPPER_CASE", description?, optional? }`, with names only (never values);
`needsEmail: true` (off by default) gives the app people's email addresses: a platform decision, reviewed by the code owners.

`native: ["haptics", "motion", "screen"]` (`NATIVE_CAPABILITIES`) declares what the app asks of the iOS app
(`@stacks/native`); the app refuses undeclared calls. Adding `motion` is sensitive (`SENSITIVE_NATIVE_CAPABILITIES`): code-owner review.

`modules`: `comments`, `votes`, `contentPacks`, `uploads`, `notifications`, `scheduledJobs`, `email`,
`realtime` (live events over an AppSync Event API of the app's own; see `@stacks/api` "Realtime"),
`gameServer` (a server-run game room per Fargate task; see `@stacks/game-server`). `gameServer`
without `realtime` is an error.

`gameServer` (optional, only with the module) sets its limits; `gameServerSettings(manifest)` fills in
the defaults (`GAME_SERVER_DEFAULTS`): `maxRooms` 1-10 (4), `maxPlayers` 2-16 (8), `idleMinutes` 1-60
(10), `maxHours` 0.25-4 (2), `warmMinutes` 1-15 (5, at most `idleMinutes`: how long a pre-warmed room waits to be taken), `cpu` 256/512/1024 (256), `memory` 512/1024/2048 MiB (512; at least
1024 with cpu 512 and 2048 with cpu 1024, Fargate's pairs).
