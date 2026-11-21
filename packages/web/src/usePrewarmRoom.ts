import { useEffect } from 'react';
import { useOptionalStacks } from './auth';

/** After a refused or failed warm-up (429 at `maxRooms`, offline), try again this much later. */
export const PREWARM_RETRY_MS = 60_000;

/**
 * Start a game server early (`POST /rooms/warm`) while `enabled`, so the player's next
 * `POST /rooms` finds it already up instead of waiting 30-60 s. Call it where a game is likely:
 * a title screen with a Play button, a lobby. It warms each time `enabled` turns true (so coming
 * back to the title after a game warms the next one), again when the tab returns after the warm
 * room has expired, and a minute after a refusal. Best effort: it never throws or shows anything,
 * and does nothing signed out.
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
    const warm = () => {
      if (gone || busy || document.visibilityState === 'hidden' || Date.now() < until) return;
      busy = true;
      api
        .post<{ room: { warmUntil?: string } }>('/rooms/warm', {})
        .then(
          ({ room }) => {
            const at = room.warmUntil ? Date.parse(room.warmUntil) : NaN;
            until = Number.isFinite(at) ? at : Date.now() + PREWARM_RETRY_MS;
          },
          () => {
            until = Date.now() + PREWARM_RETRY_MS;
            clearTimeout(retry);
            retry = setTimeout(warm, PREWARM_RETRY_MS);
          },
        )
        .finally(() => {
          busy = false;
        });
    };
    warm();
    document.addEventListener('visibilitychange', warm);
    return () => {
      gone = true;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', warm);
    };
  }, [api, enabled, userId]);
}
