import { useEffect, useState } from 'react';
import { useOptionalStacks } from './auth';

/** After a refused or failed warm-up (429 at `maxRooms`, offline), try again this much later. */
export const PREWARM_RETRY_MS = 60_000;
/** While the warm room's server is starting, ask how it is this often. */
export const PREWARM_POLL_MS = 3000;
/**
 * Warm the next room this long before the last one runs out: after the API starts swapping it for a
 * new one (60 s before), before Play stops taking it (30 s before).
 */
const REWARM_LEAD_MS = 45_000;
/** `POST /rooms` stops taking a warm room this long before it ends (the API's `WARM_ADOPT_MARGIN_MS`). */
const ADOPT_MARGIN_MS = 30_000;
/** A warm-up triggered by a key or pointer waits this long (that press may be Play's, which unmounts the title). */
const ACTIVITY_WARM_DELAY_MS = 5000;

/**
 * Where pre-warming is, for a title screen that waits for it:
 * - `off`: not enabled, or signed out.
 * - `idle`: enabled, no warm room yet or the last one ran out (a key, pointer or tab return warms the next).
 * - `warming`: asked for one, its server is starting (`roomId` once known).
 * - `ready`: a warm room is open, and the next `POST /rooms` takes it over (`roomId`).
 * - `busy`: refused (`maxRooms`) or failed (`error`); tried again every {@link PREWARM_RETRY_MS} while the tab is visible.
 */
export type PrewarmStatus = 'off' | 'idle' | 'warming' | 'ready' | 'busy';
export interface PrewarmRoom {
  status: PrewarmStatus;
  roomId?: string;
  error?: Error;
}

const OFF: PrewarmRoom = { status: 'off' };

interface Warm {
  id: string;
  open: boolean;
  /** Browser clock: when `POST /rooms` stops taking it. */
  adoptUntil: number;
}

/**
 * Start a game server early (`POST /rooms/warm`) while `enabled`, so the player's next
 * `POST /rooms` finds it already up instead of waiting 30-60 s. Call it where a game is likely:
 * a title screen with a Play button, a lobby. It warms each time `enabled` turns true (so coming
 * back to the title after a game warms the next one), again when the tab returns after the warm
 * room has expired, when it is about to expire with the player still active on the page (a key or
 * pointer since the last warm-up: a forgotten tab doesn't keep a server running), and a minute
 * after a refusal while the tab is visible. Best effort: it never throws or shows anything, and does
 * nothing signed out. Returns where it is ({@link PrewarmRoom}), so a title can show progress and
 * enable Play once `status` is `ready`.
 */
