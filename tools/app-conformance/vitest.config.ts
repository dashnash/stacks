import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Constants some apps' builds define (e.g. the footer's build link).
  define: { __BUILD_SHA__: '""', __BUILD_COMMIT_URL__: '""' },
  test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'], css: false, testTimeout: 20_000 },
});
