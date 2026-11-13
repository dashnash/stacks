import { defineConfig } from 'vitest/config';

// The first CDK synth in each test file takes 3-5 s, more while every workspace runs at once
// (`npm test` at the root), so the default 5 s timeout is too tight.
export default defineConfig({ test: { testTimeout: 30_000 } });
