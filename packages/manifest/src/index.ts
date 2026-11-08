/**
 * The app manifest (`apps/<slug>/app.manifest.json`): the one place an app declares who it is,
 * who can see it and which roles it has. CI, the CDK construct, the catalog, the access grid and
 * the SDK's role checks all read it through this package.
 */

export const MODULES = ['comments', 'votes', 'contentPacks', 'uploads', 'notifications', 'scheduledJobs', 'email'] as const;
export type ModuleName = (typeof MODULES)[number];

export const CSP_DIRECTIVES = ['imgSrc', 'connectSrc', 'scriptSrc', 'styleSrc', 'fontSrc', 'frameSrc', 'mediaSrc'] as const;
export type CspDirective = (typeof CSP_DIRECTIVES)[number];

export interface RoleDef {
  /** Stored on grants and checked in code, e.g. `ADMIN`. Upper case, digits and `_`. */
  id: string;
  /** Shown in the access grid and the app's own admin page. */
  label: string;
  /** Holders can approve requests and set other users' roles for this app. */
  canManageAccess?: boolean;
  /** Holders can also grant or remove roles that `canManageAccess` (normally only the top role). */
  canManageApprovers?: boolean;
}

export interface AppManifest {
  /** Subdomain and stack name (`app-<slug>`). Immutable once deployed. */
  slug: string;
  name: string;
  tagline: string;
  description: string;
  /** File in the app folder shown in the catalog, e.g. `icon.svg`. */
  icon?: string;
  category?: string;
  /** Public apps grant `defaultRole` to any signed-in user; private apps need approval. */
  visibility: 'public' | 'private';
  roles: RoleDef[];
  /** Given to the creator on first registration; an app always keeps at least one holder. */
  topRole: string;
  /** Required for public apps; pre-selected when approving a request on private ones. */
  defaultRole?: string;
  /** SPA routes that render without signing in (documentation for the catalog and tests). */
  publicRoutes?: string[];
  modules?: ModuleName[];
  /** Additions to the platform's default Content-Security-Policy. */
  csp?: Partial<Record<CspDirective, string[]>>;
  portalBar?: 'shown' | 'minimized' | 'off';
  /** Google emails of the people who own the app (the creator first). */
  owners: string[];
}

/** Subdomains the platform uses itself. */
export const RESERVED_SLUGS = new Set(['auth', 'apps', 'api', 'www', 'portal', 'admin', 'static', 'test', 'mail', 'status']);

