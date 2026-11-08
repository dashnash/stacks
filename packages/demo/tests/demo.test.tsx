import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppManifest } from '@stacks/manifest';
import { requireString, type AppDeps, type AppRoutes } from '@stacks/api';
import { useAsync, useStacks } from '@stacks/web';
import { createDemo, DemoApp } from '../src/index';

const manifest: AppManifest = {
  slug: 'notes',
  name: 'Notes',
  tagline: 't',
  description: 'd',
  visibility: 'private',
  roles: [
    { id: 'OWNER', label: 'Owner', canManageAccess: true },
    { id: 'READER', label: 'Reader' },
  ],
  topRole: 'OWNER',
  defaultRole: 'READER',
  owners: ['o@x.dev'],
};

const routes = (api: AppRoutes<AppDeps>) =>
  api
    .member('GET', '/notes', async (_r, v) => ({ body: { notes: (await v.deps.store.query('NOTES')).map((n) => n.text) } }))
    .role(['OWNER'], 'POST', '/notes', async (req, v) => {
      await v.deps.store.put({ PK: 'NOTES', SK: v.deps.newId(), text: requireString(req.body, 'text') });
      return { status: 201, body: {} };
    });

const personas = [
  { email: 'olive@demo', name: 'Olive', role: 'OWNER' },
  { email: 'rex@demo', name: 'Rex', role: 'READER' },
];

const seed = async (deps: AppDeps) => {
  await deps.store.put({ PK: 'NOTES', SK: '0', text: 'Welcome' });
};

beforeEach(() => localStorage.clear());

describe('createDemo', () => {
  it('runs the real API in memory with persona sign-in', async () => {
    const demo = createDemo({ manifest, routes, personas, seed });
    await expect(demo.client.get('/notes')).rejects.toMatchObject({ status: 401 });
    await demo.signInAs('rex@demo');
    expect(await demo.client.get('/notes')).toEqual({ notes: ['Welcome'] });
    await expect(demo.client.post('/notes', { text: 'x' })).rejects.toMatchObject({ status: 403 });
    await demo.signInAs('olive@demo');
    await demo.client.post('/notes', { text: 'Second' });
    expect(await demo.client.get('/notes')).toEqual({ notes: ['Welcome', 'Second'] });
  });

  it('keeps changes between visits and resets to the seed', async () => {
    const first = createDemo({ manifest, routes, personas, seed });
    await first.signInAs('olive@demo');
    await first.client.post('/notes', { text: 'Kept' });

    const again = createDemo({ manifest, routes, personas, seed });
    await again.signInAs('olive@demo');
    expect(await again.client.get('/notes')).toEqual({ notes: ['Welcome', 'Kept'] });
    await again.reset();
    await again.signInAs('olive@demo');
    expect(await again.client.get('/notes')).toEqual({ notes: ['Welcome'] });
  });

  it('refuses personas with undeclared roles', () => {
    expect(() => createDemo({ manifest, routes, personas: [{ email: 'a@b', name: 'A', role: 'GOD' }] })).toThrow(/GOD/);
  });
});

function NotesView() {
  const { status, session, signIn, signOut } = useStacks();
  const { data } = useAsync(() => (status === 'signedIn' ? useStacksApiGet() : Promise.resolve(null)), [status, session?.user.email]);
  return (
    <div>
      <p>status:{status}</p>
      <p>who:{session?.user.name ?? '-'}</p>
      <p>notes:{data ? (data as { notes: string[] }).notes.join(',') : '-'}</p>
      <button onClick={() => signIn()}>Sign in</button>
      <button onClick={() => void signOut()}>Sign out</button>
    </div>
  );
}
let useStacksApiGet: () => Promise<unknown>;

describe('DemoApp', () => {
  it('signs in as the first persona, switches personas, and signs out', async () => {
    const demo = createDemo({ manifest, routes, personas, seed });
    useStacksApiGet = () => demo.client.get('/notes');
    render(
      <DemoApp demo={demo}>
        <NotesView />
      </DemoApp>,
    );
    expect(await screen.findByText('status:signedOut')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Sign in'));
    expect(await screen.findByText('who:Olive')).toBeInTheDocument();
    expect(await screen.findByText('notes:Welcome')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Try the app as'), 'rex@demo');
    expect(await screen.findByText('who:Rex')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Sign out'));
    await waitFor(() => expect(screen.getByText('status:signedOut')).toBeInTheDocument());
  });
});
