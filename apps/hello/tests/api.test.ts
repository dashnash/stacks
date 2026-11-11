import { describe, expect, it, vi } from 'vitest';
import { createTestHarness, memberFor, testUserId } from '@stacks/testing';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';

const harness = () => createTestHarness({ manifest, routes });

describe('Hello Board API', () => {
  it('lets members post and everyone read, newest first, with no emails in public', async () => {
    const t = harness();
    await t.call('POST', '/greetings', { as: { email: 'max@x.dev', name: 'Max' }, body: { text: 'one' } });
    await t.call('POST', '/greetings', { as: { email: 'ann@x.dev', name: 'Ann' }, body: { text: 'two' } });
    const pub = await t.call('GET', '/public/greetings');
    expect(pub.body.greetings.map((g: { text: string }) => g.text)).toEqual(['two', 'one']);
    expect(JSON.stringify(pub.body)).not.toContain('@x.dev');
    const mine = await t.call('GET', '/greetings', { as: 'max@x.dev' });
    expect(mine.body).toMatchObject({ canDelete: false, greetings: [{ text: 'two', authorId: testUserId('ann@x.dev') }, { text: 'one' }] });
  });

  it('rejects empty and over-long greetings and needs sign-in to post', async () => {
    const t = harness();
    expect((await t.call('POST', '/greetings', { body: { text: 'hi' } })).status).toBe(401);
    expect((await t.call('POST', '/greetings', { as: 'max@x.dev', body: { text: ' ' } })).status).toBe(400);
    expect((await t.call('POST', '/greetings', { as: 'max@x.dev', body: { text: 'x'.repeat(281) } })).status).toBe(400);
  });

  it('lets only owners delete, and logs it', async () => {
    const t = harness();
    const { body } = await t.call('POST', '/greetings', { as: 'max@x.dev', body: { text: 'oops' } });
    expect((await t.call('DELETE', `/greetings/${body.greeting.id}`, { as: 'max@x.dev' })).status).toBe(403);
    expect((await t.call('DELETE', `/greetings/${body.greeting.id}`, { as: 'olive@x.dev', role: 'OWNER' })).status).toBe(200);
    expect((await t.call('DELETE', `/greetings/${body.greeting.id}`, { as: 'olive@x.dev', role: 'OWNER' })).status).toBe(404);
    expect(t.platform.audit.map((e) => e.action)).toEqual(['greeting.post', 'greeting.delete']);
  });

  it('tells every member about a new greeting (inbox and phones), the author first', async () => {
    const t = harness();
    t.platform.members = [memberFor('max@x.dev', 'MEMBER', 'Max'), memberFor('ann@x.dev', 'MEMBER', 'Ann'), memberFor('bob@x.dev', 'MEMBER', 'Bob')];
    await t.call('POST', '/greetings', { as: { email: 'max@x.dev', name: 'Max' }, body: { text: 'hi everyone' } });
    expect(t.platform.notifications).toEqual([
      { userId: testUserId('max@x.dev'), text: 'Max: hi everyone', link: undefined },
      { userId: testUserId('ann@x.dev'), text: 'Max: hi everyone', link: undefined },
      { userId: testUserId('bob@x.dev'), text: 'Max: hi everyone', link: undefined },
    ]);
  });

  it('still posts when notifying fails', async () => {
    const t = harness();
    t.platform.members = [memberFor('ann@x.dev', 'MEMBER', 'Ann')];
    t.platform.notify = async () => Promise.reject(new Error('platform down'));
    const res = await t.call('POST', '/greetings', { as: { email: 'max@x.dev', name: 'Max' }, body: { text: 'still here' } });
    expect(res.status).toBe(201);
    expect((await t.call('GET', '/public/greetings')).body.greetings[0].text).toBe('still here');
  });

  it('counts the shared counter and publishes each new value on counter/main', async () => {
    const t = harness();
    expect((await t.call('GET', '/counter', { as: 'max@x.dev' })).body).toEqual({ n: 0 });
    expect((await t.call('POST', '/counter', { as: 'max@x.dev' })).body).toEqual({ n: 1 });
    expect((await t.call('POST', '/counter', { as: 'ann@x.dev' })).body).toEqual({ n: 2 });
    expect(t.realtime.on('counter/main')).toEqual([{ n: 1 }, { n: 2 }]);
    expect((await t.call('POST', '/counter')).status).toBe(401);
  });

  it('hands members realtime tokens for the counter and lobby, and refuses the rest', async () => {
    const t = harness();
    const ok = await t.call('POST', '/realtime/token', { as: 'max@x.dev', body: { subscribe: ['counter/main', 'room/lobby'], publish: ['room/lobby'] } });
    expect(ok.status).toBe(200);
    expect((await t.call('POST', '/realtime/token', { as: 'max@x.dev', body: { publish: ['counter/main'] } })).body.code).toBe('REALTIME_SUBSCRIBE_ONLY');
    expect((await t.call('POST', '/realtime/token', { as: 'max@x.dev', body: { subscribe: ['greetings/all'] } })).body.code).toBe('REALTIME_UNDECLARED');
    expect((await t.call('POST', '/realtime/token', { body: { subscribe: ['counter/main'] } })).status).toBe(401);
  });

  it('still counts when publishing fails', async () => {
    const t = harness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    t.realtime.publish = async () => Promise.reject(new Error('AppSync down'));
    expect((await t.call('POST', '/counter', { as: 'max@x.dev' })).body).toEqual({ n: 1 });
    error.mockRestore();
  });
});
