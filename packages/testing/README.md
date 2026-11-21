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

Logs: `const logs = captureLogs()` collects the lines written from then on (`logs.lines`: request
lines, errors, your `log.info`); call `logs.stop()` when done.
`expect(logs.lines.at(-1)).toMatchObject({ type: 'request', route: '/api/items', status: 201 })`.

Realtime (manifest module `realtime`): `t.realtime` is a `FakeRealtime` that records server publishes
(`t.realtime.published` → `[{ channel, data }]`, `t.realtime.on('counter/main')` → data list) with the
real checks (channel names, 4 KB). `POST /realtime/token` works as in production; check a token's
claims with `verifyRealtimeToken(t.realtime.key, token, t.deps.now().getTime())`.

Game rooms (manifest module `gameServer`): `t.games` is a `FakeGames`: no servers, just
`t.games.started` / `.stopped` (room ids) and the server's part to play: `await t.games.open(roomId)`,
`await t.games.end(roomId, 'idle', results)`, `t.games.crash(roomId)`, `await t.games.seats(roomId)`, `t.games.turn = [...]` (a TURN
key is set), `t.games.failNextStart = true`. Check a ticket with
`verifyGameTicket(t.games.gameKey, ticket, roomId, nowMs)`.

Test a game's rules with fake players and a fake clock:

```ts
import { playGame } from '@stacks/testing';
const g = playGame(game, { maxPlayers: 8, idleMinutes: 10, maxHours: 2, warmMinutes: 5 }); // warmMinutes: end `unused` if nobody joins (default: off)
const ann = g.join('ann@test.dev');           // or { id, name }; throws "join refused: full" (or "seats")
const annsPhone = g.join('ann@test.dev', { device: 'gun' });  // a second seat: id 'u_ann_test_dev~gun'
ann.input({ x: 1 }); ann.event('bump'); ann.ping(1);
g.advance(1000);                               // game time, tick by tick; g.stall(ms) freezes the server
ann.state; ann.states; ann.tick; ann.events; ann.roster; ann.welcome; ann.over; ann.closed; ann.pongs;
ann.drop(); ann.rejoin(); ann.leave(); ann.raw('state', 'not json');
g.ended; g.gone; g.logs; g.host;
```
