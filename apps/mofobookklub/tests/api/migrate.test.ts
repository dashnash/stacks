import { describe, expect, it } from 'vitest';
import { migrate } from '../../api/migrations/user-ids';

const idFor = (e: string) => `u_${e.toLowerCase().split('@')[0]}`;

describe('user-id migration', () => {
  it('moves meetings, including the picked nomination, to user ids', () => {
    expect(
      migrate(
        {
          PK: 'MEETING#m1',
          SK: 'MEETING#m1',
          GSI1PK: 'MEETINGS#PAST',
          id: 'm1',
          leaderEmail: 'jane@x.dev',
          nextLeaderEmail: 'bob@x.dev',
          chosenNomination: { id: 'n1', bookIsbn: '1', nominatedByEmail: 'marcus@x.dev', createdAt: 't' },
        },
        idFor,
      ),
    ).toEqual({
      PK: 'MEETING#m1',
      SK: 'MEETING#m1',
      GSI1PK: 'MEETINGS#PAST',
      id: 'm1',
      leaderId: 'u_jane',
      nextLeaderId: 'u_bob',
      chosenNomination: { id: 'n1', bookIsbn: '1', nominatedById: 'u_marcus', createdAt: 't' },
    });
  });

  it('moves nominations, votes (and their keys) and book edits', () => {
    expect(migrate({ PK: 'LINEUP', SK: 'NOMINATION#n1', nominatedByEmail: 'bob@x.dev' }, idFor)).toEqual({ PK: 'LINEUP', SK: 'NOMINATION#n1', nominatedById: 'u_bob' });
    expect(migrate({ PK: 'MEETING#old', SK: 'NOMINATION#n0', nominatedByEmail: 'bob@x.dev' }, idFor)).toMatchObject({ nominatedById: 'u_bob' });
    expect(migrate({ PK: 'LINEUP', SK: 'VOTE#n1#Ann@x.dev', nominationId: 'n1', userEmail: 'Ann@x.dev' }, idFor)).toEqual({
      PK: 'LINEUP',
      SK: 'VOTE#n1#u_ann',
      nominationId: 'n1',
      userId: 'u_ann',
    });
    expect(migrate({ PK: 'BOOK#1', SK: 'BOOK#1', editedBy: 'admin@x.dev' }, idFor)).toEqual({ PK: 'BOOK#1', SK: 'BOOK#1', editedBy: 'u_admin' });
  });

  it('hands comments and sessions to the module and SDK, and leaves migrated items alone', () => {
    expect(migrate({ PK: 'THREAD#BOOK#1', SK: 'COMMENT#c1', authorEmail: 'ann@x.dev' }, idFor)).toMatchObject({ authorId: 'u_ann' });
    expect(migrate({ PK: 'SESSION#h', SK: 'SESSION' }, idFor)).toBeNull();
    expect(migrate({ PK: 'MEETING#m1', SK: 'MEETING#m1', leaderId: 'u_jane' }, idFor)).toBeUndefined();
    expect(migrate({ PK: 'BOOK#1', SK: 'BOOK#1', editedBy: 'u_admin' }, idFor)).toBeUndefined();
    expect(migrate({ PK: 'EASTEREGG', SK: 'EGG#1', quote: 'x' }, idFor)).toBeUndefined();
  });
});
