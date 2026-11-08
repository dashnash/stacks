import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold, type NewAppFlags } from './scaffold';

const USAGE = `Usage: npm run new-app -- <slug> [--name "Potluck"] [--tagline "…"] [--description "…"]
                       [--visibility public|private] [--owner you@gmail.com] [--no-install]

Uses apps/<slug>/app.manifest.json if the /new-app interview wrote one; otherwise makes a starting
manifest from the options (roles Owner and Member; --owner is then required).`;

const VALUE_FLAGS = new Set(['name', 'tagline', 'description', 'visibility', 'owner']);
const args = process.argv.slice(2);
const values: Record<string, string> = {};
const switches = new Set<string>();
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (!a.startsWith('--')) positional.push(a);
  else if (VALUE_FLAGS.has(a.slice(2))) values[a.slice(2)] = args[++i] ?? '';
  else switches.add(a.slice(2));
}
const slug = positional[0];
const flag = (name: string) => values[name];
if (!slug || switches.has('help')) {
  console.log(USAGE);
  process.exit(slug ? 0 : 1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const visibility = flag('visibility');
if (visibility && visibility !== 'public' && visibility !== 'private') {
  console.error('--visibility must be public or private');
  process.exit(1);
}
const flags: NewAppFlags = { name: flag('name'), tagline: flag('tagline'), description: flag('description'), visibility: visibility as NewAppFlags['visibility'], owner: flag('owner') };

try {
  const result = scaffold({ repoRoot, slug, flags });
  console.log(`Created apps/${slug}/ (${result.created.length} files${result.kept.length ? `; kept ${result.kept.join(', ')}` : ''}).`);
  if (!switches.has('no-install')) {
    // Registers the new workspace in package-lock.json (CI's npm ci needs it).
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: repoRoot, stdio: 'inherit' });
  }
  console.log(`
Next:
  npm test -w apps/${slug}          # starter tests, green before any feature work
  npm run demo -w apps/${slug}      # the in-browser demo, one persona per role
  Fill in apps/${slug}/BRIEF.md, then replace the starter notes feature (api/routes.ts, web/src/App.tsx).`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
