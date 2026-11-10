import { describe, expect, it } from 'vitest';
import { migrate } from '../api/migrations/user-ids';

const idFor = (e: string) => `u_${e.toLowerCase().split('@')[0]}`;

describe('user-id migration', () => {
  it('stores the host, bringers and RSVPs by user id', () => {
    expect(
      migrate({ PK: 'EVENT#e1', SK: 'EVENT', GSI1PK: 'EVENTS', GSI1SK: '2026-01-10#e1', id: 'e1', title: 'Harvest', hostEmail: 'Olive@x.dev', hostName: 'Olive', cancelled: false }, idFor),
    ).toEqual({ PK: 'EVENT#e1', SK: 'EVENT', GSI1PK: 'EVENTS', GSI1SK: '2026-01-10#e1', id: 'e1', title: 'Harvest', hostId: 'u_olive', cancelled: false });
    expect(migrate({ PK: 'EVENT#e1', SK: 'DISH#d1', id: 'd1', name: 'Chili', bringerEmail: 'max@x.dev', bringerName: 'Max' }, idFor)).toEqual({
      PK: 'EVENT#e1',
      SK: 'DISH#d1',
      id: 'd1',
      name: 'Chili',
      bringerId: 'u_max',
    });
    expect(migrate({ PK: 'EVENT#e1', SK: 'RSVP#max@x.dev', eventId: 'e1', email: 'max@x.dev', name: 'Max', status: 'going', guests: 1 }, idFor)).toEqual({
      PK: 'EVENT#e1',
      SK: 'RSVP#u_max',
      eventId: 'e1',
      userId: 'u_max',
      status: 'going',
      guests: 1,
    });
  });

  it('handles the SDK items and leaves migrated items alone', () => {
    expect(migrate({ PK: 'SESSION#abc', SK: 'SESSION' }, idFor)).toBeNull();
    expect(migrate({ PK: 'AUDIT#2026', SK: 'x', actorEmail: 'olive@x.dev' }, idFor)).toMatchObject({ actorId: 'u_olive' });
    expect(migrate({ PK: 'EVENT#e1', SK: 'EVENT', hostId: 'u_olive' }, idFor)).toBeUndefined();
    expect(migrate({ PK: 'EVENT#e1', SK: 'DISH#d1', bringerId: 'u_max' }, idFor)).toBeUndefined();
    expect(migrate({ PK: 'EVENT#e1', SK: 'RSVP#u_max', userId: 'u_max' }, idFor)).toBeUndefined();
  });
});
