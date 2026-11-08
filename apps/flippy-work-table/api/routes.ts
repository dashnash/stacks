import type { AppDeps, AppRoutes } from '@stacks/api';
import { flipRoutes } from './flips';

/** Flippy Work Table's API. The same routes run in Lambda, in tests and in the browser demo. */
export function routes(api: AppRoutes<AppDeps>) {
  flipRoutes(api);
}
