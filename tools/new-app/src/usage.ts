import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `npm run app-usage -- <slug> <step> [--tokens N] [--note "…"]` (spec: Token discipline). Appends
 * one entry to apps/<slug>/.stacks/usage.json at the end of each /new-app step: when, how long since
 * the previous entry, how many app files changed, and tokens if the session can tell.
 */
const steps = ['interview', 'scaffold', 'build', 'verify', 'stage', 'ship', 'change'];
const [slug, stepName, ...rest] = process.argv.slice(2);
if (!slug || !stepName || !steps.includes(stepName)) {
  console.error(`Usage: npm run app-usage -- <slug> <${steps.join('|')}> [--tokens N] [--note "…"]`);
  process.exit(1);
}
const opt = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const appDir = path.join(repoRoot, 'apps', slug);
if (!existsSync(appDir)) {
  console.error(`No apps/${slug}/`);
  process.exit(1);
}
const file = path.join(appDir, '.stacks/usage.json');
const log = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { entries: Record<string, unknown>[] }) : { entries: [] };
const now = new Date();
const previous = log.entries.at(-1)?.at as string | undefined;
let filesChanged: number | undefined;
try {
  filesChanged = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', `apps/${slug}`], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean).length;
} catch {
  // not a git checkout: leave it out
}
const tokens = opt('tokens') ? Number(opt('tokens')) : undefined;
log.entries.push({
  step: stepName,
  at: now.toISOString(),
  ...(previous ? { minutes: Math.round((now.getTime() - Date.parse(previous)) / 6000) / 10 } : {}),
  ...(filesChanged !== undefined ? { filesChanged } : {}),
  ...(tokens !== undefined && Number.isFinite(tokens) ? { tokens } : {}),
  ...(opt('note') ? { note: opt('note')!.slice(0, 300) } : {}),
});
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(log, null, 2)}\n`);
console.log(`Logged ${stepName} to apps/${slug}/.stacks/usage.json`);
