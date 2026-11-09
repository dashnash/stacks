import { useState, type FormEvent } from 'react';
import { AccountMenu, Avatar, BuildVersion, ErrorNote, Spinner, timeAgo, useApi, useAsync, useStacks } from '@stacks/web';
import { manifest } from '../../api/manifest';
import { MAX_NOTE, type Note } from '../../api/routes';

/** Signed out (or signed in without access yet): the app's public face. */
function Landing() {
  const api = useApi();
  const { signIn, accessNotice } = useStacks();
  const stats = useAsync(() => api.get<{ notes: number }>('/public/stats'));
  return (
    <section className="hero">
      <p className="lead">{manifest.tagline}</p>
      <p>{manifest.description}</p>
      {accessNotice === 'access_pending' ? (
        <p role="status">Your request is with the app's admins. You'll get a notification when you're in.</p>
      ) : accessNotice === 'access_denied' ? (
        <p role="status">This account doesn't have access to {manifest.name}.</p>
      ) : (
        <button type="button" className="primary" onClick={() => signIn()}>
          {accessNotice === 'access_required' ? 'Request access' : manifest.visibility === 'private' ? 'Sign in or request access' : 'Sign in to start'}
        </button>
      )}
      {stats.data && <p className="muted small">{stats.data.notes} notes so far</p>}
    </section>
  );
}

/** STARTER FEATURE (see api/routes.ts): replace with the app's real home screen. */
function Home() {
  const api = useApi();
  const { session } = useStacks();
  const { data, error, loading, reload } = useAsync(() => api.get<{ notes: Note[]; canDelete: boolean }>('/notes'));
  const [text, setText] = useState('');
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);

  async function post(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      await api.post('/notes', { text });
      setText('');
      await reload();
    } catch (err) {
      setSaveError(err as Error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    await api.del(`/notes/${encodeURIComponent(id)}`);
    await reload();
  }

  return (
    <>
      <form className="compose" onSubmit={post}>
        <label htmlFor="note">Hi {session?.user.name}, add a note</label>
        <textarea id="note" value={text} maxLength={MAX_NOTE} onChange={(e) => setText(e.target.value)} rows={3} />
        <div className="row">
          <span className="muted small">
            {text.length}/{MAX_NOTE}
          </span>
          <button type="submit" className="primary" disabled={saving || !text.trim()}>
            {saving ? 'Saving…' : 'Add'}
          </button>
        </div>
        <ErrorNote error={saveError} className="error" />
      </form>
      {loading && !data ? <Spinner /> : <ErrorNote error={error} className="error" />}
      {data && !data.notes.length && <p className="muted">No notes yet.</p>}
      <ul className="items">
        {data?.notes.map((n) => (
          <li key={n.id}>
            <Avatar person={{ name: n.authorName }} size={36} className="avatar" />
            <div>
              <p className="text">{n.text}</p>
              <p className="meta">
                {n.authorName} · {timeAgo(n.createdAt)}
              </p>
            </div>
            {data.canDelete && (
              <button type="button" className="link" onClick={() => void remove(n.id)} aria-label={`Delete note from ${n.authorName}`}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export function App() {
  const { status, session } = useStacks();
  return (
    <div className="page">
      {/* Platform rule: the account menu sits at the top right of the header (tools/app-conformance). */}
      <header className="top">
        <h1>{manifest.name}</h1>
        <AccountMenu className="account" />
      </header>
      <main>{status === 'loading' ? <Spinner /> : status === 'signedIn' && session ? <Home key={`${session.user.email}:${session.role}`} /> : <Landing />}</main>
      {/* Platform rule: the build is shown on every screen (tools/app-conformance). */}
      <footer className="foot muted small">
        {manifest.name} · built on Stacks · <BuildVersion className="build" />
      </footer>
    </div>
  );
}
