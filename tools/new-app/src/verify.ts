import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `npm run verify-app -- <slug>` (spec: Creator workflow, step 4). Runs every check an app must pass
 * before it is staged, then screenshots the demo as each persona (and signed out) on desktop and
 * phone, so Claude and the creator can review the UI. Exit code 1 if any check fails.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const slug = process.argv[2];
if (!slug || !/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(slug)) {
  console.error('Usage: npm run verify-app -- <slug> [--no-screenshots]');
  process.exit(1);
}
const appDir = path.join(repoRoot, 'apps', slug);
if (!existsSync(path.join(appDir, 'app.manifest.json'))) {
  console.error(`No apps/${slug}/app.manifest.json`);
  process.exit(1);
}

type Result = { step: string; ok: boolean | 'skipped'; detail?: string };
const results: Result[] = [];
const env = { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };

function step(name: string, cmd: string, args: string[], cwd = appDir): boolean {
  process.stdout.write(`• ${name} … `);
  try {
    execFileSync(cmd, args, { cwd, env, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    console.log('ok');
    results.push({ step: name, ok: true });
    return true;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    // The tail of the output is where the failure is; keep it short for the session's context.
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
    console.log('FAILED');
    console.log(out.replace(/^/gm, '    '));
    results.push({ step: name, ok: false, detail: out });
    return false;
  }
}

/** Files changed outside apps/<slug>/ on this branch: an app task may not touch them. */
function outsideChanges(): string[] {
  try {
    const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }).trim();
    const tracked = execFileSync('git', ['diff', '--name-only', base], { cwd: repoRoot, encoding: 'utf8' }).split('\n');
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' }).split('\n');
    return [...tracked, ...untracked].filter((f) => f && !f.startsWith(`apps/${slug}/`) && f !== 'package-lock.json');
  } catch {
    return [];
  }
}

function serve(dir: string): Promise<{ server: Server; url: string }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2' };
  const server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]!).replace(/^\/+/, '') || 'demo.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

/** The bits of Playwright used here. It is optional: cloud sessions have it; elsewhere screenshots are skipped. */
interface Page {
  on(event: 'pageerror', fn: (e: Error) => void): void;
  on(event: 'console', fn: (m: { type(): string; text(): string }) => void): void;
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, opts: { timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  screenshot(opts: { path: string; fullPage: boolean }): Promise<unknown>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(): Promise<{ newPage(opts: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<Page>; close(): Promise<void> }> };
}

async function screenshots(): Promise<void> {
  if (process.argv.includes('--no-screenshots')) return void results.push({ step: 'screenshots', ok: 'skipped', detail: '--no-screenshots' });
  let playwright: Playwright;
  try {
    // Not a dependency: resolved at run time (require honours NODE_PATH, where machines with a
    // shared Playwright install keep it).
    playwright = createRequire(import.meta.url)('playwright') as Playwright;
  } catch {
    results.push({ step: 'screenshots', ok: 'skipped', detail: 'Playwright is not installed here (npm i -D playwright && npx playwright install chromium)' });
    return console.log('• screenshots … skipped (no Playwright)');
  }
  process.stdout.write('• screenshots … ');
  const { personas } = (await import(pathToFileURL(path.join(appDir, 'api/demo-data.ts')).href)) as { personas: { email: string; name: string; role: string }[] };
  // Inner pages the app asks for (web/src/demo/pages.ts), shot signed in.
  const pagesFile = path.join(appDir, 'web/src/demo/pages.ts');
  const extraPages = existsSync(pagesFile)
    ? ((await import(pathToFileURL(pagesFile).href)) as { screenshotPages?: { name: string; hash: string; as?: string[] }[] }).screenshotPages ?? []
    : [];
  const outDir = path.join(appDir, '.stacks/screenshots');
  mkdirSync(outDir, { recursive: true });
  const { server, url } = await serve(path.join(appDir, 'web/dist-demo'));
  const browser = await playwright.chromium.launch();
  const problems: string[] = [];
  const shots: string[] = [];
  try {
    const personaId = (p: { role: string; name: string }) => `${p.role.toLowerCase()}-${p.name.toLowerCase()}`;
    const who: { id: string; as: string | null; hash: string }[] = [
      { id: 'signed-out', as: null, hash: '' },
      ...personas.map((p) => ({ id: personaId(p), as: p.email, hash: '' })),
      ...extraPages.flatMap((page) =>
        personas.filter((p) => !page.as || page.as.includes(p.email)).map((p) => ({ id: `${page.name}-${personaId(p)}`, as: p.email, hash: page.hash.startsWith('#') ? page.hash : `#${page.hash}` })),
      ),
    ];
    for (const viewport of [{ id: 'desktop', width: 1280, height: 800 }, { id: 'phone', width: 390, height: 844 }]) {
      for (const w of who) {
        const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
        page.on('pageerror', (e) => problems.push(`${w.id}/${viewport.id}: ${e.message}`));
        page.on('console', (m) => m.type() === 'error' && problems.push(`${w.id}/${viewport.id}: console: ${m.text()}`));
        await page.goto(`${url}/demo.html${w.as ? `?as=${encodeURIComponent(w.as)}` : ''}${w.hash}`);
        await page.waitForSelector(w.as ? '[data-stacks-account-menu="signedIn"]' : '[data-stacks-account-menu="signedOut"]', { timeout: 15_000 }).catch(() => problems.push(`${w.id}/${viewport.id}: the account menu never showed the expected state`));
        await page.waitForTimeout(400);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        if (overflow) problems.push(`${w.id}/${viewport.id}: the page scrolls sideways (something is wider than the screen)`);
        const file = path.join(outDir, `${w.id}-${viewport.id}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(path.relative(repoRoot, file));
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(problems.length ? 'PROBLEMS' : 'ok');
  for (const p of problems) console.log(`    ${p}`);
  console.log(shots.map((s) => `    ${s}`).join('\n'));
  results.push({ step: 'screenshots', ok: problems.length === 0, detail: problems.join('\n') });
}

console.log(`Verifying apps/${slug}\n`);
step('typecheck', 'npx', ['tsc', '-p', 'tsconfig.json']);
step('app tests', 'npx', ['vitest', 'run']);
step('platform conformance (account menu, demo setup)', 'npx', ['vitest', 'run', '-t', slug], path.join(repoRoot, 'tools/app-conformance'));
step('import rule', 'node', ['scripts/check-imports.mjs'], repoRoot);
const outside = outsideChanges();
results.push({ step: 'only apps/<slug>/ changed', ok: outside.length === 0, detail: outside.join('\n') });
console.log(`• only apps/${slug}/ changed … ${outside.length ? `NO:\n${outside.map((f) => `    ${f}`).join('\n')}` : 'ok'}`);
const built = step('build (app)', 'npx', ['vite', 'build', '--config', 'web/vite.config.ts']) && step('build (demo)', 'npx', ['vite', 'build', '--config', 'web/vite.demo.config.ts']);
if (built) await screenshots();

const failed = results.filter((r) => r.ok === false);
console.log(`\n${failed.length ? `${failed.length} check(s) failed: ${failed.map((f) => f.step).join(', ')}` : 'All checks passed.'}`);
process.exit(failed.length ? 1 : 0);
