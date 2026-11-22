import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { appMetricSearch, awsMetricSearch, dashboardName, logGroupName, metricNamespace, queryText, SAVED_QUERIES } from '@stacks/manifest/monitoring';

/*
 * Monitoring (docs/PLATFORM_SPEC.md "Monitoring", docs/DEBUGGING.md): named log groups, metric
 * filters on each API's log group, and one dashboard plus saved Logs Insights queries per
 * environment. Pull only: nothing here alarms or notifies.
 *
 * The APIs log with Lambda's JSON format, which nests the object `@stacks/api` writes under
 * `message`; every pattern and query below reads `message.<field>`.
 */

export { dashboardName, logGroupName, metricNamespace, SAVED_QUERIES } from '@stacks/manifest/monitoring';

/** The metric filters every API log group gets: name, pattern and what each match adds. */
export const API_METRIC_FILTERS: { id: string; metricName: string; pattern: string; value: string; unit?: cloudwatch.Unit }[] = [
  { id: 'Requests', metricName: 'Requests', pattern: '{ $.message.type = "request" }', value: '1' },
  { id: 'ServerErrors', metricName: 'ServerErrors', pattern: '{ $.message.type = "request" && $.message.status >= 500 }', value: '1' },
  { id: 'UnhandledErrors', metricName: 'UnhandledErrors', pattern: '{ $.message.type = "error" }', value: '1' },
  { id: 'ClientErrors', metricName: 'ClientErrors', pattern: '{ $.message.type = "client-error" }', value: '1' },
  { id: 'DurationMs', metricName: 'DurationMs', pattern: '{ $.message.type = "request" }', value: '$.message.durationMs', unit: cloudwatch.Unit.MILLISECONDS },
];

/**
 * Turn an API's log lines into metrics in `Stacks/<tag>`, with the dimension `app` read from each
 * line (the slug, or `platform`). Metrics only exist for minutes that had a matching line.
 */
export function addApiMetricFilters(scope: Construct, logGroup: logs.ILogGroup, tag: string): void {
  for (const f of API_METRIC_FILTERS) {
    new logs.MetricFilter(scope, `Metric${f.id}`, {
      logGroup,
      filterPattern: logs.FilterPattern.literal(f.pattern),
      metricNamespace: metricNamespace(tag),
      metricName: f.metricName,
      metricValue: f.value,
      dimensions: { app: '$.message.app' },
      ...(f.unit ? { unit: f.unit } : {}),
    });
  }
}

export interface MonitoringProps {
  /** `prod` or `test`. */
  tag: string;
  /**
   * The apps of this environment. Their API log groups (and the platform's) are what the log
   * tables and saved queries read, so a new app joins them on the next platform deploy. (The
   * metric graphs find apps by themselves.)
   */
  appSlugs: string[];
}

/**
 * The environment's dashboard `stacks-<tag>` and its saved queries (folder `stacks-<tag>/`).
 * Built in the platform stack: one dashboard per environment, never one per app.
 */
export class Monitoring {
  readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, props: MonitoringProps) {
    const { tag } = props;
    const logGroupNames = [logGroupName(tag, 'platform'), ...[...new Set(props.appSlugs)].sort().map((slug) => logGroupName(tag, slug))];
    const period = cdk.Duration.minutes(5);
    // SEARCH, so an app that starts logging shows up with no platform deploy.
    const expr = (expression: string) => new cloudwatch.MathExpression({ expression, usingMetrics: {}, label: '', period });
    const ours = (metric: string, stat = 'Sum') => expr(appMetricSearch(tag, metric, stat, period.toSeconds()));
    const aws = (schema: string, metric: string, stat = 'Sum') => expr(awsMetricSearch(tag, schema, metric, stat, period.toSeconds()));
    const graph = (title: string, left: cloudwatch.IMetric[], width = 6) => new cloudwatch.GraphWidget({ title, left, width, height: 6, leftYAxis: { min: 0 } });
    const table = (q: { name: string; query: readonly string[] }, height: number) =>
      new cloudwatch.LogQueryWidget({ title: q.name, logGroupNames, queryString: queryText(q.query), view: cloudwatch.LogQueryVisualizationType.TABLE, width: 24, height });

    this.dashboard = new cloudwatch.Dashboard(scope, 'Dashboard', { dashboardName: dashboardName(tag), defaultInterval: cdk.Duration.hours(24) });
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        width: 24,
        height: 2,
        markdown: `# Stacks ${tag}\nSomeone sent a ref? **Logs Insights → Saved queries → ${dashboardName(tag)} → Find by ref**, paste it, run. More in \`docs/DEBUGGING.md\`. Nothing here alerts: it is for looking.`,
      }),
    );
    this.dashboard.addWidgets(
      graph('Requests per app', [ours('Requests')]),
      graph('Server errors per app (5xx and unhandled)', [ours('ServerErrors'), ours('UnhandledErrors')]),
      graph('Browser errors per app', [ours('ClientErrors')]),
      graph('Request duration per app (p95, ms)', [ours('DurationMs', 'p95')]),
    );
    this.dashboard.addWidgets(
      graph('Lambda errors and throttles', [aws('AWS/Lambda,FunctionName', 'Errors'), aws('AWS/Lambda,FunctionName', 'Throttles')], 8),
      graph('Lambda duration (p95, ms)', [aws('AWS/Lambda,FunctionName', 'Duration', 'p95')], 8),
      graph('DynamoDB throttled requests', [aws('AWS/DynamoDB,TableName,Operation', 'ThrottledRequests')], 8),
    );
    this.dashboard.addWidgets(table(SAVED_QUERIES.latestErrors, 8));
    this.dashboard.addWidgets(table(SAVED_QUERIES.slowestRequests, 8));

    for (const [id, q] of Object.entries(SAVED_QUERIES)) {
      new logs.CfnQueryDefinition(scope, `Query${id[0]!.toUpperCase()}${id.slice(1)}`, {
        name: `${dashboardName(tag)}/${q.name}`,
        queryString: queryText(q.query),
        logGroupNames,
      });
    }
  }
}
