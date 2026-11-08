import { useState, type FormEvent } from 'react';
import { Avatar, ErrorNote, Spinner, timeAgo, useApi, useAsync, useStacks } from '@stacks/web';
import type { Greeting } from '../../api/routes';
import { MAX_GREETING } from '../../api/routes';

type PublicGreeting = Pick<Greeting, 'id' | 'text' | 'authorName' | 'createdAt'>;

function GreetingList({ greetings, onDelete }: { greetings: PublicGreeting[]; onDelete?: (id: string) => void }) {
  if (!greetings.length) return <p className="muted">No greetings yet. Be the first!</p>;
  return (
    <ul className="greetings">
      {greetings.map((g) => (
        <li key={g.id}>
          <Avatar person={{ name: g.authorName }} size={36} className="avatar" />
          <div>
            <p className="text">{g.text}</p>
            <p className="meta">
              {g.authorName} · {timeAgo(g.createdAt)}
            </p>
          </div>
          {onDelete && (
            <button type="button" className="link" onClick={() => onDelete(g.id)} aria-label={`Delete greeting from ${g.authorName}`}>
              Delete
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function SignedOut() {
  const api = useApi();
  const { signIn } = useStacks();
  const { data, error, loading } = useAsync(() => api.get<{ greetings: PublicGreeting[] }>('/public/greetings'));
  return (
    <>
      <section className="hero">
        <p>Say hello to everyone on the platform.</p>
        <button type="button" className="primary" onClick={() => signIn()}>
          Sign in to say hello
        </button>
      </section>
      <h2>Latest</h2>
      {loading ? <Spinner /> : <ErrorNote error={error} className="error" />}
      {data && <GreetingList greetings={data.greetings} />}
    </>
  );
}

function Board() {
  const api = useApi();
  const { session } = useStacks();
  const { data, error, loading, reload } = useAsync(() => api.get<{ greetings: Greeting[]; canDelete: boolean }>('/greetings'));
  const [text, setText] = useState('');
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);

  async function post(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      await api.post('/greetings', { text });
      setText('');
      await reload();
    } catch (err) {
      setSaveError(err as Error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    await api.del(`/greetings/${encodeURIComponent(id)}`);
    await reload();
  }

  return (
    <>
      <form className="compose" onSubmit={post}>
        <label htmlFor="greeting">Hi {session?.user.name}, say hello</label>
        <textarea id="greeting" value={text} maxLength={MAX_GREETING} onChange={(e) => setText(e.target.value)} rows={3} />
        <div className="row">
          <span className="muted">
            {text.length}/{MAX_GREETING}
          </span>
          <button type="submit" className="primary" disabled={saving || !text.trim()}>
            {saving ? 'Posting…' : 'Post'}
          </button>
        </div>
        <ErrorNote error={saveError} className="error" />
      </form>
      {loading && !data ? <Spinner /> : <ErrorNote error={error} className="error" />}
      {data && <GreetingList greetings={data.greetings} onDelete={data.canDelete ? (id) => void remove(id) : undefined} />}
    </>
  );
}

export function App() {
  const { status, session, signOut } = useStacks();
  return (
    <main className="page">
      <header className="top">
        <h1>Hello Board</h1>
        {session && (
          <div className="me">
            <Avatar person={session.user} size={28} className="avatar" />
            <span>
              {session.user.name} <span className="role">{session.role.toLowerCase()}</span>
            </span>
            <button type="button" className="link" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        )}
      </header>
      {status === 'loading' ? <Spinner /> : status === 'signedIn' && session ? <Board key={`${session.user.email}:${session.role}`} /> : <SignedOut />}
    </main>
  );
}
