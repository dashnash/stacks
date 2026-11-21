import { useEffect } from 'react';
import { useOptionalStacks } from './auth';

/** After a refused or failed warm-up (429 at `maxRooms`, offline), try again this much later. */
export const PREWARM_RETRY_MS = 60_000;
/**
 * Warm the next room this long before the last one runs out: after the API starts swapping it for a
 * new one (60 s before), before Play stops taking it (30 s before).
 */
const REWARM_LEAD_MS = 45_000;
/** A warm-up triggered by a key or pointer waits this long (that press may be Play's). */
const ACTIVITY_WARM_DELAY_MS = 1500;

/**
 * Start a game server early (`POST /rooms/warm`) while `enabled`, so the player's next
 * `POST /rooms` finds it already up instead of waiting 30-60 s. Call it where a game is likely:
 * a title screen with a Play button, a lobby. It warms each time `enabled` turns true (so coming
 * back to the title after a game warms the next one), again when the tab returns after the warm
 * room has expired, when it is about to expire with the player still active on the page (a key or
 * pointer since the last warm-up: a forgotten tab doesn't keep a server running), and a minute
 * after a refusal if the player is still active. Best effort: it never throws or shows anything, and does nothing signed out.
 */
export function usePrewarmRoom(enabled: boolean): void {
  const stacks = useOptionalStacks();
  const api = stacks?.api;
  const userId = stacks?.status === 'signedIn' ? stacks.session?.user.id : undefined;
  useEffect(() => {
    if (!enabled || !userId || !api) return;
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
    const active = () => {
      activeAt = Date.now();
      // Back after the last warm room ended: warm the next one, a moment later. (Not earlier: in its
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
      api
        .post<{ room: { warmUntil?: string }; leftMs?: number }>('/rooms/warm', {})
        .then(
          ({ room, leftMs }) => {
            if (gone) return;
            // Time left by the server's clock (older APIs: from warmUntil, by ours).
            const at = room.warmUntil ? Date.parse(room.warmUntil) : NaN;
            const left = typeof leftMs === 'number' ? leftMs : Number.isFinite(at) ? at - Date.now() : PREWARM_RETRY_MS;
            endsAt = Date.now() + left;
            clearTimeout(retry);
            // Shortly before Play would stop taking it (45 s before it ends), warm the next one if the
            // player is still about. At least a minute apart.
            const next = Math.max(PREWARM_RETRY_MS, left - REWARM_LEAD_MS);
            until = Date.now() + next;
            retry = setTimeout(() => activeAt > warmedAt && warm(), next);
          },
          () => {
            if (gone) return;
            until = endsAt = Date.now() + PREWARM_RETRY_MS;
            clearTimeout(retry);
            retry = setTimeout(() => activeAt > warmedAt && warm(), PREWARM_RETRY_MS);
          },
        )
        .finally(() => {
          busy = false;
        });
    };
    warm();
    document.addEventListener('visibilitychange', warm);
    document.addEventListener('pointerdown', active);
    document.addEventListener('keydown', active);
    return () => {
      gone = true;
      clearTimeout(retry);
      clearTimeout(soon);
      document.removeEventListener('visibilitychange', warm);
      document.removeEventListener('pointerdown', active);
      document.removeEventListener('keydown', active);
    };
  }, [api, enabled, userId]);
}
