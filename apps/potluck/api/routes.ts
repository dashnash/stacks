import type { AppDeps, AppRoutes } from '@stacks/api';
import { dishRoutes } from './dishes';
import { eventRoutes } from './events';

/** Potluck's API. The same routes run in Lambda, in tests and in the browser demo. */
export function routes(api: AppRoutes<AppDeps>) {
  eventRoutes(api);
  dishRoutes(api);
}
