import { describe, expect, it } from 'vitest';
import { canManageAccess, parseManifest, validateManifest, type AppManifest } from '../src/index';

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
