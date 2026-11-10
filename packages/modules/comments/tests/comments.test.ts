import { describe, expect, it } from 'vitest';
import type { AppManifest } from '@stacks/manifest';
import type { AppDeps, AppRoutes } from '@stacks/api';
import { createTestHarness, memberFor, testUserId } from '@stacks/testing';
import { commentCounts, commentRoutes, migrateComments } from '../src/index';

const manifest: AppManifest = {
  slug: 'notes', name: 'Notes', tagline: 't', description: 'd', visibility: 'private',
  roles: [{ id: 'OWNER', label: 'Owner', canManageAccess: true }, { id: 'MEMBER', label: 'Member' }],
  topRole: 'OWNER', defaultRole: 'MEMBER', owners: ['o@x.dev'],
};
const routes = (api: AppRoutes<AppDeps>) =>
  commentRoutes(api, { targets: { note: async (id) => (id === 'n1' ? { id, label: 'Note one' } : null) } });

function setup() {
  const t = createTestHarness({ manifest, routes });
  t.platform.members = [
    memberFor('ann@x.dev', 'MEMBER', 'Ann'),
    memberFor('bo@x.dev', 'MEMBER', 'Bo'),
    memberFor('o@x.dev', 'OWNER', 'Olive'),
  ];
  return t;
}

describe('comments module', () => {
  it('posts, replies, lists with display names and counts', async () => {
    const t = setup();
    const a = await t.call('POST', '/threads/note/n1', { as: 'ann@x.dev', body: { body: 'First' } });
    expect(a.status).toBe(201);
    await t.call('POST', '/threads/note/n1', { as: 'bo@x.dev', body: { body: 'Reply', parentId: a.body.comment.id } });
    const thread = await t.call('GET', '/threads/note/n1', { as: 'ann@x.dev' });
    expect(thread.body.comments.map((c: { body: string; author: { name: string }; canEdit: boolean }) => [c.body, c.author.name, c.canEdit])).toEqual([
      ['First', 'Ann', true],
      ['Reply', 'Bo', false],
    ]);
    expect(await commentCounts(t.store, [{ kind: 'note', id: 'n1' }])).toEqual([2]);
    expect(t.platform.audit.map((e) => [e.action, e.label])).toEqual([['comment.post', 'Note one'], ['comment.post', 'Note one']]);
  });

  it('rejects unknown targets, empty and long bodies', async () => {
    const t = setup();
    expect((await t.call('POST', '/threads/note/zz', { as: 'ann@x.dev', body: { body: 'x' } })).status).toBe(404);
    expect((await t.call('POST', '/threads/song/n1', { as: 'ann@x.dev', body: { body: 'x' } })).status).toBe(404);
    expect((await t.call('POST', '/threads/note/n1', { as: 'ann@x.dev', body: { body: '  ' } })).status).toBe(400);
    expect((await t.call('POST', '/threads/note/n1', { as: 'ann@x.dev', body: { body: 'x'.repeat(2001) } })).status).toBe(400);
  });

  it('lets authors edit, and authors or moderators delete; blanks comments that have replies', async () => {
    const t = setup();
    const a = await t.call('POST', '/threads/note/n1', { as: 'ann@x.dev', body: { body: 'Parent' } });
    const id = a.body.comment.id;
    await t.call('POST', '/threads/note/n1', { as: 'bo@x.dev', body: { body: 'Child', parentId: id } });
    expect((await t.call('PATCH', `/threads/note/n1/comments/${id}`, { as: 'bo@x.dev', body: { body: 'hijack' } })).status).toBe(403);
    expect((await t.call('PATCH', `/threads/note/n1/comments/${id}`, { as: 'ann@x.dev', body: { body: 'Edited' } })).body.comment.editedAt).toBeTruthy();
    expect((await t.call('DELETE', `/threads/note/n1/comments/${id}`, { as: 'bo@x.dev' })).status).toBe(403);
    expect((await t.call('DELETE', `/threads/note/n1/comments/${id}`, { as: 'o@x.dev', role: 'OWNER' })).status).toBe(200);
    const thread = await t.call('GET', '/threads/note/n1', { as: 'ann@x.dev' });
    expect(thread.body.comments[0]).toMatchObject({ deleted: true, body: '', author: null });
    expect(await commentCounts(t.store, [{ kind: 'note', id: 'n1' }])).toEqual([1]);
  });

  it("treats a merged account's old comments as the person's: their name, and they can edit them", async () => {
    const t = setup();
    const old = await t.call('POST', '/threads/note/n1', { as: 'ann.old@x.dev', body: { body: 'From my old account' } });
    // Ann merged her old account into ann@x.dev: the platform lists her once, with the old id as a former id.
    t.platform.members = t.platform.members.map((m) => (m.id === testUserId('ann@x.dev') ? { ...m, formerIds: [testUserId('ann.old@x.dev')] } : m));
    const { forgetMembers } = await import('@stacks/api');
    forgetMembers(t.deps);
    const thread = await t.call('GET', '/threads/note/n1', { as: 'ann@x.dev' });
    expect(thread.body.comments[0]).toMatchObject({ author: { id: testUserId('ann@x.dev'), name: 'Ann' }, canEdit: true });
    expect((await t.call('PATCH', `/threads/note/n1/comments/${old.body.comment.id}`, { as: 'ann@x.dev', body: { body: 'Still mine' } })).status).toBe(200);
  });

  it('credits people who lost access as "Former member"', async () => {
    const t = setup();
    await t.call('POST', '/threads/note/n1', { as: 'ann@x.dev', body: { body: 'Hi' } });
    t.platform.members = t.platform.members.filter((m) => m.id !== testUserId('ann@x.dev'));
    const { forgetMembers } = await import('@stacks/api');
    forgetMembers(t.deps);
    const thread = await t.call('GET', '/threads/note/n1', { as: 'bo@x.dev' });
    expect(thread.body.comments[0].author).toEqual({ id: testUserId('ann@x.dev'), name: 'Former member' });
  });
});

describe('user-id migration', () => {
  it('turns authorEmail into authorId and leaves everything else alone', () => {
    const idFor = (e: string) => `u_${e.split('@')[0]}`;
    expect(migrateComments({ PK: 'THREAD#BOOK#b1', SK: 'COMMENT#c1', authorEmail: 'ann@x.dev', body: 'hi' }, idFor)).toEqual({
      PK: 'THREAD#BOOK#b1',
      SK: 'COMMENT#c1',
      authorId: 'u_ann',
      body: 'hi',
    });
    expect(migrateComments({ PK: 'THREAD#BOOK#b1', SK: 'COUNT', count: 2 }, idFor)).toBeUndefined();
    expect(migrateComments({ PK: 'THREAD#BOOK#b1', SK: 'COMMENT#c2', authorId: 'u_bo' }, idFor)).toBeUndefined(); // already done
  });
});
