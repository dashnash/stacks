import { useCallback, useEffect, useRef, useState } from 'react';
import { AccountMenu, ErrorNote, Spinner, useApi, useAsync, useHashRoute, useStacks } from '@stacks/web';
import type { BoardEntry, Flip } from '../../api/flips';
import { TOOLS, toolById, unlockedTools, type Tool } from '../../api/tools';
import { CookieBanner, FakeDownload, Footer, Marquee, readLocal, SaleTimer, VisitorCounter, writeLocal } from './Jank';
import { restingFrame, simulateFlip, swipeStrength, type FlipResult } from './game/sim';
import { Stage } from './game/Stage';

interface Me {
  best: number;
  total: number;
  flips: number;
  rank: number | null;
  recent: Flip[];
  canModerate: boolean;
}
interface SaveResult {
  flip: Flip;
  best: number;
  total: number;
  newBest: boolean;
  newTools: string[];
}

const coinz = (n: number) => `₽$${n.toLocaleString('en-US')}`;
const FRAME_MS = 1000 / 60;
const nextFrame = (fn: () => void) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : (setTimeout(fn, FRAME_MS) as unknown as number);
const cancelFrame = (id: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const show = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 4000);
  }, []);
  return { msg, show };
}

// ---------------------------------------------------------------- game

