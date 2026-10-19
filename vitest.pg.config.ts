import { defineConfig } from 'vitest/config';
import path from 'path';

// F9 — PostgreSQL integration tests are a SEPARATE, opt-in run.
//
// The default `vitest.config.ts` includes only `src/**/*.test.ts`, so this
// suite never runs as part of `npm test`. It requires an explicitly disposable
// LOCAL database supplied as R4M_PG_TEST_DATABASE_URL; the suite itself refuses
// any other target (see the guard at the top of the integration file).
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.integration.ts'],
    setupFiles: ['./src/__tests__/setup.testEnv.ts'],
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
