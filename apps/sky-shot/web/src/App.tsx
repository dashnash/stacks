import { useEffect, useState, type FormEvent } from 'react';
import { AccountMenu, ApiError, BuildVersion, ErrorNote, Spinner, useApi, useAsync, useHashRoute, usePrewarmRoom, useStacks, type PrewarmRoom } from '@stacks/web';
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

/** A desktop (a fine pointer): the screen that starts games. Phones only join by code. */
const isDesktop = () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;

/** After this long busy (or stuck warming), the title offers "Play anyway": a server the slow way. */
export const PLAY_ANYWAY_MS = 60_000;
/** Roughly how long a server takes to start, for the progress bar. */
const TYPICAL_START_MS = 45_000;

/** "Getting your game ready…": where the warm server is, until Play can take it. */
function GameReadiness({ warm, since, now }: { warm: PrewarmRoom; since: number; now: number }) {
  const secs = Math.max(0, Math.round((now - since) / 1000));
  if (warm.status === 'busy')
    return (
      <div className="ready-bar" role="status">
        <div className="ready-line">
          <span>All game servers are busy, retrying…</span>
        </div>
      </div>
    );
  const reserved = !!warm.roomId;
  // An estimate: the server says nothing until it's open.
  const pct = Math.min(95, 8 + ((now - since) / TYPICAL_START_MS) * 87);
  return (
    <div className="ready-bar" role="status" aria-label="Getting your game ready">
      <div className="ready-line">
        <span>Getting your game ready…</span>
        <span className="muted">
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
        </span>
      </div>
      <div className="ready-track">
        <div className="ready-fill" style={{ width: `${pct}%` }} />
      </div>
      <ol className="ready-steps">
        <li className={reserved ? 'done' : 'now'}>{reserved ? '✓ ' : ''}Reserved</li>
        <li className={reserved ? 'now' : ''}>Starting server</li>
        <li>Open</li>
      </ol>
    </div>
  );
}

function Title() {
  const api = useApi();
  const { status, signIn, accessNotice } = useStacks();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const signedIn = status === 'signedIn';
  const [desktop] = useState(isDesktop);
  // Start a game server now; Play waits for it (on a desktop), so the game starts at once.
  const warm = usePrewarmRoom(signedIn && desktop && !busy);
  const ready = !desktop || warm.status === 'ready';
  // How long it has been getting ready (or busy), for the timer and "Play anyway".
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const waitingKind = warm.status === 'busy' ? 'busy' : 'warm';
  useEffect(() => setSince(Date.now()), [waitingKind, ready]);
  useEffect(() => {
    if (ready || !signedIn || !desktop) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ready, signedIn, desktop]);
  const anyway = !ready && warm.status !== 'off' && now - since >= PLAY_ANYWAY_MS;

  async function play(mode: GameMode = 'rounds') {
    setBusy(true);
    setError(null);
    try {
      const { room } = await api.post<{ room: { id: string } }>('/rooms', { name: 'Whee' });
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
            {desktop && !ready && warm.status !== 'off' && <GameReadiness warm={warm} since={since} now={now} />}
            {desktop && ready && (
              <p className="ready-chip" role="status">
                Your game is ready
              </p>
            )}
            <div className="row center">
              <button type="button" className="primary big" disabled={busy || !ready} onClick={() => void play()}>
                Play
              </button>
              {anyway && (
                <button type="button" className="big" disabled={busy} onClick={() => void play()}>
                  Play anyway
                </button>
              )}
            </div>
            <p className="muted small">
              {anyway ? 'Play anyway starts a server the slow way (30-60 s). ' : ''}Play shows a QR code for your phone. Game, look and settings are on the controller. No phone? Pick
              "Use the mouse instead".
            </p>
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
