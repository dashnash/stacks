#!/usr/bin/env node
/**
 * Builds the game server image of every app with the `gameServer` module (or of the apps named):
 *
 *   node scripts/build-game-images.mjs [slug ...] [--bundle-only]
 *
 * For each app: bundle `apps/<slug>/game/server.ts` with the `@stacks/game-server` runtime into
 * `apps/<slug>/game/dist/server.mjs` (esbuild), build `packages/game-server/Dockerfile` for
 * linux/arm64 and save it as `apps/<slug>/game/dist/image.tar`, which `cdk synth` hands to CDK as
 * a tarball asset. This runs in the credential-free build jobs; deploy jobs only load and push
 * the tarball. `--bundle-only` skips Docker (to check that a game bundles, e.g. in a session).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const bundleOnly = args.includes('--bundle-only');
const named = args.filter((a) => !a.startsWith('--'));
for (const slug of named) if (!/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(slug)) throw new Error(`"${slug}" is not an app slug`);

const appsDir = path.join(root, 'apps');
const apps = readdirSync(appsDir).filter((slug) => {
  const manifest = path.join(appsDir, slug, 'app.manifest.json');
  if (!existsSync(manifest)) return false;
  if (named.length && !named.includes(slug)) return false;
  return (JSON.parse(readFileSync(manifest, 'utf8')).modules ?? []).includes('gameServer');
});
for (const slug of named) if (!apps.includes(slug)) console.log(`${slug}: no gameServer module, nothing to build`);

for (const slug of apps) {
  const entry = path.join(appsDir, slug, 'game/server.ts');
  if (!existsSync(entry)) throw new Error(`apps/${slug} has the gameServer module but no game/server.ts (export default defineGame({ … }))`);
  const dist = path.join(appsDir, slug, 'game/dist');
  mkdirSync(dist, { recursive: true });
  await build({
    stdin: {
      contents: `import game from ${JSON.stringify(entry)};\nimport { runGameServer } from '@stacks/game-server/node';\nvoid runGameServer(game);\n`,
      resolveDir: path.join(root, 'packages/game-server'),
      sourcefile: 'entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    outfile: path.join(dist, 'server.mjs'),
    // Some dependencies are CommonJS and call require().
    banner: { js: "import { createRequire as __stacksCreateRequire } from 'node:module';\nconst require = __stacksCreateRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  console.log(`${slug}: bundled game/dist/server.mjs (${Math.round(statSync(path.join(dist, 'server.mjs')).size / 1024)} KB)`);
  if (bundleOnly) continue;

  const tag = `stacks-game-${slug}:build`;
  const tarball = path.join(dist, 'image.tar');
  const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { stdio: 'inherit' });
  run('docker', ['buildx', 'build', '--platform', 'linux/arm64', '--provenance=false', '-f', path.join(root, 'packages/game-server/Dockerfile'), '-t', tag, '--load', dist]);
  run('docker', ['save', tag, '-o', tarball]);
  console.log(`${slug}: saved game/dist/image.tar (${Math.round(statSync(tarball).size / 1_048_576)} MB)`);
}
