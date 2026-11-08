import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@stacks/testing';
import { manifest } from '../api/manifest';
import { routes } from '../api/routes';

const harness = () => createTestHarness({ manifest, routes });
const approver = manifest.topRole;
const member = manifest.roles.find((r) => !r.canManageAccess)?.id ?? manifest.topRole;

// STARTER TESTS for the starter notes feature: replace them along with it.
describe(`${manifest.name} API`, () => {
  it('lets members add notes and read them newest first; signed-out visitors see only a count', async () => {
    const t = harness();
    await t.call('POST', '/notes', { as: { email: 'max@x.dev', name: 'Max' }, role: member, body: { text: 'one' } });
    await t.call('POST', '/notes', { as: { email: 'ann@x.dev', name: 'Ann' }, role: member, body: { text: 'two' } });
    expect((await t.call('GET', '/public/stats')).body).toEqual({ notes: 2 });
    const list = await t.call('GET', '/notes', { as: 'max@x.dev', role: member });
    expect(list.body.notes.map((n: { text: string }) => n.text)).toEqual(['two', 'one']);
  });

  it('rejects empty notes and needs sign-in', async () => {
    const t = harness();
    expect((await t.call('POST', '/notes', { body: { text: 'hi' } })).status).toBe(401);
    expect((await t.call('POST', '/notes', { as: 'max@x.dev', role: member, body: { text: ' ' } })).status).toBe(400);
  });

  it('lets only approvers delete, and records it in the activity log', async () => {
    const t = harness();
    const { body } = await t.call('POST', '/notes', { as: 'max@x.dev', role: member, body: { text: 'oops' } });
    if (member !== approver) expect((await t.call('DELETE', `/notes/${body.note.id}`, { as: 'max@x.dev', role: member })).status).toBe(403);
    expect((await t.call('DELETE', `/notes/${body.note.id}`, { as: 'boss@x.dev', role: approver })).status).toBe(200);
    expect(t.platform.audit.map((e) => e.action)).toEqual(['note.post', 'note.delete']);
  });
});