function Game({ me, tool, onSaved, toast }: { me: Me | null; tool: Tool; onSaved: () => void; toast: (m: string) => void }) {
  const api = useApi();
  const { status, signIn } = useStacks();
  const [result, setResult] = useState<FlipResult | null>(null);
  const [index, setIndex] = useState(0);
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const raf = useRef(0);

  useEffect(() => () => cancelFrame(raf.current), []);

  const playing = result !== null && index < result.frames.length - 1;
  const done = result !== null && !playing;
  const frame = result ? result.frames[Math.min(index, result.frames.length - 1)]! : restingFrame();

  async function flip(strength: number) {
    if (result) return;
    const r = simulateFlip(strength * tool.power, Math.floor(Math.random() * 1e9));
    setResult(r);
    setIndex(0);
    setSaved(null);
    setSaveError(null);
    const started = performance.now();
    const tick = () => {
      const i = Math.floor((performance.now() - started) / FRAME_MS);
      setIndex(Math.min(i, r.frames.length - 1));
      if (i < r.frames.length - 1) raf.current = nextFrame(tick);
    };
    raf.current = nextFrame(tick);
    if (!r.flipped) toast('Table not go over. ПОДТЯНИ СИЛЬНЕЕ (pull more strong)!');
    if (status !== 'signedIn') return;
    try {
      const body = await api.post<SaveResult>('/flips', { damage: r.damage, hangMs: r.hangMs, tool: tool.id });
      setSaved(body);
      if (body.newTools.length) toast(`New tool unlock: ${body.newTools.map((id) => toolById(id)?.name).join(', ')}! See Магазин.`);
      onSaved();
    } catch (err) {
      setSaveError(err as Error);
    }
  }

  function reset() {
    cancelFrame(raf.current);
    setResult(null);
    setIndex(0);
  }

  function swiped(dyUp: number, ms: number) {
    const s = swipeStrength(dyUp, ms);
    if (s === 0) toast('Swipe more UP, not like this. Вверх!');
    else void flip(s);
  }

  // Cosmetic glitch: the score reads NaN for the first few frames of every flip.
  const shownScore = result ? (index < 8 ? 'NaN' : Math.round(frame.damage + Math.min(frame.t * 1000, result.hangMs) / 10).toLocaleString('en-US')) : '0';
  const shownHang = result ? Math.min(frame.t * 1000, result.hangMs) / 1000 : 0;

  return (
    <>
      <h2 className="headline">FLIP THE WORK TABLE!!! (бесплатно)</h2>
      <SaleTimer />
      <div className="stage-wrap">
        <Stage frame={frame} idle={!result} toolEmoji={tool.emoji} onSwipe={swiped} />
      </div>
      <div className="scorebar" aria-live="polite">
        <div>
          <span className="lbl">SCOORE</span>
          <span className="big" data-testid="score">
            {shownScore}
          </span>
        </div>
        <div>
          <span className="lbl">hang tіme</span>
          <span className="mid">{shownHang.toFixed(2)}s</span>
        </div>
        <div>
          <span className="lbl">Tool</span>
          <span className="mid">
            {tool.emoji} {tool.name}
          </span>
        </div>
      </div>
      <div className="actions">
        {!result && (
          <button type="button" className="flip" aria-label="Flip the table" onClick={() => void flip(0.9 + Math.random() * 0.5)}>
            FLIP IT!! (НАЖМИ)
          </button>
        )}
        {done && (
          <button type="button" className="flip again" aria-label="Set the table again" onClick={reset}>
            {'{{btn.again.label}}'} ↺
          </button>
        )}
        {playing && <p className="muted">ЛЕТИТ… (flying)</p>}
      </div>

      {done && (
        <section className="report" aria-label="Damage report">
          <h3>Отчёт of damage</h3>
          {status === 'signedIn' ? (
            saved ? (
              <p className="saved">
                Saved! +{coinz(saved.flip.score)} Flippy Coinz. {saved.newBest && <strong className="blink">НОВЫЙ РЕКОРД!! (new best)</strong>}
              </p>
            ) : (
              <ErrorNote error={saveError} className="error" />
            )
          ) : (
            <p className="saved">
              Final scoore {result.score.toLocaleString('en-US')}.{' '}
              <button type="button" className="link" onClick={() => signIn()}>
                Sign in for save you score!!
              </button>
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Damage</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {result.items
                .slice()
                .sort((a, b) => b.damage - a.damage)
                .map((it) => (
                  <tr key={it.id}>
                    <td>{it.label}</td>
                    <td>{it.damage.toLocaleString('en-US')}</td>
                    <td>{it.broken ? <span className="broke">СЛОМАНО</span> : 'ok (for now)'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}

      {me && (
        <section className="mystats" aria-label="Your stats">
          <p>
            Best: <strong>{me.best.toLocaleString('en-US')}</strong> · Coinz: <strong>{coinz(me.total)}</strong> · Flips: <strong>{me.flips}</strong>
            {me.rank ? ` · Place on Top: #${me.rank}` : ''}
          </p>
        </section>
      )}
      <VisitorCounter />
      <FakeDownload onToast={toast} />
    </>
  );
}

// ---------------------------------------------------------------- leaderboard

/** Display numbering skips 5 ("№5 is reserve"). The real rank (on the game page) is right. */
const shownRank = (i: number) => (i >= 4 ? i + 2 : i + 1);

function Top({ canModerate, toast }: { canModerate: boolean; toast: (m: string) => void }) {
  const api = useApi();
  const { data, error, loading, reload } = useAsync(() => api.get<{ entries: BoardEntry[] }>('/public/leaderboard'));
  async function remove(e: BoardEntry) {
    await api.del(`/leaderboard/${encodeURIComponent(e.playerId)}`);
    toast(`${e.name} removed from Top. Cheater go away.`);
    await reload();
  }
  return (
    <>
      <h2 className="headline">Top Flipperов 🏆 (all time of the world)</h2>
      {loading && !data ? <Spinner /> : <ErrorNote error={error} className="error" />}
      {data && !data.entries.length && <p>Nobody flip yet. Be first!!</p>}
      {data && data.entries.length > 0 && (
        <ol className="board">
          {data.entries.map((e, i) => (
            <li key={e.playerId}>
              <span className="rank">#{shownRank(i)}</span>
              <span className="name">{e.name}</span>
              <span className="pts">{e.best.toLocaleString('en-US')} pts</span>
              <span className="muted small">{e.flips} flip{e.flips === 1 ? '' : 'з'}</span>
              {canModerate && (
                <button type="button" className="link" aria-label={`Remove ${e.name} from the board`} onClick={() => void remove(e)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="muted small">* Place №5 is reserve for VIP. Leaderboard update every 0 minute.</p>
    </>
  );
}

// ---------------------------------------------------------------- shop

function Shop({ me, tool, onPick }: { me: Me | null; tool: Tool; onPick: (t: Tool) => void }) {
  const { status, signIn } = useStacks();
  const total = me?.total ?? 0;
  return (
    <>
      <h2 className="headline">Магазин of tools 🛒</h2>
      <p>
        Tools make flip more strong. Pay with Flippy Coinz (you get them from flip, real money not accept, сорри).{' '}
        {status === 'signedIn' ? (
          <>
            You have <strong>{coinz(total)}</strong>.
          </>
        ) : (
          <button type="button" className="link" onClick={() => signIn()}>
            Sign in for unlock tools
          </button>
        )}
      </p>
      <ul className="tools">
        {TOOLS.map((t) => {
          const open = unlockedTools(total).includes(t);
          return (
            <li key={t.id} className={open ? '' : 'locked'}>
              <span className="emoji" aria-hidden="true">
                {t.emoji}
              </span>
              <div>
                <p className="tname">
                  {t.name} <span className="power">x{t.power} power</span>
                </p>
                <p className="small">{t.blurb}</p>
                <p className="price">{t.unlockAt ? coinz(t.unlockAt) : 'FREE (бесплатно)'}</p>
              </div>
              {tool.id === t.id ? (
                <span className="using">✔ Using</span>
              ) : open ? (
                <button type="button" className="buy" aria-label={`Use ${t.name}`} onClick={() => onPick(t)}>
                  Use this
                </button>
              ) : (
                <span className="lockmsg">🔒 need {coinz(t.unlockAt - total)} more</span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------- shell

function Site() {
  const api = useApi();
  const { status } = useStacks();
  const { path } = useHashRoute();
  const { msg, show } = useToast();
  const signedIn = status === 'signedIn';
  const { data: me, reload } = useAsync(() => (signedIn ? api.get<Me>('/me') : Promise.resolve(null)), [signedIn]);
  const [toolId, setToolId] = useState(() => readLocal('fwt.tool') ?? 'hand');
  // Only a tool you've unlocked counts; otherwise back to bare hand.
  const tool = (signedIn && unlockedTools(me?.total ?? 0).find((t) => t.id === toolId)) || TOOLS[0]!;
  const pick = (t: Tool) => {
    setToolId(t.id);
    writeLocal('fwt.tool', t.id);
  };

  const page = path === '/top' ? 'top' : path === '/shop' ? 'shop' : 'game';
  return (
    <>
      <nav className="nav" aria-label="Pages">
        <a href="#/" aria-current={page === 'game' ? 'page' : undefined}>
          Igra (Game)
        </a>
        <a href="#/top" aria-current={page === 'top' ? 'page' : undefined}>
          Top Flipperов
        </a>
        <a href="#/shop" aria-current={page === 'shop' ? 'page' : undefined}>
          Магазин (Shop)
        </a>
      </nav>
      <Marquee />
      <main className="content">
        {page === 'top' ? (
          <Top canModerate={!!me?.canModerate} toast={show} />
        ) : page === 'shop' ? (
          <Shop me={me ?? null} tool={tool} onPick={pick} />
        ) : (
          <Game me={me ?? null} tool={tool} onSaved={() => void reload()} toast={show} />
        )}
      </main>
      <Footer onToast={show} />
      <CookieBanner />
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </>
  );
}

export function App() {
  const { status, session } = useStacks();
  return (
    <div className="site">
      <header className="top">
        <a className="brand" href="#/">
          Flippy Wоrk Tаblе<sup>™®©</sup>
        </a>
        <AccountMenu className="account" />
      </header>
      {status === 'loading' ? <Spinner /> : <Site key={session ? `${session.user.id}:${session.role}` : 'out'} />}
    </div>
  );
}
