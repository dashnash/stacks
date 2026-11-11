# @stacks/testing

Run an app's real API in memory (MemoryStore, fake platform, ticking clock, sequential ids).

```ts
import { createTestHarness } from '@stacks/testing';
const t = createTestHarness({ manifest, routes });

const res = await t.call('POST', '/items', { as: 'ann@test.dev', role: 'EDITOR', body: { title: 'x' } });
expect(res.status).toBe(201);              // res: { status, body, headers, cookies }
await t.call('GET', '/public/items');      // signed out
t.platform.audit;                          // events mirrored to the platform
t.advance(86_400_000);                     // move the clock
t.store;                                   // inspect data
```

`as` takes an email (name = part before "@", id = `testUserId(email)`) or `{ email, name, id? }`. Like the
platform, the app gets no email (on `v.user` or members) unless its manifest has `needsEmail`. Seed
members with `t.platform.members = [memberFor('ann@test.dev', 'EDITOR', 'Ann')]`. `role` defaults to the manifest's
`defaultRole`. `noCsrf: true` drops the CSRF header. `cookieValue(res.cookies, name)` reads Set-Cookie.

Realtime (manifest module `realtime`): `t.realtime` is a `FakeRealtime` that records server publishes
(`t.realtime.published` → `[{ channel, data }]`, `t.realtime.on('counter/main')` → data list) with the
real checks (channel names, 4 KB). `POST /realtime/token` works as in production; check a token's
claims with `verifyRealtimeToken(t.realtime.key, token, t.deps.now().getTime())`.
