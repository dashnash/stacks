import type { AppDeps } from '@stacks/api';
import type { DemoOptions } from '@stacks/demo';
import { personas, seed } from '../../../api/demo-data';
import { manifest } from '../../../api/manifest';
import { routes } from '../../../api/routes';
import game from '../../../game/server';

/**
 * The app's UI and demo setup, in the shape every Stacks app exports from
 * `web/src/demo/setup.ts` (the demo build and the conformance test both use it).
 */
export { App } from '../App';

// `game` makes Live dots rooms run in the page: the tab that creates a room is its server.
export const demoOptions = (): DemoOptions<AppDeps> => ({ manifest, routes, personas, seed, game });
