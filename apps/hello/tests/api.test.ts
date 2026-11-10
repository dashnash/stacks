import { describe, expect, it } from 'vitest';
import { createTestHarness, testUserId } from '@stacks/testing';
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
});
