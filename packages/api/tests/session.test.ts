import { describe, expect, it } from 'vitest';
import { createTestHarness, userFor } from '@stacks/testing';
import { endUserSessions, readSession, SESSION_COOKIE, SESSION_IDLE_DAYS } from '../src/session';
import { manifest, routes } from './fixtures';

const DAY = 86_400_000;

describe('app sessions', () => {
  it('last while used, and end after 90 idle days', async () => {
    const t = createTestHarness({ manifest, routes });
    const token = await t.sessionFor('r@test.dev', 'READER');
    t.advance(60 * DAY);
    expect(await readSession(t.deps, token)).not.toBeNull(); // refreshed here
    t.advance(60 * DAY);
    expect(await readSession(t.deps, token)).not.toBeNull();
    t.advance((SESSION_IDLE_DAYS + 1) * DAY);
    expect(await readSession(t.deps, token)).toBeNull();
  });

  it('can all be ended for one user (revocation)', async () => {
    const t = createTestHarness({ manifest, routes });
    const a = await t.sessionFor(userFor('r@test.dev'), 'READER');
    const b = await t.sessionFor(userFor('R@test.dev'), 'READER');
    const other = await t.sessionFor('x@test.dev', 'READER');
    expect(await endUserSessions(t.deps, userFor('r@test.dev').id)).toBe(2);
    expect((await t.call('GET', '/notes', { cookies: { [SESSION_COOKIE]: a } })).status).toBe(401);
    expect((await t.call('GET', '/notes', { cookies: { [SESSION_COOKIE]: b } })).status).toBe(401);
    expect((await t.call('GET', '/notes', { cookies: { [SESSION_COOKIE]: other } })).status).toBe(200);
  });

  it('ignores tokens that are not app sessions', async () => {
    const t = createTestHarness({ manifest, routes });
    expect(await readSession(t.deps, 'not-a-session')).toBeNull();
    expect(await readSession(t.deps, 'stk_made-up')).toBeNull();
  });
});
