import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DynamoStore } from '../src/dynamo-store';
import { ConditionFailedError, MemoryStore } from '../src/index';

afterEach(() => vi.restoreAllMocks());

describe('conditional puts', () => {
  it('MemoryStore: ifMatch writes only over an item whose listed attributes are unchanged', async () => {
    const store = new MemoryStore([{ PK: 'R', SK: 'META', status: 'starting', warm: true }]);
    await expect(store.put({ PK: 'R', SK: 'META', status: 'starting' }, { ifMatch: { status: 'starting', warm: true } })).resolves.toBeUndefined();
    // Changed meanwhile (no longer warm), or gone: refused, nothing written.
    await expect(store.put({ PK: 'R', SK: 'META', status: 'x' }, { ifMatch: { warm: true } })).rejects.toBeInstanceOf(ConditionFailedError);
    await expect(store.put({ PK: 'GONE', SK: 'META' }, { ifMatch: { status: 'starting' } })).rejects.toBeInstanceOf(ConditionFailedError);
    expect(await store.get('R', 'META')).toEqual({ PK: 'R', SK: 'META', status: 'starting' });
    expect(await store.get('GONE', 'META')).toBeUndefined();
  });

  it('DynamoStore: sends the matching condition, and turns a failed check into ConditionFailedError', async () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockResolvedValue({} as never);
    const store = new DynamoStore('t');
    await store.put({ PK: 'R', SK: 'META', status: 'starting' }, { ifMatch: { status: 'starting', warm: true } });
    expect((send.mock.calls[0]![0] as { input: unknown }).input).toMatchObject({
      TableName: 't',
      ConditionExpression: 'attribute_exists(PK) AND #m0 = :m0 AND #m1 = :m1',
      ExpressionAttributeNames: { '#m0': 'status', '#m1': 'warm' },
      ExpressionAttributeValues: { ':m0': 'starting', ':m1': true },
    });
    await store.put({ PK: 'R', SK: 'X' }, { ifNotExists: true });
    expect((send.mock.calls[1]![0] as { input: Record<string, unknown> }).input).toMatchObject({ ConditionExpression: 'attribute_not_exists(PK)' });
    expect((send.mock.calls[1]![0] as { input: Record<string, unknown> }).input).not.toHaveProperty('ExpressionAttributeNames');
    send.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' }));
    await expect(store.put({ PK: 'R', SK: 'META' }, { ifMatch: { warm: true } })).rejects.toThrow(/R\/META changed/);
  });
});
