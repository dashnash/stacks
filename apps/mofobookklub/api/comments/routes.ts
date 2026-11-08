import { commentCounts as moduleCounts, type ThreadTarget } from '@stacks/comments';
import type { Deps } from '../utils/deps.js';

/** Comments are the shared @stacks/comments module now; same storage keys as before. */
export const commentCounts = (deps: Deps, targets: ThreadTarget[]) => moduleCounts(deps.store, targets);
