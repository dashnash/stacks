import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { RESERVED_SLUGS, validateManifest, type AppManifest } from '@stacks/manifest';

/**
 * The deterministic part of /new-app (spec: Creator workflow, step 2). It copies templates/app/
 * into apps/<slug>/, fills the few placeholders, and generates one demo persona per role. No
 * Claude tokens: the result typechecks and passes its tests before any feature work starts.
 */

export interface NewAppFlags {
  name?: string;
  tagline?: string;
  description?: string;
  visibility?: 'public' | 'private';
  owner?: string;
}

/** Files the interview may have written already; the scaffold keeps them. */
const KEEP = new Set(['app.manifest.json', 'BRIEF.md']);
/** Template files that describe the template itself, not the app. */
const SKIP = new Set(['README.md']);
const PERSONA_NAMES = ['Olive', 'Max', 'Priya', 'Sam', 'Lee', 'Jo', 'Ravi', 'Mei', 'Ana', 'Tom'];

const titleCase = (slug: string) => slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A starting manifest when the interview hasn't written one: Owner (approver) and Member. */
export function manifestFromFlags(slug: string, flags: NewAppFlags): AppManifest {
  if (!flags.owner) throw new Error('--owner <google email> is required when apps/<slug>/app.manifest.json does not exist yet');
  const name = flags.name ?? titleCase(slug);
  return {
    slug,
    name,
    tagline: flags.tagline ?? `${name}, on Stacks.`,
    description: flags.description ?? `${name}. Describe what it does in BRIEF.md.`,
    visibility: flags.visibility ?? 'private',
    roles: [
      { id: 'OWNER', label: 'Owner', canManageAccess: true, canManageApprovers: true },
      { id: 'MEMBER', label: 'Member' },
    ],
    topRole: 'OWNER',
    defaultRole: 'MEMBER',
    publicRoutes: ['/'],
    modules: [],
    accountMenu: 'standard',
    owners: [flags.owner.toLowerCase()],
  };
}

/** One demo persona per role, the top role first (the demo's "Sign in" uses the first). */
export function personasFor(manifest: AppManifest) {
  const roles = [...manifest.roles].sort((a, b) => Number(b.id === manifest.topRole) - Number(a.id === manifest.topRole));
  return roles.map((r, i) => {
    const name = PERSONA_NAMES[i % PERSONA_NAMES.length]! + (i >= PERSONA_NAMES.length ? ` ${Math.floor(i / PERSONA_NAMES.length) + 1}` : '');
    return {
      email: `${name.toLowerCase().replace(/\s+/g, '')}@demo.stacks`,
      name,
      role: r.id,
      blurb: r.canManageAccess ? `${r.label} (manages access)` : r.label,
    };
  });
}

/** The personas as a TypeScript array literal, one per line. */
function personasSource(manifest: AppManifest): string {
  const lines = personasFor(manifest).map((p) => `  { ${Object.entries(p).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')} },`);
  return `[\n${lines.join('\n')}\n]`;
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = path.join(dir, f);
    if (f === 'node_modules' || f.startsWith('dist')) return [];
    return statSync(full).isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  });
}

export interface ScaffoldResult {
  dir: string;
  manifest: AppManifest;
  created: string[];
  kept: string[];
}

export function scaffold(opts: { repoRoot: string; slug: string; flags?: NewAppFlags }): ScaffoldResult {
  const { repoRoot, slug } = opts;
  if (RESERVED_SLUGS.has(slug)) throw new Error(`"${slug}" is reserved by the platform`);
  const dir = path.join(repoRoot, 'apps', slug);
  const templateDir = path.join(repoRoot, 'templates', 'app');
  const manifestFile = path.join(dir, 'app.manifest.json');

  if (existsSync(dir)) {
    const extra = listFiles(dir).filter((f) => !KEEP.has(f));
    if (extra.length) throw new Error(`apps/${slug} already has files (${extra.slice(0, 3).join(', ')}${extra.length > 3 ? ', …' : ''}); the scaffold only fills a new app`);
  }

  // The manifest: the interview's, or a starting one from flags.
  let manifest: AppManifest;
  const kept: string[] = [];
  if (existsSync(manifestFile)) {
    const result = validateManifest(JSON.parse(readFileSync(manifestFile, 'utf8')));
    if (!result.ok) throw new Error(`apps/${slug}/app.manifest.json:\n  - ${result.errors.join('\n  - ')}`);
    if (result.manifest.slug !== slug) throw new Error(`apps/${slug}/app.manifest.json has slug "${result.manifest.slug}"; the folder and slug must match`);
    manifest = result.manifest;
    kept.push('app.manifest.json');
  } else {
    manifest = manifestFromFlags(slug, opts.flags ?? {});
    const result = validateManifest(manifest);
    if (!result.ok) throw new Error(`The manifest from those options is not valid:\n  - ${result.errors.join('\n  - ')}`);
  }

  const fill = (text: string, file: string) =>
    text
      .replaceAll('__SLUG__', slug)
      .replaceAll('__TITLE__', file.endsWith('.html') ? escapeHtml(manifest.name) : manifest.name)
      .replace('/*__PERSONAS__*/ []', personasSource(manifest));

  const created: string[] = [];
  mkdirSync(dir, { recursive: true });
  if (!kept.includes('app.manifest.json')) {
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    created.push('app.manifest.json');
  }
  for (const file of listFiles(templateDir).filter((f) => !SKIP.has(f))) {
    const target = path.join(dir, file);
    if (KEEP.has(file) && existsSync(target)) {
      kept.push(file);
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, fill(readFileSync(path.join(templateDir, file), 'utf8'), file));
    created.push(file);
  }
  return { dir, manifest, created: created.sort(), kept };
}
