import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalStacks } from './auth';
import { realtimeHub, type ChannelStatus } from './realtime';

export interface UseChannelOptions {
  /** Ask for the right to publish (the channel's `publish` guard must allow it). */
  publish?: boolean;
  /** Called on every (re)connect: refetch what you show, since events may have been missed. */
  onResync?: () => void;
  /** Also receive this tab's own publishes (off by default). */
  echo?: boolean;
}

export interface ChannelHandle<T> {
  status: ChannelStatus;
  /** Send `data` (any JSON, at most 4 KB) to everyone on the channel. Needs `{ publish: true }` and a live channel. */
  publish(data: T): Promise<void>;
}

/**
 * Live events on one channel (manifest module `realtime`), e.g. `useChannel('counter/main', (e) => setN(e.n))`.
 * Signed out, or with `channel` null, it stays `offline`. All channels on the page share one socket.
 */
export function useChannel<T = unknown>(channel: string | null, onEvent: (data: T) => void, opts: UseChannelOptions = {}): ChannelHandle<T> {
  const stacks = useOptionalStacks();
  const api = stacks?.api;
  const signedIn = stacks?.status === 'signedIn' && !!stacks.session;
  const who = stacks?.session ? `${stacks.session.user.id}:${stacks.session.role}` : '';
  const [status, setStatus] = useState<ChannelStatus>(signedIn && channel ? 'connecting' : 'offline');
  const eventRef = useRef(onEvent);
  eventRef.current = onEvent;
  const resyncRef = useRef(opts.onResync);
  resyncRef.current = opts.onResync;
  const wantsPublish = !!opts.publish;
  const echo = !!opts.echo;

  useEffect(() => {
    if (!api || !signedIn || !channel) {
      setStatus('offline');
      return;
    }
    return realtimeHub(api).add(
      {
        channel,
        publish: wantsPublish,
        echo,
        onEvent: (data) => eventRef.current(data as T),
        onResync: () => resyncRef.current?.(),
        onStatus: setStatus,
      },
      who,
    );
  }, [api, signedIn, who, channel, wantsPublish, echo]);

  const publish = useCallback(
    async (data: T) => {
      if (!api || !channel) throw new Error('Sign in to publish');
      await realtimeHub(api).publish(channel, data);
    },
    [api, channel],
  );

  return { status, publish };
}
