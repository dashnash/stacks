/**
 * The app manifest (`apps/<slug>/app.manifest.json`): the one place an app declares who it is,
 * who can see it and which roles it has. CI, the CDK construct, the catalog, the access grid and
 * the SDK's role checks all read it through this package.
 */

export const MODULES = ['comments', 'votes', 'contentPacks', 'uploads', 'notifications', 'scheduledJobs', 'email', 'realtime', 'gameServer'] as const;
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
  /**
   * `standard` (default): the app puts <AccountMenu /> at the top right of its header.
   * `custom`: it draws its own from useAccountMenu(). Either way the conformance test checks it is there.
   */
  accountMenu?: 'standard' | 'custom';
  /**
   * Keys the app's server needs (third-party API keys and the like). Values never go in git or CI:
   * an admin stores each one in SSM Parameter Store at {@link secretParameterName}; the app reads
   * them with `appSecret(name)` from `@stacks/api/lambda`.
   */
  secrets?: AppSecret[];
  /**
   * The app is given people's email addresses (on `v.user`, members and the access page). Off by
   * default: apps get ids, display names and avatars only. Turning it on is a platform decision
   * (CI marks a PR that adds it for code-owner review). Hidden-email accounts give a relay address.
   */
  needsEmail?: boolean;
  /**
   * Limits for the `gameServer` module (all optional; see {@link GAME_SERVER_DEFAULTS}). Only
   * allowed with `gameServer` in `modules`.
   */
  gameServer?: Partial<GameServerSettings>;
  /** @deprecated Replaced by the account menu; accepted and ignored. */
  portalBar?: 'shown' | 'minimized' | 'off';
  /** Google emails of the people who own the app (the creator first). */
  owners: string[];
}

export interface AppSecret {
  /** Upper-case, e.g. "GOOGLE_BOOKS_API_KEY". */
  name: string;
  /** What it is and where to get it, for whoever sets it up. */
  description?: string;
  /** The app works without it (e.g. at a lower quota). Required secrets that are missing show on `/api/health`. */
  optional?: boolean;
}

/** The `gameServer` module's limits: its cost guard. */
export interface GameServerSettings {
  /** Rooms (Fargate tasks) the app may have running at once, 1-10. */
  maxRooms: number;
  /** Players per room, 2-16. */
  maxPlayers: number;
  /** A room ends after this many minutes with no input from anyone, 1-60. */
  idleMinutes: number;
  /** A room ends after this many hours whatever happens, 0.25-4. */
  maxHours: number;
  /** Fargate CPU units per room: 256 (0.25 vCPU), 512 or 1024. */
  cpu: number;
  /** Fargate memory per room in MiB, 512-2048 (1024 and up with cpu 512, 2048 and up with cpu 1024). */
  memory: number;
}

export const GAME_SERVER_DEFAULTS: GameServerSettings = { maxRooms: 4, maxPlayers: 8, idleMinutes: 10, maxHours: 2, cpu: 256, memory: 512 };

const GAME_SERVER_RANGES: Record<Exclude<keyof GameServerSettings, 'cpu' | 'memory'>, [number, number]> = {
  maxRooms: [1, 10],
  maxPlayers: [2, 16],
  idleMinutes: [1, 60],
  maxHours: [0.25, 4],
};
const GAME_SERVER_CPU = [256, 512, 1024];
/** The Fargate memory sizes from 512 to 2048 MiB. */
const GAME_SERVER_MEMORY = [512, 1024, 2048];
/** The least memory Fargate allows for each CPU size. */
const GAME_SERVER_MIN_MEMORY: Record<number, number> = { 256: 512, 512: 1024, 1024: 2048 };

/** The app's game server limits: the manifest's `gameServer` over the defaults. */
export function gameServerSettings(manifest: Pick<AppManifest, 'gameServer'>): GameServerSettings {
  const merged = { ...GAME_SERVER_DEFAULTS, ...manifest.gameServer };
  // A bigger CPU without a memory setting gets the least memory Fargate pairs with it.
  if (manifest.gameServer?.memory === undefined) merged.memory = Math.max(merged.memory, GAME_SERVER_MIN_MEMORY[merged.cpu] ?? 0);
  return merged;
}

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
export const MAX_SECRETS = 10;

