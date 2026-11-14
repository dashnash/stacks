import { log } from '@stacks/api';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { parseManifest } from '@stacks/manifest';
import type { AppRegistry, AppSessionRevoker, RegisteredApp } from './model';

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
