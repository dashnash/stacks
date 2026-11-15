import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import { ApiError, createStateBuffer, ErrorNote, matchRoute, useApi, useAsync, useGameRoom, useHashRoute } from '@stacks/web';
import { BUMP, INPUT_HZ, type Dot, type DotsInput, type DotsState, type ShakeEvent } from '../../game/server';

interface Room {
  id: string;
  code: string;
  name: string;
  status: 'starting' | 'open' | 'ended';
  players: number;
  maxPlayers: number;
}

/** One colour per seat (the server hands out the index). */
const COLORS = ['#e4572e', '#2e86ab', '#76b041', '#f2c14e', '#8e5ea2', '#ef798a', '#17a398', '#5d576b'];
const roomHash = (id: string) => `#/play/${encodeURIComponent(id)}`;

/** Start a room, or join one by its code. */
function Lobby() {
  const api = useApi();
  const codeId = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function go(find: () => Promise<{ room: Room }>) {
    setBusy(true);
    setError(null);
    try {
      window.location.hash = roomHash((await find()).room.id);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? new Error('No game with that code. Check it and try again.') : (err as Error));
    } finally {
      setBusy(false);
    }
  }

  function join(e: FormEvent) {
    e.preventDefault();
    void go(() => api.get<{ room: Room }>(`/rooms/by-code/${encodeURIComponent(code.trim())}`));
  }

  return (
    <>
      <p className="muted">Move your dot around a shared board with up to 8 people. A game server runs each room.</p>
      <div className="play-row">
        <button type="button" className="primary" disabled={busy} onClick={() => void go(() => api.post<{ room: Room }>('/rooms', {}))}>
          New room
        </button>
        <form className="join" onSubmit={join}>
          <label htmlFor={codeId}>Join with code</label>
          <input id={codeId} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={4} placeholder="K7QX" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
          <button type="submit" className="wave" disabled={busy || code.trim().length !== 4}>
            Join
          </button>
        </form>
      </div>
      <ErrorNote error={error} className="error" />
    </>
  );
}

/** The dots, drawn from the server's state 100 ms behind and interpolated. */
function Board({ buffer, you, shaking, onPoint }: { buffer: ReturnType<typeof createStateBuffer<DotsState>>; you: string | null; shaking: boolean; onPoint: (input: DotsInput) => void }) {
  const [dots, setDots] = useState<Dot[]>([]);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const state = buffer.sample();
      if (state) setDots(state.dots);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [buffer]);

  const point = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    onPoint({ x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height });
  };

  return (
    <div className={`board${shaking ? ' shake' : ''}`} onPointerMove={point} onPointerDown={point} role="application" aria-label="The board: move your pointer or finger to move your dot">
      {dots.map((d) => (
        <div key={d.id} className={`dot${d.id === you ? ' mine' : ''}`} style={{ left: `${d.x * 100}%`, top: `${d.y * 100}%`, background: COLORS[d.color % COLORS.length] }} data-player={d.name}>
          <span className="dot-name">{d.id === you ? `${d.name} (you)` : d.name}</span>
        </div>
      ))}
    </div>
  );
}

function RoomView({ roomId }: { roomId: string }) {
  const api = useApi();
  const info = useAsync(() => api.get<{ room: Room }>(`/rooms/${encodeURIComponent(roomId)}`), [roomId]);
  const buffer = useMemo(() => createStateBuffer<DotsState>(), [roomId]);
  const [shake, setShake] = useState<{ by: string; n: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const lastSent = useRef(0);

  const room = useGameRoom<DotsState, DotsInput, typeof BUMP>(roomId, {
    onState: (state, meta) => buffer.push(state, meta),
    // From the server, but check it anyway before showing it.
    onEvent: (e) => {
      const by = (e as Partial<ShakeEvent> | null)?.shake?.by;
      if (typeof by === 'string') setShake((s) => ({ by: by.slice(0, 30), n: (s?.n ?? 0) + 1 }));
    },
  });

  // The shake lasts a moment; a new bump starts it again.
  useEffect(() => {
    if (!shake) return;
    const timer = setTimeout(() => setShake(null), 900);
    return () => clearTimeout(timer);
  }, [shake]);

  const { sendInput } = room;
  const onPoint = useCallback(
    (input: DotsInput) => {
      // The server takes 30 positions a second; sending more only wastes them.
      const now = performance.now();
      if (now - lastSent.current < 1000 / INPUT_HZ) return;
      lastSent.current = now;
      sendInput(input);
    },
    [sendInput],
  );

  const code = info.data?.room.code;
  const link = `${window.location.origin}${window.location.pathname}${window.location.search}${roomHash(roomId)}`;
  const back = () => {
    window.location.hash = '#/';
  };

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard here: the link is on the page to copy by hand.
    }
  }

  return (
    <>
      {code && room.status !== 'ended' && room.status !== 'offline' && (
        <p className="share">
          Code <strong className="code">{code}</strong>
          <button type="button" className="link" onClick={() => void copy()}>
            {copied ? 'Link copied' : 'Copy link'}
          </button>
        </p>
      )}

      {room.status === 'starting' && (
        <p className="waiting" role="status">
          Starting the game server… (up to a minute)
        </p>
      )}
      {room.status === 'connecting' && (
        <p className="waiting" role="status">
          Connecting…
        </p>
      )}
      {room.status === 'live' && (
        <>
          <Board buffer={buffer} you={room.you?.id ?? null} shaking={!!shake} onPoint={onPoint} />
          <div className="play-row">
            <span className="muted" aria-label="Players">
              {room.players.map((p) => p.name).join(', ')}
            </span>
            <span className="rtt" aria-label="Round trip to the game server">
              {room.rttMs === null ? '… ms' : `${room.rttMs} ms`}
            </span>
          </div>
          <div className="play-row">
            <button type="button" className="wave" onClick={() => room.sendEvent(BUMP)}>
              Bump
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                void room.leave().then(back);
              }}
            >
              Leave
            </button>
          </div>
          <p className="bumped" role="status" aria-live="polite">
            {shake ? `${shake.by} bumped the board!` : ''}
          </p>
        </>
      )}
      {room.status === 'ended' && (
        <p className="waiting">
          {room.over?.reason === 'idle' ? 'This game ended: nobody moved for a while.' : room.over?.reason === 'time' ? 'This game ended: it reached its time limit.' : 'This game is over.'}{' '}
          <button type="button" className="link" onClick={back}>
            Back
          </button>
        </p>
      )}
      {room.status === 'offline' && (
        <p className="waiting">
          {room.error === 'full' ? 'This game is full.' : room.error === 'not_found' ? "That game doesn't exist (or ended a while ago)." : room.error === 'left' ? 'You left the game.' : "Can't reach this game."}{' '}
          <button type="button" className="link" onClick={back}>
            Back
          </button>
        </p>
      )}
    </>
  );
}

/**
 * Live dots: the gameServer module in action. A room's game server (apps/hello/game/server.ts)
 * owns every dot; this only sends where you point and draws what the server says.
 */
export function Play() {
  const { path } = useHashRoute();
  const roomId = matchRoute('/play/:id', path)?.id;
  return (
    <section className="live play" aria-labelledby="play-title">
      <h2 id="play-title">Play: Live dots</h2>
      {roomId ? <RoomView key={roomId} roomId={roomId} /> : <Lobby />}
    </section>
  );
}
