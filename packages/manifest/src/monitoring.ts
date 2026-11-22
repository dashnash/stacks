/*
 * Monitoring names and queries shared by `@stacks/infra` (the CloudWatch dashboard and saved
 * queries) and `platform/api` (the portal's Monitoring page, #81), so both read the same metrics
 * and run the same query text. Dependency-free on purpose.
 *
 * The APIs log with Lambda's JSON format, which nests the object `@stacks/api` writes under
 * `message`; every pattern and query reads `message.<field>`.
 */

/** `/stacks/<tag>/<slug>/api`, `/stacks/<tag>/<slug>/realtime-authorizer`; the platform's slug is `platform`. */
export const logGroupName = (tag: string, slug: string, kind: 'api' | 'realtime-authorizer' | 'game-server' = 'api') => `/stacks/${tag}/${slug}/${kind}`;

/**
 * How many days an app's API log group keeps lines (1 month on production, 1 week on staging): the
 * app stacks set it, and the Monitoring page never queries further back.
 */
export const apiLogRetentionDays = (tag: string): 7 | 30 => (tag === 'prod' ? 30 : 7);

/** The CloudWatch namespace of an environment's metrics: `Stacks/prod`, `Stacks/test`. */
export const metricNamespace = (tag: string) => `Stacks/${tag}`;

/** The one dashboard of an environment: `stacks-prod`, `stacks-test`. */
export const dashboardName = (tag: string) => `stacks-${tag}`;

/** A CloudWatch metric math `SEARCH` over `{schema}` matching `terms`. */
export const searchExpression = (schema: string, terms: string, stat: string, periodSeconds: number) => `SEARCH('{${schema}} ${terms}', '${stat}', ${periodSeconds})`;

/** Our metrics (from the API log groups' metric filters), one series per `app`. */
export const appMetricSearch = (tag: string, metric: string, stat: string, periodSeconds: number) =>
  searchExpression(`${metricNamespace(tag)},app`, `MetricName="${metric}"`, stat, periodSeconds);

/**
 * AWS's own metrics for this environment's stacks. They have no Stacks dimension; stack names
 * (`stacks-<tag>-…`) start every function and table name, so the search asks for both words.
 */
export const awsMetricSearch = (tag: string, schema: string, metric: string, stat: string, periodSeconds: number) =>
  searchExpression(schema, `MetricName="${metric}" stacks ${tag}`, stat, periodSeconds);

export interface SavedQuery {
  name: string;
  query: readonly string[];
}

/** The saved Logs Insights queries (and the dashboard's log tables). Placeholders in CAPITALS are edited before running. */
export const SAVED_QUERIES = {
  findByRef: {
    name: 'Find by ref',
    query: [
      'fields @timestamp, message.type, message.app, message.method, message.route, message.status, message.durationMs, message.userId, message.message, message.error.name, message.error.message, message.error.stack',
      'filter message.ref = "PASTE-REF"',
      'sort @timestamp asc',
      'limit 200',
    ],
  },
  latestErrors: {
    name: 'Latest errors',
    query: [
      'fields @timestamp, message.app, message.type, message.ref, message.route, message.userId, coalesce(message.error.message, message.message) as error',
      'filter message.type in ["error", "client-error"]',
      'sort @timestamp desc',
      'limit 50',
    ],
  },
  browserErrors: {
    name: 'Browser errors',
    query: [
      'fields @timestamp, message.app, message.userId, message.clientBuild, message.source, message.path, message.message, message.stack',
      'filter message.type = "client-error"',
      'sort @timestamp desc',
      'limit 100',
    ],
  },
  slowestRequests: {
    name: 'Slowest requests',
    query: [
      'fields @timestamp, message.app, message.method, message.route, message.status, message.durationMs, message.ref, message.userId',
      'filter message.type = "request"',
      'sort message.durationMs desc',
      'limit 50',
    ],
  },
  userTrail: {
    name: "One user's trail",
    query: [
      'fields @timestamp, message.app, message.type, message.method, message.route, message.status, message.durationMs, message.ref, message.userId, message.message',
      'filter message.userId = "u_PASTE-USER-ID"',
      'sort @timestamp asc',
      'limit 500',
    ],
  },
  appRequests: {
    name: "One app's requests",
    query: [
      'fields @timestamp, message.method, message.route, message.status, message.durationMs, message.userId, message.ref',
      'filter message.type = "request" and message.app = "APP-SLUG"',
      'sort @timestamp desc',
      'limit 200',
    ],
  },
} as const satisfies Record<string, SavedQuery>;

export type SavedQueryId = keyof typeof SAVED_QUERIES;

/** The query text Logs Insights takes: the lines joined by pipes. */
export const queryText = (lines: readonly string[]) => lines.join('\n| ');
