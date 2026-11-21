import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ConditionFailedError, type Item, type PutOptions, type Store } from './store';

/** The production {@link Store}, backed by the app's DynamoDB single table. */
export class DynamoStore implements Store {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async get<T extends Item>(pk: string, sk: string): Promise<T | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { PK: pk, SK: sk } }));
    return res.Item as T | undefined;
  }

  async put(item: Item, opts: PutOptions = {}): Promise<void> {
    const match = Object.entries(opts.ifMatch ?? {});
    const conditions = [
      ...(opts.ifNotExists ? ['attribute_not_exists(PK)'] : []),
      ...(opts.ifMatch ? ['attribute_exists(PK)', ...match.map((_, i) => `#m${i} = :m${i}`)] : []),
    ];
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ...(conditions.length ? { ConditionExpression: conditions.join(' AND ') } : {}),
          ...(match.length
            ? {
                ExpressionAttributeNames: Object.fromEntries(match.map(([k], i) => [`#m${i}`, k])),
                ExpressionAttributeValues: Object.fromEntries(match.map(([, v], i) => [`:m${i}`, v])),
              }
            : {}),
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new ConditionFailedError(`Item ${item.PK}/${item.SK} ${opts.ifMatch ? 'changed' : 'already exists'}`);
      }
      throw err;
    }
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: { PK: pk, SK: sk } }));
  }

  async query<T extends Item>(pk: string, skPrefix?: string): Promise<T[]> {
    return this.paginate<T>({
      TableName: this.tableName,
      KeyConditionExpression: skPrefix ? 'PK = :pk AND begins_with(SK, :sk)' : 'PK = :pk',
      ExpressionAttributeValues: skPrefix ? { ':pk': pk, ':sk': skPrefix } : { ':pk': pk },
    });
  }

  async queryGsi1<T extends Item>(gsi1pk: string, opts: { descending?: boolean } = {}): Promise<T[]> {
    return this.paginate<T>({
      TableName: this.tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': gsi1pk },
      ScanIndexForward: !opts.descending,
    });
  }

  private async paginate<T>(input: QueryCommandInput): Promise<T[]> {
    const items: T[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
      items.push(...((res.Items ?? []) as T[]));
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return items;
  }
}
