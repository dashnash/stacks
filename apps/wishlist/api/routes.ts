import type { AppDeps, AppRoutes } from '@stacks/api';
import { claimRoutes } from './claims';
import { listRoutes } from './lists';

/** Wishlist's API. The same routes run in Lambda, in tests and in the browser demo. */
export function routes(api: AppRoutes<AppDeps>) {
  listRoutes(api);
  claimRoutes(api);
}
