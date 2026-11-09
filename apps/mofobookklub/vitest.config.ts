import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'api', include: ['tests/api/**/*.test.ts'], environment: 'node' } },
      {
        test: { name: 'web', include: ['tests/web/**/*.test.{ts,tsx}'], environment: 'jsdom', setupFiles: ['./tests/web/setup.ts'], css: false },
      },
    ],
  },
});
