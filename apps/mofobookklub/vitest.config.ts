import { defineConfig } from 'vitest/config';
import { buildDefines } from './web/build-info';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'api', include: ['tests/api/**/*.test.ts'], environment: 'node' } },
      {
        define: buildDefines(),
        test: { name: 'web', include: ['tests/web/**/*.test.{ts,tsx}'], environment: 'jsdom', setupFiles: ['./tests/web/setup.ts'], css: false },
      },
    ],
  },
});