const SLUG = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
const ROLE_ID = /^[A-Z][A-Z0-9_]{0,31}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A CSP source an app may add: an https origin (optionally `*.` wildcard host), or the schemes `https:`, `data:`, `blob:`. */
const CSP_SOURCE = /^(https:|data:|blob:|https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/[^\s;']*)?)$/;
const MAX_CSP_SOURCES = 10;

export type ValidationResult = { ok: true; manifest: AppManifest } | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Check a parsed manifest, returning every problem at once so a creator can fix them in one pass. */
export function validateManifest(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['manifest must be a JSON object'] };
  const m = input;

  const known = new Set([
    '$schema', 'slug', 'name', 'tagline', 'description', 'icon', 'category', 'visibility', 'roles', 'topRole',
    'defaultRole', 'publicRoutes', 'modules', 'csp', 'portalBar', 'owners',
  ]);
  for (const key of Object.keys(m)) if (!known.has(key)) errors.push(`unknown field "${key}"`);

  if (!isString(m.slug) || !SLUG.test(m.slug)) {
    errors.push('"slug" must be 3-30 characters: lowercase letters, digits and "-", starting with a letter');
  } else if (RESERVED_SLUGS.has(m.slug)) {
    errors.push(`"slug" "${m.slug}" is reserved by the platform`);
  }
  for (const field of ['name', 'tagline', 'description'] as const) {
    if (!isString(m[field])) errors.push(`"${field}" is required`);
  }
  if (isString(m.name) && m.name.length > 40) errors.push('"name" must be at most 40 characters');
  if (isString(m.tagline) && m.tagline.length > 80) errors.push('"tagline" must be at most 80 characters');
  for (const field of ['icon', 'category'] as const) {
    if (m[field] !== undefined && !isString(m[field])) errors.push(`"${field}" must be a string`);
  }
  if (m.visibility !== 'public' && m.visibility !== 'private') errors.push('"visibility" must be "public" or "private"');

  const roles: RoleDef[] = [];
  if (!Array.isArray(m.roles) || m.roles.length === 0) {
    errors.push('"roles" must list at least one role');
  } else {
    const seen = new Set<string>();
    m.roles.forEach((r, i) => {
      if (!isObject(r) || !isString(r.id) || !ROLE_ID.test(r.id) || !isString(r.label)) {
        errors.push(`roles[${i}] needs an "id" (e.g. "MEMBER") and a "label"`);
        return;
      }
      if (seen.has(r.id)) errors.push(`role "${r.id}" is listed twice`);
      seen.add(r.id);
      roles.push(r as unknown as RoleDef);
    });
  }
  const role = (id: unknown) => roles.find((r) => r.id === id);

  if (!role(m.topRole)) {
    errors.push('"topRole" must be one of the roles');
  } else if (!role(m.topRole)!.canManageAccess) {
    errors.push('"topRole" must have canManageAccess, so someone can always approve requests');
  }
  if (m.defaultRole !== undefined && !role(m.defaultRole)) errors.push('"defaultRole" must be one of the roles');
  if (m.visibility === 'public') {
    if (m.defaultRole === undefined) errors.push('public apps need a "defaultRole" to give new users');
    else if (role(m.defaultRole)?.canManageAccess) {
      errors.push('a public app\'s "defaultRole" cannot manage access (anyone signing in would become an approver)');
    }
  }

  if (m.publicRoutes !== undefined && (!Array.isArray(m.publicRoutes) || !m.publicRoutes.every((r) => isString(r) && r.startsWith('/')))) {
    errors.push('"publicRoutes" must be a list of paths starting with "/"');
  }
  if (m.modules !== undefined) {
    if (!Array.isArray(m.modules)) errors.push('"modules" must be a list');
    else for (const mod of m.modules) if (!MODULES.includes(mod as ModuleName)) errors.push(`unknown module "${String(mod)}" (known: ${MODULES.join(', ')})`);
  }
  if (m.csp !== undefined) {
    if (!isObject(m.csp)) errors.push('"csp" must be an object');
    else {
      for (const [directive, sources] of Object.entries(m.csp)) {
        if (!CSP_DIRECTIVES.includes(directive as CspDirective)) {
          errors.push(`csp: unknown directive "${directive}" (allowed: ${CSP_DIRECTIVES.join(', ')})`);
          continue;
        }
        if (!Array.isArray(sources) || sources.length > MAX_CSP_SOURCES) {
          errors.push(`csp.${directive} must be a list of at most ${MAX_CSP_SOURCES} sources`);
          continue;
        }
        for (const s of sources) {
          if (typeof s !== 'string' || !CSP_SOURCE.test(s)) errors.push(`csp.${directive}: "${String(s)}" is not an allowed source (use https origins)`);
        }
      }
    }
  }
  if (m.portalBar !== undefined && !['shown', 'minimized', 'off'].includes(m.portalBar as string)) {
    errors.push('"portalBar" must be "shown", "minimized" or "off"');
  }
  if (!Array.isArray(m.owners) || m.owners.length === 0 || !m.owners.every((e) => isString(e) && EMAIL.test(e))) {
    errors.push('"owners" must list at least one email address');
  }

  return errors.length ? { ok: false, errors } : { ok: true, manifest: input as unknown as AppManifest };
}

/** Validate or throw one error listing every problem. */
export function parseManifest(input: unknown, source = 'app.manifest.json'): AppManifest {
  const result = validateManifest(input);
  if (!result.ok) throw new Error(`${source} is invalid:\n  - ${result.errors.join('\n  - ')}`);
  return result.manifest;
}

export function roleDef(manifest: AppManifest, id: string): RoleDef | undefined {
  return manifest.roles.find((r) => r.id === id);
}

/** Can someone with `role` approve requests and set roles in this app? */
export function canManageAccess(manifest: AppManifest, role: string | undefined): boolean {
  return !!role && !!roleDef(manifest, role)?.canManageAccess;
}

export function hasModule(manifest: AppManifest, module: ModuleName): boolean {
  return manifest.modules?.includes(module) ?? false;
}
