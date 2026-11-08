import type { Deps } from './deps.js';
import type { User } from './model.js';
import type { RequestContext } from './router.js';

/** Facts a handler adds to its activity-log entry. */
export interface AuditFacts {
  /** What the action touched, as people know it: a book's title, a meeting's or member's name. */
  label?: string;
  [fact: string]: unknown;
}

export interface HandlerResult {
  status?: number;
  body: unknown;
  /** For actions that are logged: the label and any extra facts for the activity log. */
  audit?: AuditFacts;
}

/** A route handler for a signed-in user (the router checks their role first). */
export type Handler = (req: RequestContext, user: User, deps: Deps) => Promise<HandlerResult>;
