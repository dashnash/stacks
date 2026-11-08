import { defineConfig } from 'vitest/config';

// The end-to-end test scaffolds a real app and runs its typecheck and tests.
export default defineConfig({ test: { testTimeout: 240_000, hookTimeout: 240_000 } });
