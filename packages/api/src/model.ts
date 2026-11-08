import type { AppManifest } from '@stacks/manifest';
import type { PlatformClient } from './platform';
import type { Store } from './store';

/** A signed-in person as apps see them: email, the name they chose to show, and their avatar. */
export interface StacksUser {
  email: string;
  /** The display name from their global profile (never their full Google name). */
  name: string;
  pictureUrl?: string;
}

export interface AppConfig {
  /** This app's origin, e.g. `https://book-club.example.com`. */
  appOrigin: string;
  /** The platform's sign-in origin, e.g. `https://auth.example.com`. */
  authOrigin: string;
}

/** What every app handler can use. Apps extend it with their own dependencies. */
export interface AppDeps {
  store: Store;
  platform: PlatformClient;
  config: AppConfig;
  now(): Date;
  newId(): string;
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