export function usePrewarmRoom(enabled: boolean): PrewarmRoom {
  const stacks = useOptionalStacks();
  const api = stacks?.api;
  const userId = stacks?.status === 'signedIn' ? stacks.session?.user.id : undefined;
  const [state, setState] = useState<PrewarmRoom>(OFF);
  useEffect(() => {
    if (!enabled || !userId || !api) {
      setState(OFF);
      return;
    }
    /** Until when the last warm room lasts (or when to retry after a refusal). */
    let until = 0;
    let busy = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let gone = false;
    let activeAt = Date.now();
    let warmedAt = 0;
    /** When the last warm room ends (browser clock), so activity after it can warm the next. */
    let endsAt = 0;
    let soon: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let lapse: ReturnType<typeof setTimeout> | undefined;
    /** The open room Play would take, and a newer one still starting. */
    let ready: Warm | undefined;
    let pending: Warm | undefined;
    let failed: Error | undefined;

    const show = () => {
      if (gone) return;
      const now = Date.now();
      if (ready && now >= ready.adoptUntil) ready = undefined;
      if (pending && now >= pending.adoptUntil) pending = undefined;
      clearTimeout(lapse);
      if (ready) lapse = setTimeout(show, ready.adoptUntil - now);
      const next: PrewarmRoom = ready
        ? { status: 'ready', roomId: ready.id }
        : pending || busy
          ? { status: 'warming', roomId: pending?.id }
          : failed
            ? { status: 'busy', error: failed }
            : { status: 'idle' };
      setState((s) => (s.status === next.status && s.roomId === next.roomId && s.error === next.error ? s : next));
    };
    const check = () => {
      clearTimeout(poll);
      const room = pending;
      if (!room || gone) return;
      api.get<{ room?: { status?: string } }>(`/rooms/${encodeURIComponent(room.id)}`).then(
        ({ room: r }) => {
          if (gone || pending !== room) return;
          if (r?.status === 'open') {
            ready = { ...room, open: true };
            pending = undefined;
          } else if (r?.status === 'ended') pending = undefined;
          else poll = setTimeout(check, PREWARM_POLL_MS);
          show();
        },
        () => {
          if (gone || pending !== room) return;
          poll = setTimeout(check, PREWARM_POLL_MS);
        },
      );
    };
    const active = () => {
      activeAt = Date.now();
      // Back after the last warm room ended: warm the next one, a few seconds later. (Not earlier: in its
      // last minute a warm-up swaps it. And this press may be the click on Play, which unmounts the
      // title, so the delay lets that cancel it instead of starting a second server.)
      if (Date.now() >= endsAt) {
        clearTimeout(soon);
        soon = setTimeout(warm, ACTIVITY_WARM_DELAY_MS);
      }
    };
    const warm = () => {
      if (gone || busy || document.visibilityState === 'hidden' || Date.now() < until) return;
      busy = true;
      warmedAt = Date.now();
      show();
      api
        .post<{ room: { id?: string; status?: string; warmUntil?: string }; leftMs?: number }>('/rooms/warm', {})
        .then(
          ({ room, leftMs }) => {
            if (gone) return;
            failed = undefined;
            // Time left by the server's clock (older APIs: from warmUntil, by ours).
            const at = room.warmUntil ? Date.parse(room.warmUntil) : NaN;
            const left = typeof leftMs === 'number' ? leftMs : Number.isFinite(at) ? at - Date.now() : PREWARM_RETRY_MS;
            endsAt = Date.now() + left;
            if (room.id) {
              const w: Warm = { id: room.id, open: room.status === 'open', adoptUntil: endsAt - ADOPT_MARGIN_MS };
              if (w.open) {
                ready = w;
                if (pending?.id === w.id) pending = undefined;
              } else if (ready?.id !== w.id) {
                pending = w;
                check();
              }
            }
            clearTimeout(retry);
            // Shortly before Play would stop taking it (45 s before it ends), warm the next one if the
            // player is still about. At least a minute apart.
            const next = Math.max(PREWARM_RETRY_MS, left - REWARM_LEAD_MS);
            // (A timer may fire a moment early: `until` is a second sooner, so it isn't a no-op.)
            until = Date.now() + next - 1000;
            retry = setTimeout(() => activeAt > warmedAt && warm(), next);
          },
          (err: unknown) => {
            if (gone) return;
            failed = err instanceof Error ? err : new Error(String(err));
            endsAt = Date.now() + PREWARM_RETRY_MS;
            until = endsAt - 1000;
            clearTimeout(retry);
            // A refusal starts nothing, so retry while the tab is visible (someone may be waiting on it).
            retry = setTimeout(warm, PREWARM_RETRY_MS);
          },
        )
        .finally(() => {
          busy = false;
          show();
        });
    };
    show();
    warm();
    document.addEventListener('visibilitychange', warm);
    document.addEventListener('pointerdown', active);
    document.addEventListener('keydown', active);
    return () => {
      gone = true;
      clearTimeout(retry);
      clearTimeout(soon);
      clearTimeout(poll);
      clearTimeout(lapse);
      document.removeEventListener('visibilitychange', warm);
      document.removeEventListener('pointerdown', active);
      document.removeEventListener('keydown', active);
    };
  }, [api, enabled, userId]);
  return state;
}
