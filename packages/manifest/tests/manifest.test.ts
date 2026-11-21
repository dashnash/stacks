import { describe, expect, it } from 'vitest';
import { canManageAccess, gameServerSettings, parseManifest, validateManifest, type AppManifest } from '../src/index';

const valid: AppManifest = {
  slug: 'book-club',
  name: 'MOFO Book Klub',
  tagline: 'Nominate, vote, read, meet.',
  description: 'The next meeting, The Lineup and the shelf.',
  visibility: 'private',
  roles: [
    { id: 'OWNER', label: 'Owner', canManageAccess: true, canManageApprovers: true },
    { id: 'ADMIN', label: 'Admin', canManageAccess: true },
    { id: 'MEMBER', label: 'Member' },
  ],
  topRole: 'OWNER',
  defaultRole: 'MEMBER',
  modules: ['comments', 'votes'],
  csp: { imgSrc: ['https:'], connectSrc: ['https://openlibrary.org'] },
  owners: ['dash@example.com'],
};

const errorsFor = (overrides: Record<string, unknown>) => {
  const result = validateManifest({ ...valid, ...overrides });
  return result.ok ? [] : result.errors;
};

describe('validateManifest', () => {
  it('accepts a complete manifest', () => {
    expect(validateManifest(valid)).toEqual({ ok: true, manifest: valid });
  });

  it('accepts declared secrets and rejects bad names, duplicates and unknown fields', () => {
    expect(errorsFor({ secrets: [{ name: 'GOOGLE_BOOKS_API_KEY', description: 'Books', optional: true }] })).toEqual([]);
    expect(errorsFor({ secrets: [{ name: 'lower' }] })[0]).toMatch(/upper case/);
    expect(errorsFor({ secrets: [{ name: 'A_KEY' }, { name: 'A_KEY' }] })).toEqual(['secret "A_KEY" is listed twice']);
    expect(errorsFor({ secrets: [{ name: 'A_KEY', value: 'oops' }] })).toEqual(['secrets[0]: unknown field "value"']);
    expect(errorsFor({ secrets: 'A_KEY' })[0]).toMatch(/must be a list/);
  });

  it('knows the realtime module', () => {
    expect(errorsFor({ modules: ['realtime'] })).toEqual([]);
    expect(errorsFor({ modules: ['realtme'] })[0]).toMatch(/unknown module "realtme".*realtime/);
  });

  it('takes needsEmail as true or false only', () => {
    expect(errorsFor({ needsEmail: true })).toEqual([]);
    expect(errorsFor({ needsEmail: 'yes' })).toEqual(['"needsEmail" must be true or false']);
  });

  it('takes a list of known native capabilities, once each', () => {
    expect(errorsFor({ native: ['haptics', 'motion', 'screen'] })).toEqual([]);
    expect(errorsFor({ native: [] })).toEqual([]);
    expect(errorsFor({ native: 'motion' })).toEqual(['"native" must be a list of capabilities']);
    expect(errorsFor({ native: ['gyro'] })[0]).toMatch(/unknown native capability "gyro".*motion/);
    expect(errorsFor({ native: ['motion', 'motion'] })).toEqual(['"native" lists a capability twice']);
  });

  it('rejects bad and reserved slugs', () => {
    expect(errorsFor({ slug: 'Book Club' })[0]).toMatch(/slug/);
    expect(errorsFor({ slug: 'ab' })[0]).toMatch(/slug/);
    expect(errorsFor({ slug: 'auth' })[0]).toMatch(/reserved/);
  });

  it('requires topRole and defaultRole to be declared roles, and topRole to manage access', () => {
    expect(errorsFor({ topRole: 'BOSS' })).toContain('"topRole" must be one of the roles');
    expect(errorsFor({ topRole: 'MEMBER' })[0]).toMatch(/canManageAccess/);
    expect(errorsFor({ defaultRole: 'GUEST' })).toContain('"defaultRole" must be one of the roles');
  });

  it('requires public apps to have a default role that cannot approve', () => {
    expect(errorsFor({ visibility: 'public', defaultRole: undefined })[0]).toMatch(/defaultRole/);
    expect(errorsFor({ visibility: 'public', defaultRole: 'ADMIN' })[0]).toMatch(/approver/);
    expect(errorsFor({ visibility: 'public' })).toEqual([]);
  });

  describe('gameServer module', () => {
    it('needs realtime', () => {
      expect(errorsFor({ modules: ['realtime', 'gameServer'] })).toEqual([]);
      expect(errorsFor({ modules: ['gameServer'] })[0]).toMatch(/"gameServer" module needs "realtime"/);
    });

    it('takes limits within range and fills in the defaults', () => {
      const m = { modules: ['realtime', 'gameServer'], gameServer: { maxRooms: 2, maxPlayers: 16, idleMinutes: 1, maxHours: 0.25, warmMinutes: 15, cpu: 512, memory: 1024 } };
      expect(errorsFor(m)).toEqual([]);
      expect(gameServerSettings({})).toEqual({ maxRooms: 4, maxPlayers: 8, idleMinutes: 10, maxHours: 2, warmMinutes: 5, cpu: 256, memory: 512 });
      expect(gameServerSettings({ gameServer: { maxPlayers: 4 } })).toMatchObject({ maxPlayers: 4, maxRooms: 4 });
      // The lowest idle limit is fine with the default warm limit: a warm room holds the idle limit.
      expect(errorsFor({ modules: ['realtime', 'gameServer'], gameServer: { idleMinutes: 1 } })).toEqual([]);
      expect(gameServerSettings({ gameServer: { idleMinutes: 1 } })).toMatchObject({ idleMinutes: 1, warmMinutes: 5 });
      // A bigger CPU brings the least memory Fargate pairs with it.
      expect(gameServerSettings({ gameServer: { cpu: 1024 } })).toMatchObject({ cpu: 1024, memory: 2048 });
    });

    it.each([
      [{ maxRooms: 0 }, /maxRooms must be a whole number from 1 to 10/],
      [{ maxRooms: 11 }, /maxRooms/],
      [{ maxPlayers: 1 }, /maxPlayers must be a whole number from 2 to 16/],
      [{ maxPlayers: 17 }, /maxPlayers/],
      [{ maxPlayers: 2.5 }, /maxPlayers/],
      [{ idleMinutes: 0 }, /idleMinutes must be a whole number from 1 to 60/],
      [{ idleMinutes: 61 }, /idleMinutes/],
      [{ maxHours: 0.1 }, /maxHours must be a number from 0.25 to 4/],
      [{ maxHours: 5 }, /maxHours/],
      [{ warmMinutes: 1 }, /warmMinutes must be a whole number from 2 to 15/],
      [{ warmMinutes: 16 }, /warmMinutes must be a whole number from 2 to 15/],
      [{ cpu: 128 }, /cpu must be one of 256, 512, 1024/],
      [{ memory: 256 }, /memory must be one of 512, 1024, 2048/],
      [{ memory: 4096 }, /memory/],
      [{ cpu: 1024, memory: 512 }, /memory must be at least 2048 with cpu 1024/],
      [{ maxPlayers: '8' }, /maxPlayers/],
      [{ warmPool: 1 }, /unknown setting "warmPool"/],
    ])('rejects out-of-range limits: %j', (gameServer, message) => {
      const errors = errorsFor({ modules: ['realtime', 'gameServer'], gameServer });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(message);
    });

    it('rejects settings without the module', () => {
      expect(errorsFor({ modules: ['realtime'], gameServer: { maxRooms: 2 } })[0]).toMatch(/settings need "gameServer" in "modules"/);
      expect(errorsFor({ modules: ['realtime', 'gameServer'], gameServer: [] })[0]).toMatch(/must be an object/);
    });
  });

  it('rejects duplicate roles, unknown modules, unknown fields and unsafe CSP sources', () => {
    expect(errorsFor({ roles: [...valid.roles, { id: 'MEMBER', label: 'Again' }] })).toContain('role "MEMBER" is listed twice');
    expect(errorsFor({ modules: ['ai'] })[0]).toMatch(/unknown module "ai"/);
    expect(errorsFor({ colour: 'red' })).toContain('unknown field "colour"');
    expect(errorsFor({ accountMenu: 'floating' })).toContain('"accountMenu" must be "standard" or "custom"');
    expect(errorsFor({ csp: { scriptSrc: ["'unsafe-eval'"] } })[0]).toMatch(/not an allowed source/);
    expect(errorsFor({ csp: { scriptSrc: ['*'] } })[0]).toMatch(/not an allowed source/);
    expect(errorsFor({ csp: { scriptSrc: ['http://insecure.example'] } })[0]).toMatch(/not an allowed source/);
    expect(errorsFor({ csp: { objectSrc: ['https://x.example'] } })[0]).toMatch(/unknown directive/);
  });

  it('reports every problem at once', () => {
    const result = validateManifest({ slug: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(5);
  });
});

describe('helpers', () => {
  it('parseManifest throws one readable error', () => {
    expect(() => parseManifest({ ...valid, owners: [] }, 'apps/x/app.manifest.json')).toThrow(/apps\/x\/app.manifest.json is invalid:\n {2}- "owners"/);
  });

  it('canManageAccess follows the role definitions', () => {
    expect(canManageAccess(valid, 'ADMIN')).toBe(true);
    expect(canManageAccess(valid, 'MEMBER')).toBe(false);
    expect(canManageAccess(valid, undefined)).toBe(false);
  });
});
