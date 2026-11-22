import { log } from '@stacks/api';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, DescribeLogGroupsCommand, GetQueryResultsCommand, StartQueryCommand, StopQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { parseManifest } from '@stacks/manifest';
import type { AppRegistry, AppSessionRevoker, RegisteredApp } from './model';
import type { MetricQuery, MetricSeries, Monitor, QueryStatus } from './monitoring';

interface Entry extends RegisteredApp {
  tableName?: string;
}

/**
 * The app registry: each app stack writes `/stacks/<env>/apps/<slug>/manifest` and `/table` to SSM
 * on deploy; credentials are the Secrets Manager secrets `stacks-<env>-app-<slug>-credential`.
 * Cached per Lambda container for a minute.
 */
export class SsmAppRegistry implements AppRegistry, AppSessionRevoker {
  private cache?: { at: number; apps: Entry[] };
  private readonly secrets = new Map<string, { at: number; value: Promise<string> }>();
  private readonly ssm = new SSMClient({});
  private readonly sm = new SecretsManagerClient({});
  private readonly doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  constructor(private readonly envTag: string) {}

  async list(): Promise<Entry[]> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.apps;
    const prefix = `/stacks/${this.envTag}/apps/`;
    const values = new Map<string, Record<string, string>>();
    let token: string | undefined;
    do {
      const page = await this.ssm.send(new GetParametersByPathCommand({ Path: prefix, Recursive: true, NextToken: token }));
      for (const p of page.Parameters ?? []) {
        const [slug, field] = (p.Name ?? '').slice(prefix.length).split('/');
        if (!slug || !field || p.Value === undefined) continue;
        values.set(slug, { ...values.get(slug), [field]: p.Value });
      }
      token = page.NextToken;
    } while (token);
    const apps: Entry[] = [];
    for (const [slug, v] of values) {
      try {
        const manifest = parseManifest(JSON.parse(v.manifest ?? 'null'), `${prefix}${slug}/manifest`);
        apps.push({ manifest, tableName: v.table, credential: () => this.credential(slug) });
      } catch (err) {
        log.error('Skipping an app: bad registry entry', { forApp: slug, error: err });
      }
    }
    this.cache = { at: Date.now(), apps };
    return apps;
  }

  private credential(slug: string): Promise<string> {
    const hit = this.secrets.get(slug);
    if (hit && Date.now() - hit.at < 300_000) return hit.value;
    const value = this.sm
      .send(new GetSecretValueCommand({ SecretId: `stacks-${this.envTag}-app-${slug}-credential` }))
      .then((r) => r.SecretString ?? '')
      .catch((err) => {
        this.secrets.delete(slug);
        throw err;
      });
    this.secrets.set(slug, { at: Date.now(), value });
    return value;
  }

  async endUserSessions(slug: string, userId: string): Promise<void> {
    const table = (await this.list()).find((a) => a.manifest.slug === slug)?.tableName;
    if (!table) return;
    const res = await this.doc.send(
      new QueryCommand({ TableName: table, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': `USERSESSIONS#${userId}` } }),
    );
    await Promise.all((res.Items ?? []).map((i) => this.doc.send(new DeleteCommand({ TableName: table, Key: { PK: i.PK, SK: i.SK } }))));
  }
}

/**
 * CloudWatch for the Monitoring page (#81): metrics with `GetMetricData`, logs with Logs Insights.
 * The Lambda may start queries only on `/stacks/<tag>/*` log groups (packages/infra).
 */
export class CloudWatchMonitor implements Monitor {
  private readonly cw = new CloudWatchClient({});
  private readonly logs = new CloudWatchLogsClient({});
  private groups?: { at: number; names: string[] };

  constructor(private readonly envTag: string) {}

  async getMetricData(q: { queries: MetricQuery[]; start: Date; end: Date }): Promise<MetricSeries[]> {
    const out: MetricSeries[] = [];
    let token: string | undefined;
    do {
      const res = await this.cw.send(
        new GetMetricDataCommand({
          StartTime: q.start,
          EndTime: q.end,
          ScanBy: 'TimestampAscending',
          MetricDataQueries: q.queries.map((m) => ({ Id: m.id, Expression: m.expression, Label: m.label, ReturnData: true })),
          NextToken: token,
        }),
      );
      for (const r of res.MetricDataResults ?? []) {
        const id = r.Id ?? '';
        const label = r.Label ?? '';
        const timestamps = (r.Timestamps ?? []).map((t) => t.getTime());
        const values = r.Values ?? [];
        // A later page continues the same series.
        const same = out.find((s) => s.id === id && s.label === label);
        if (same) {
          same.timestamps.push(...timestamps);
          same.values.push(...values);
        } else out.push({ id, label, timestamps, values: [...values] });
      }
      token = res.NextToken;
    } while (token);
    return out;
  }

  async listApiLogGroups(): Promise<string[]> {
    if (this.groups && Date.now() - this.groups.at < 300_000) return this.groups.names;
    const names: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: `/stacks/${this.envTag}/`, nextToken: token }));
      for (const g of res.logGroups ?? []) if (g.logGroupName && /^\/stacks\/[^/]+\/[^/]+\/api$/.test(g.logGroupName)) names.push(g.logGroupName);
      token = res.nextToken;
    } while (token);
    // Logs Insights takes at most 50 log groups per query; the platform's always stays in.
    const platform = `/stacks/${this.envTag}/platform/api`;
    const sorted = [...names.filter((n) => n === platform), ...names.filter((n) => n !== platform).sort()];
    if (sorted.length > 50) log.warn('More than 50 API log groups: the monitoring queries leave some out', { leftOut: sorted.slice(50) });
    this.groups = { at: Date.now(), names: sorted.slice(0, 50) };
    return this.groups.names;
  }

  async startQuery(q: { logGroupNames: string[]; queryString: string; start: Date; end: Date }): Promise<string | null> {
    try {
      return await this.start(q);
    } catch (err) {
      // A log group deleted since the list was cached (an app stack destroyed): refresh and retry once.
      if (!(err instanceof Error && err.name === 'ResourceNotFoundException')) throw err;
      this.groups = undefined;
      const live = new Set(await this.listApiLogGroups());
      const logGroupNames = q.logGroupNames.filter((n) => live.has(n));
      return logGroupNames.length ? this.start({ ...q, logGroupNames }) : null;
    }
  }

  async stopQuery(queryId: string): Promise<void> {
    await this.logs.send(new StopQueryCommand({ queryId }));
  }

  private async start(q: { logGroupNames: string[]; queryString: string; start: Date; end: Date }): Promise<string> {
    const res = await this.logs.send(
      new StartQueryCommand({ logGroupNames: q.logGroupNames, queryString: q.queryString, startTime: Math.floor(q.start.getTime() / 1000), endTime: Math.ceil(q.end.getTime() / 1000) }),
    );
    if (!res.queryId) throw new Error('StartQuery returned no query id');
    return res.queryId;
  }

  async getQueryResults(queryId: string): Promise<{ status: QueryStatus; rows: Record<string, string>[] }> {
    const res = await this.logs.send(new GetQueryResultsCommand({ queryId }));
    const rows = (res.results ?? []).map((fields) => Object.fromEntries(fields.filter((f) => f.field && f.value !== undefined).map((f) => [f.field!, f.value!])));
    return { status: (res.status ?? 'Unknown') as QueryStatus, rows };
  }
}
