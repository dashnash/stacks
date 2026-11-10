import { describe, expect, it } from 'vitest';
import { composeMigrations, fixtureUserId, migrateSdkItems, renameEmailField, type ItemMigration } from '../src/migrate';

const idFor = (e: string) => `u_${e.toLowerCase().split('@')[0]}`;

describe('user-id migrations', () => {
  it('drops sessions and rewrites activity-log actors', () => {
    expect(migrateSdkItems({ PK: 'SESSION#abc', SK: 'SESSION', user: { email: 'a@x' } }, idFor)).toBeNull();
    expect(migrateSdkItems({ PK: 'AUDIT#2026-01', SK: '2026-01-02#e1', actorEmail: 'Ann@x.dev', actorName: 'Ann', action: 'x' }, idFor)).toEqual({
      PK: 'AUDIT#2026-01',
      SK: '2026-01-02#e1',
      actorId: 'u_ann',
      actorName: 'Ann',
      action: 'x',
    });
    expect(migrateSdkItems({ PK: 'AUDIT#2026-01', SK: 's', actorId: 'u_ann' }, idFor)).toBeUndefined(); // already migrated
    expect(migrateSdkItems({ PK: 'BOOK#1', SK: 'BOOK' }, idFor)).toBeUndefined();
  });

  it('lets the first migration with an opinion win', () => {
    const app: ItemMigration = (item) => (item.PK === 'BOOK#1' ? { ...item, done: true } : undefined);
    const all = composeMigrations(migrateSdkItems, app);
    expect(all({ PK: 'BOOK#1', SK: 'BOOK' }, idFor)).toEqual({ PK: 'BOOK#1', SK: 'BOOK', done: true });
    expect(all({ PK: 'SESSION#x', SK: 'SESSION' }, idFor)).toBeNull();
    expect(all({ PK: 'OTHER', SK: 'X' }, idFor)).toBeUndefined();
  });

  it('renames email fields only when they hold an email', () => {
    expect(renameEmailField({ PK: 'A', SK: 'B', by: 'bo@x' }, 'by', 'byId', idFor)).toEqual({ PK: 'A', SK: 'B', byId: 'u_bo' });
    expect(renameEmailField({ PK: 'A', SK: 'B' }, 'by', 'byId', idFor)).toEqual({ PK: 'A', SK: 'B' });
  });

  it('gives demo and test people readable ids', () => {
    expect(fixtureUserId('Ann.Lee@demo.dev')).toBe('u_ann_lee_demo_dev');
  });
});
