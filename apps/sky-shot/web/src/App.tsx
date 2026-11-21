import { useState, type FormEvent } from 'react';
import { AccountMenu, ApiError, BuildVersion, ErrorNote, Spinner, useApi, useAsync, useHashRoute, useStacks } from '@stacks/web';
import { manifest } from '../../api/manifest';
import type { LeaderEntry } from '../../api/leaderboard';
import type { GameMode } from '../../game/protocol';
import { Gun } from './Gun';
import { LookPicker, LookProvider } from './Look';
import { Screen } from './Screen';
import { Telemetry } from './Telemetry';

interface Board {
  entries: LeaderEntry[];
  best: { score: number; rounds: number; accuracy: number } | null;
  canRemove: boolean;
}

function Leaderboard() {
  const api = useApi();
  const board = useAsync(() => api.get<Board>('/leaderboard'));
  const [error, setError] = useState<Error | null>(null);
  async function remove(e: LeaderEntry) {
    setError(null);
    try {
      await api.del(`/leaderboard/${encodeURIComponent(e.id)}`);
      await board.reload();
    } catch (err) {
      setError(err as Error);
    }
  }
  return (
    <section className="leaderboard panel" aria-labelledby="lb">
      <h2 id="lb">Leaderboard</h2>
      {board.data?.best && (
        <p className="best">
          Your best: <strong>{board.data.best.score.toLocaleString()}</strong> · round {board.data.best.rounds}
        </p>
      )}
      <ErrorNote error={board.error ?? error} className="error" />
      {board.loading && !board.data ? (
        <Spinner />
      ) : board.data?.entries.length ? (
        <ol>
          {board.data.entries.map((e, i) => (
            <li key={e.id}>
              <span className="rank">{i + 1}</span>
              <span className="name">{e.name}</span>
              <span className="pts">{e.score.toLocaleString()}</span>
              <span className="muted small">
                R{e.rounds} · {Math.round(e.accuracy * 100)} %
              </span>
              {board.data!.canRemove && (
                <button type="button" className="link" onClick={() => void remove(e)} aria-label={`Remove ${e.name} from the leaderboard`}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No scores yet. Be the first!</p>
      )}
    </section>
  );
}

/** Join an existing room as the gun, by its 4-character code (when the QR code won't scan). */
function JoinAsGun() {
  const api = useApi();
  const [code, setCode] = useState('');
  const [error, setError] = useState<Error | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { room } = await api.get<{ room: { id: string } }>(`/rooms/by-code/${encodeURIComponent(code.trim())}`);
      window.location.hash = `#/gun/${encodeURIComponent(room.id)}`;
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? new Error('No game with that code.') : (err as Error));
    }
  }
  return (
    <form className="join" onSubmit={go}>
      <label htmlFor="gun-code">On your phone? Enter the code from the screen</label>
      <div className="row">
        <input id="gun-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={4} placeholder="K7QX" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
        <button type="submit" disabled={code.trim().length !== 4}>
          Be the gun
        </button>
      </div>
      <ErrorNote error={error} className="error" />
    </form>
  );
}

function Title() {
  const api = useApi();
  const { status, signIn, accessNotice } = useStacks();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const signedIn = status === 'signedIn';

  async function play(mode: GameMode) {
    setBusy(true);
    setError(null);
    try {
      const { room } = await api.post<{ room: { id: string } }>('/rooms', { name: mode === 'range' ? 'Whee range' : mode === 'training' ? 'Whee training' : 'Whee' });
      window.location.hash = `#/play/${encodeURIComponent(room.id)}/${mode}`;
    } catch (err) {
      setError(err as Error);
      setBusy(false);
    }
  }

  return (
    <div className="title">
      <section className="hero">
        <h1 className="logo">
          Wh<span>ee</span>
        </h1>
        <p className="lead">{manifest.tagline}</p>
        {signedIn ? (
          <>
            <div className="row center">
              <button type="button" className="primary big" disabled={busy} onClick={() => void play('rounds')}>
                Play
              </button>
              <button type="button" className="big" disabled={busy} onClick={() => void play('range')}>
                Range
              </button>
            </div>
            <button type="button" className="link" disabled={busy} onClick={() => void play('training')}>
              Train the aim (2 minutes, fits the controls to you)
            </button>
            <p className="muted small">On a desktop: Play shows a QR code for your iPhone. No phone? Pick "Use mouse instead".</p>
            <ErrorNote error={error} className="error" />
            <JoinAsGun />
            <a className="link" href="#/telemetry">
              Shot telemetry
            </a>
          </>
        ) : accessNotice === 'access_pending' ? (
          <p role="status">Your request is with the app's admins.</p>
        ) : accessNotice === 'access_denied' ? (
          <p role="status">This account doesn't have access to {manifest.name}.</p>
        ) : (
          <button type="button" className="primary big" onClick={() => signIn()}>
            Sign in to play
          </button>
        )}
      </section>
      <Leaderboard />
      <LookPicker />
    </div>
  );
}

function Routed() {
  const { segments } = useHashRoute();
  const { status, session } = useStacks();
  if (status === 'loading') return <Spinner />;
  const signedIn = status === 'signedIn' && !!session;
  const [page, id, mode, auto, open] = segments;
  if (signedIn && page === 'play' && id) return <Screen key={id} roomId={id} mode={mode === 'range' || mode === 'training' ? mode : 'rounds'} autostart={auto === 'auto'} openPanel={open === 'tuning'} />;
  if (signedIn && page === 'gun' && id) return <Gun key={id} roomId={id} />;
  if (page === 'autoplay') return <Spinner />;
  if (signedIn && page === 'telemetry') return <Telemetry key={`${session.user.id}:${session.role}`} />;
  return <Title key={session ? `${session.user.id}:${session.role}` : 'out'} />;
}

export function App() {
  const { segments } = useHashRoute();
  const playing = segments[0] === 'play' || segments[0] === 'gun';
  return (
    <div className={`app${playing ? ' playing' : ''}`}>
      <header className="top">
        <a href="#/" className="brand">
          Whee
        </a>
        <AccountMenu className="account" />
      </header>
      <main>
        <LookProvider>
          <Routed />
        </LookProvider>
      </main>
      <footer className="foot">
        {manifest.name} · built on Stacks · <BuildVersion className="build" />
      </footer>
    </div>
  );
}
