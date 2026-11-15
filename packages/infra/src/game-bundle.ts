/**
 * How a game server reaches Fargate (the `gameServer` module): there is no image of the app's own.
 * Every room runs the official Node image, pinned below, and its start command fetches the app's
 * game (one bundled file: the `@stacks/game-server` runtime plus `apps/<slug>/game/server.ts`)
 * from S3 through a short-lived link the API passes when it starts the task. The bundle is an
 * ordinary CDK file asset, like a Lambda's code: built at synth, uploaded only when it changes.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';

/**
 * The image every game server runs: official Node 22 (Debian bookworm, slim) from ECR Public,
 * pinned to the multi-architecture index digest (Fargate picks the arm64 image from it). Fargate
 * pulls it from inside AWS; nothing goes through CI. Moving Node on is a deliberate change here:
 * look up the new digest of `public.ecr.aws/docker/library/node:22-bookworm-slim`.
 */
export const GAME_SERVER_IMAGE = 'public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee';

/** The environment variable carrying the signed link to the bundle (set by the API at RunTask). */
export const GAME_BUNDLE_URL_ENV = 'STACKS_GAME_BUNDLE_URL';

/**
 * The container's start script (`node -e`): fetch the bundle (a few tries, it is a file in S3
 * of this region), write it to /tmp and run it. Anything else fails the task, which the API's
 * sweeper then sees as a room whose server is gone.
 */
export const GAME_BOOTSTRAP_SCRIPT = [
  `const url = process.env.${GAME_BUNDLE_URL_ENV};`,
  `if (!url) { console.error('No ${GAME_BUNDLE_URL_ENV}: start game servers through the API'); process.exit(1); }`,
  '(async () => {',
  '  for (let attempt = 1; ; attempt++) {',
  '    try {',
  '      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });',
  "      if (!res.ok) throw new Error('HTTP ' + res.status);",
  "      require('node:fs').writeFileSync('/tmp/server.mjs', Buffer.from(await res.arrayBuffer()));",
  '      break;',
  '    } catch (err) {',
  "      if (attempt >= 4) { console.error('Could not fetch the game bundle', err); process.exit(1); }",
  '      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));',
  '    }',
  '  }',
  "  await import('/tmp/server.mjs');",
  '})();',
].join('\n');

/** The container command: Node with source maps, running {@link GAME_BOOTSTRAP_SCRIPT}. */
export const gameBootstrapCommand = (): string[] => ['node', '--enable-source-maps', '-e', GAME_BOOTSTRAP_SCRIPT];

/**
 * Bundle one app's game server into a single ES module at `outfile`: `game/server.ts` (its default
 * export is the `defineGame`) started by `runGameServer`. Deterministic for the same sources, so
 * an unchanged game keeps its asset hash and is not uploaded again. The source map is inline
 * (stack traces in the logs point at the app's code) without the sources themselves, to stay small.
 */
export function bundleGameServer(opts: { repoRoot: string; appDir: string; outfile: string }): void {
  const entry = path.join(opts.appDir, 'game/server.ts');
  try {
    readFileSync(entry);
  } catch {
    throw new Error(`${path.relative(opts.repoRoot, opts.appDir)} has the gameServer module but no game/server.ts (export default defineGame({ … }))`);
  }
  buildSync({
    stdin: {
      contents: `import game from ${JSON.stringify(entry)};\nimport { runGameServer } from '@stacks/game-server/node';\nvoid runGameServer(game);\n`,
      resolveDir: path.join(opts.repoRoot, 'packages/game-server'),
      sourcefile: 'game-server-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: 'inline',
    sourcesContent: false,
    outfile: opts.outfile,
    // Some dependencies are CommonJS and call require().
    banner: { js: "import { createRequire as __stacksCreateRequire } from 'node:module';\nconst require = __stacksCreateRequire(import.meta.url);" },
    logLevel: 'warning',
  });
}
