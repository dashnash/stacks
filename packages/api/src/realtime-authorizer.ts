/**
 * The Lambda authorizer for an app's AppSync Event API (the `realtime` module). `AppStack` bundles
 * this file as its own small function; it reads the app's realtime key from Secrets Manager and
 * checks each connect, subscribe and publish with {@link authorizeRealtime}.
 */
import { log } from './log';
import { authorizeRealtime, type EventsAuthorizerEvent, type EventsAuthorizerResult } from './realtime';
import { realtimeKeyReader } from './realtime-aws';

let key: (() => Promise<string>) | undefined;

export async function handler(event: EventsAuthorizerEvent): Promise<EventsAuthorizerResult> {
  const secretId = process.env.STACKS_REALTIME_KEY_ARN;
  if (!secretId) throw new Error('Missing STACKS_REALTIME_KEY_ARN');
  key ??= realtimeKeyReader({ secretId });
  const result = await authorizeRealtime(event, await key(), Date.now(), process.env.STACKS_REALTIME_NAMESPACE || undefined);
  if (!result.isAuthorized) log.warn('Realtime denied', { operation: event.requestContext?.operation, channel: event.requestContext?.channel });
  return result;
}