/** Where an app's secret lives: outside `/stacks/<env>/apps/`, so the platform's registry never sees it. */
export function secretParameterName(envTag: 'prod' | 'test', slug: string, name: string): string {
  return `/stacks/${envTag}/secrets/${slug}/${name}`;
}

/** Subdomains the platform uses itself. */
// 'platform' too: /stacks/<env>/secrets/platform/ holds the platform's own secrets (the APNs key).
export const RESERVED_SLUGS = new Set(['auth', 'apps', 'api', 'www', 'portal', 'admin', 'static', 'test', 'mail', 'status', 'platform']);

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
    'defaultRole', 'publicRoutes', 'modules', 'csp', 'accountMenu', 'portalBar', 'owners', 'secrets', 'needsEmail', 'gameServer',
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
  const modules = Array.isArray(m.modules) ? (m.modules as unknown[]) : [];
  if (modules.includes('gameServer') && !modules.includes('realtime')) {
    errors.push('the "gameServer" module needs "realtime" too (players reach their game server through it): add "realtime" to "modules"');
  }
  if (m.gameServer !== undefined) {
    if (!isObject(m.gameServer)) errors.push('"gameServer" must be an object of limits, e.g. { "maxPlayers": 4 }');
    else {
      if (!modules.includes('gameServer')) errors.push('"gameServer" settings need "gameServer" in "modules"');
      const g = m.gameServer;
      for (const [key, value] of Object.entries(g)) {
        if (key === 'cpu') {
          if (!GAME_SERVER_CPU.includes(value as number)) errors.push(`gameServer.cpu must be one of ${GAME_SERVER_CPU.join(', ')}`);
        } else if (key === 'memory') {
          if (!GAME_SERVER_MEMORY.includes(value as number)) errors.push(`gameServer.memory must be one of ${GAME_SERVER_MEMORY.join(', ')} (MiB, 512 to 2048)`);
        } else if (key in GAME_SERVER_RANGES) {
          const [min, max] = GAME_SERVER_RANGES[key as keyof typeof GAME_SERVER_RANGES];
          const whole = key !== 'maxHours';
          if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) {
            errors.push(`gameServer.${key} must be ${whole ? 'a whole number' : 'a number'} from ${min} to ${max}`);
          }
        } else errors.push(`gameServer: unknown setting "${key}" (known: ${Object.keys(GAME_SERVER_DEFAULTS).join(', ')})`);
      }
      const cpu = typeof g.cpu === 'number' ? g.cpu : GAME_SERVER_DEFAULTS.cpu;
      const least = GAME_SERVER_MIN_MEMORY[cpu];
      if (least !== undefined && GAME_SERVER_MEMORY.includes(g.memory as number) && (g.memory as number) < least) errors.push(`gameServer.memory must be at least ${least} with cpu ${cpu} (a Fargate rule)`);
    }
  }
  if (m.secrets !== undefined) {
    if (!Array.isArray(m.secrets) || m.secrets.length > MAX_SECRETS) errors.push(`"secrets" must be a list of at most ${MAX_SECRETS}`);
    else {
      const seen = new Set<string>();
      m.secrets.forEach((s, i) => {
        if (!isObject(s) || typeof s.name !== 'string' || !SECRET_NAME.test(s.name)) {
          errors.push(`secrets[${i}] needs a "name" in upper case, e.g. "GOOGLE_BOOKS_API_KEY"`);
          return;
        }
        if (seen.has(s.name)) errors.push(`secret "${s.name}" is listed twice`);
        seen.add(s.name);
        for (const k of Object.keys(s)) if (!['name', 'description', 'optional'].includes(k)) errors.push(`secrets[${i}]: unknown field "${k}"`);
        if (s.description !== undefined && typeof s.description !== 'string') errors.push(`secrets[${i}].description must be a string`);
        if (s.optional !== undefined && typeof s.optional !== 'boolean') errors.push(`secrets[${i}].optional must be true or false`);
      });
    }
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
  if (m.accountMenu !== undefined && !['standard', 'custom'].includes(m.accountMenu as string)) {
    errors.push('"accountMenu" must be "standard" or "custom"');
  }
  if (m.needsEmail !== undefined && typeof m.needsEmail !== 'boolean') errors.push('"needsEmail" must be true or false');
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
