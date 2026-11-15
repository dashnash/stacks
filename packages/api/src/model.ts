import type { AppManifest } from '@stacks/manifest';
import type { Games } from './games';
import type { PlatformClient } from './platform';
import type { Realtime } from './realtime';
import type { Store } from './store';

/** A signed-in person as apps see them: their id, the name they chose to show, and their avatar. */
export interface StacksUser {
  /**
   * Stable platform user id (`u_…`). Key everything you store about a person on this, never on
   * their email: emails change, and some people sign in with addresses that hide their real one.
   */
  id: string;
  /** Only for apps whose manifest has `needsEmail` (it may be a relay address). Never a key. */
  email?: string;
  /**
   * Ids of accounts this person merged into this one. Data an app stored under them is theirs: compare
   * with `isUser(user, storedId)`, not `===`.
   */
  formerIds?: string[];
  /** The display name from their global profile (never their full Google name). */
  name: string;
  pictureUrl?: string;
}

export interface AppConfig {
  /** This app's origin, e.g. `https://book-club.example.com`. */
  appOrigin: string;
  /** The platform's sign-in origin, e.g. `https://auth.example.com`. */
  authOrigin: string;
  /** While true, every route but /health answers 503 (set from `stacks.config.json` during a cut-over). */
  maintenance?: boolean;
}

/** What every app handler can use. Apps extend it with their own dependencies. */
export interface AppDeps {
  store: Store;
  platform: PlatformClient;
  config: AppConfig;
  now(): Date;
  newId(): string;
  /**
   * The app's secrets (manifest `secrets`), or undefined when not set. Wired by `createLambdaHandler`;
   * tests pass a fake. Cached for 5 minutes per container.
   */
  secret?(name: string): Promise<string | undefined>;
  /**
   * Live events to open browsers (manifest module `realtime`): `await deps.realtime.publish('counter/main', { n })`.
   * Without the module every call fails with an error saying how to turn it on.
   */
  realtime: Realtime;
  /**
   * Game servers (manifest module `gameServer`): `start(roomId)` / `stop(roomId)` for apps that
   * create rooms their own way; the built-in `/rooms` routes use it for you. Without the module
   * every call fails with an error saying how to turn it on.
   */
  games: Games;
}

/** The caller of a signed-in route. */
export interface Viewer<D extends AppDeps = AppDeps> {
  user: StacksUser;
  /** Their role in this app (one of the manifest's role ids). */
  role: string;
  /** Whether their role can approve requests and set roles. */
  canManageAccess: boolean;
  deps: D;
  manifest: AppManifest;
}
