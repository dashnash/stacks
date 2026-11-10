import type { AppManifest } from '@stacks/manifest';
import { badRequest, notFound, requireString, type AppDeps, type AppRoutes } from '../src/index';

export const manifest: AppManifest = {
  slug: 'notes',
  name: 'Notes',
  tagline: 'Shared notes',
  description: 'A test app.',
  visibility: 'private',
  roles: [
    { id: 'OWNER', label: 'Owner', canManageAccess: true, canManageApprovers: true },
    { id: 'EDITOR', label: 'Editor' },
    { id: 'READER', label: 'Reader' },
  ],
  topRole: 'OWNER',
  defaultRole: 'READER',
  owners: ['owner@test.dev'],
};

/** A tiny app exercising every kind of route. */
export function routes(api: AppRoutes<AppDeps>) {
  api
    .public('GET', '/public/info', async (_req, ctx) => {
      const viewer = await ctx.viewer();
      return { body: { app: ctx.manifest.name, signedInAs: viewer?.user.id ?? null } };
    })
    .member('GET', '/notes', async (_req, v) => ({ body: { notes: await v.deps.store.query('NOTES') } }))
    .role(['OWNER', 'EDITOR'], 'POST', '/notes', async (req, v) => {
      const text = requireString(req.body, 'text', 200);
      const id = v.deps.newId();
      await v.deps.store.put({ PK: 'NOTES', SK: id, text, by: v.user.id });
      return { status: 201, body: { id }, audit: { label: text.slice(0, 20) } };
    }, { audit: 'note.post' })
    .approver('DELETE', '/notes/:id', async (req, v) => {
      if (!(await v.deps.store.get('NOTES', req.params.id!))) throw notFound('No such note');
      await v.deps.store.delete('NOTES', req.params.id!);
      return { body: { ok: true } };
    }, { audit: 'note.delete' })
    .member('POST', '/boom', async () => {
      throw badRequest('nope');
    });
}
