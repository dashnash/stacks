import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AccountMenu, Avatar, BuildVersion, ErrorNote, Spinner, timeAgo, useApi, useAsync, useChannel, useStacks, type ChannelStatus } from '@stacks/web';
import type { CounterEvent, Greeting, Wave } from '../../api/routes';
import { COUNTER_CHANNEL, LOBBY_CHANNEL, MAX_GREETING } from '../../api/routes';
import { Play } from './Play';

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

const STATUS_LABEL: Record<ChannelStatus, string> = { live: 'Live', connecting: 'Connecting…', offline: 'Offline' };

/** Short-lived notes ("Sam waved") that fade after a few seconds. */
function useToasts(ms = 4000) {
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const next = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const show = useCallback(
    (text: string) => {
      const id = ++next.current;
      setToasts((t) => [...t.slice(-2), { id, text }]);
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        setToasts((t) => t.filter((x) => x.id !== id));
      }, ms);
      timers.current.add(timer);
    },
    [ms],
  );
  return { toasts, show };
}

/**
 * The realtime module in action: a counter the server publishes on `counter/main`, and a Wave
 * button that publishes straight from the browser on `lobby/main`.
 */
function LivePanel() {
  const api = useApi();
  const { session } = useStacks();
  const loaded = useAsync(() => api.get<CounterEvent>('/counter'));
  const [latest, setLatest] = useState(0);
  const [bumping, setBumping] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const { toasts, show } = useToasts();
  // The counter only goes up, so the highest value seen is the current one.
  const n = Math.max(latest, loaded.data?.n ?? 0);
  const { reload } = loaded;

  const counter = useChannel<CounterEvent>(COUNTER_CHANNEL, (e) => typeof e?.n === 'number' && setLatest((x) => Math.max(x, e.n)), {
    onResync: () => void reload(),
  });
  const lobby = useChannel<Wave>(
    LOBBY_CHANNEL,
    (w) => show(`${typeof w?.name === 'string' && w.name.trim() ? w.name.slice(0, 30) : 'Someone'} waved 👋`),
    { publish: true },
  );

  async function bump() {
    setBumping(true);
    setError(null);
    try {
      const res = await api.post<CounterEvent>('/counter');
      setLatest((x) => Math.max(x, res.n));
    } catch (err) {
      setError(err as Error);
    } finally {
      setBumping(false);
    }
  }

  async function wave() {
    setError(null);
    try {
      await lobby.publish({ name: session?.user.name ?? 'Someone' });
      show('You waved 👋');
    } catch (err) {
      setError(err as Error);
    }
  }

  const status: ChannelStatus = counter.status === 'live' && lobby.status === 'live' ? 'live' : counter.status === 'offline' || lobby.status === 'offline' ? 'offline' : 'connecting';
  return (
    <section className="live" aria-labelledby="live-title">
      <div className="row">
        <h2 id="live-title">Live</h2>
        <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
      </div>
      <div className="live-row">
        <p className="counter" aria-label="Shared counter">
          {n}
        </p>
        <button type="button" className="primary" onClick={() => void bump()} disabled={bumping}>
          +1
        </button>
        <button type="button" className="wave" onClick={() => void wave()} disabled={lobby.status !== 'live'}>
          Wave 👋
        </button>
      </div>
      <p className="muted">Everyone signed in sees the counter and waves as they happen.</p>
      <ErrorNote error={error} className="error" />
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <p key={t.id} className="toast">
            {t.text}
          </p>
        ))}
      </div>
    </section>
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
      <LivePanel />
      <Play />
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
  const { status, session } = useStacks();
  return (
    <main className="page">
      <header className="top">
        <h1>Hello Board</h1>
        <AccountMenu className="account" />
      </header>
      {status === 'loading' ? <Spinner /> : status === 'signedIn' && session ? <Board key={`${session.user.id}:${session.role}`} /> : <SignedOut />}
      <footer className="foot">
        Hello Board · <BuildVersion className="build" />
      </footer>
    </main>
  );
}
