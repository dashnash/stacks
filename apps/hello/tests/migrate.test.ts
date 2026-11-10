import { describe, expect, it } from 'vitest';
import { migrate } from '../api/migrations/user-ids';

const idFor = (e: string) => `u_${e.split('@')[0]}`;

describe('user-id migration', () => {
  it('moves greetings to author ids and drops sessions', () => {
    expect(migrate({ PK: 'GREETINGS', SK: 't#g1', id: 'g1', text: 'hi', authorEmail: 'max@x.dev', authorName: 'Max' }, idFor)).toEqual({
      PK: 'GREETINGS',
      SK: 't#g1',
      id: 'g1',
      text: 'hi',
      authorId: 'u_max',
      authorName: 'Max',
    });
    expect(migrate({ PK: 'SESSION#x', SK: 'SESSION' }, idFor)).toBeNull();
    expect(migrate({ PK: 'GREETINGS', SK: 't#g2', authorId: 'u_max' }, idFor)).toBeUndefined();
  });
});
