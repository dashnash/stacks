import { defineConfig } from 'vitest/config';
import { buildDefines } from './build-info';

export default defineConfig({ define: buildDefines(), test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'] } });
