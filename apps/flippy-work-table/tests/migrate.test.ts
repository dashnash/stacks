import { describe, expect, it } from 'vitest';
import { migrate } from '../api/migrations/user-ids';

const idFor = (e: string) => `u_${e.toLowerCase().split('@')[0]}`;

describe('user-id migration', () => {
  it('re-keys flips and leaderboard rows by user id', () => {
    expect(migrate({ PK: 'FLIPS#Max@x.dev', SK: 't#f1', id: 'f1', score: 9 }, idFor)).toEqual({ PK: 'FLIPS#u_max', SK: 't#f1', id: 'f1', score: 9 });
    expect(migrate({ PK: 'PLAYER', SK: 'max@x.dev', playerId: 'p1', email: 'max@x.dev', name: 'Max', best: 9 }, idFor)).toEqual({
      PK: 'PLAYER',
      SK: 'u_max',
      playerId: 'p1',
      userId: 'u_max',
      name: 'Max',
      best: 9,
    });
  });

  it('leaves migrated items alone', () => {
    expect(migrate({ PK: 'FLIPS#u_max', SK: 't#f1' }, idFor)).toBeUndefined();
    expect(migrate({ PK: 'PLAYER', SK: 'u_max', userId: 'u_max' }, idFor)).toBeUndefined();
  });
});
