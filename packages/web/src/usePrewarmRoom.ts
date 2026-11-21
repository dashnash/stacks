import { useEffect, useRef } from 'react';
import { useOptionalStacks } from './auth';

/** After a refused or failed warm-up (429 at `maxRooms`, offline), wait this long before trying again. */
export const PREWARM_RETRY_MS = 60_000;

/**
 * Start a game server early (`POST /rooms/warm`) while `enabled`, so the player's next
 * `POST /rooms` finds it already up instead of waiting 30-60 s. Call it where a game is likely:
 * a title screen with a Play button, a lobby. It warms once when `enabled` turns true, and again
 * when the tab comes back after the warm room has expired. Best effort: it never throws or shows
 * anything, and does nothing signed out.
 */
export function usePrewarmRoom(enabled: boolean): void {
  const stacks = useOptionalStacks();
  const api = stacks?.api;
  const signedIn = stacks?.status === 'signedIn';
  /** Until when the last warm room lasts (or when to retry after a refusal). */
  const until = useRef(0);
  useEffect(() => {
    if (!enabled || !signedIn || !api) return;
    let busy = false;
    const warm = () => {
      if (busy || document.visibilityState === 'hidden' || Date.now() < until.current) return;
      busy = true;
      api
        .post<{ room: { warmUntil?: string } }>('/rooms/warm', {})
        .then(
          ({ room }) => {
            const at = room.warmUntil ? Date.parse(room.warmUntil) : NaN;
            until.current = Number.isFinite(at) ? at : Date.now() + PREWARM_RETRY_MS;
          },
          () => {
            until.current = Date.now() + PREWARM_RETRY_MS;
          },
        )
        .finally(() => {
          busy = false;
        });
    };
    warm();
    document.addEventListener('visibilitychange', warm);
    return () => document.removeEventListener('visibilitychange', warm);
  }, [api, enabled, signedIn]);
}
