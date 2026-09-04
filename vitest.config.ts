import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Runs before any test file's module graph is imported, so third-party
    // provider credentials are neutralised BEFORE services/auth.ts (and the
    // other modules that call dotenv.config() at import time) initialise
    // their SDK clients. Without this, running the suite on a machine with a
    // populated .env dispatches REAL SMS via Africa's Talking — observed
    // during the production audit. See the file itself for the full detail.
    setupFiles: ['./src/__tests__/setup.testEnv.ts'],
    // Vitest's default per-test timeout is 5000ms. That is not enough for
    // this suite's slowest-but-legitimate pattern: several security tests
    // deliberately call `vi.resetModules()` and then `await import(...)` a
    // module in order to re-evaluate its import-time configuration under a
    // different NODE_ENV (e.g. "postToTelegram must fail closed in
    // production with missing credentials", "sendCodeViaSms takes the
    // simulation branch"). That dynamic import is a COLD import of a large
    // graph — services/social.ts and services/auth.ts both pull in
    // db/database.ts (~3.3k lines) and db/index.ts.
    //
    // Measured on a full run: total import time 91.33s across 40 files
    // running in parallel, with one such test taking 4778ms while still
    // PASSING — i.e. already within ~200ms of the default limit. Under that
    // contention three tests tipped over and failed with
    // "Test timed out in 5000ms" — even though all three pass when their
    // file is run on its own. The failures were pure scheduling luck, not
    // assertion failures: a green/red result that changed depending on how
    // busy the other workers were.
    //
    // This raises the ceiling so a slow cold import cannot masquerade as a
    // failed security assertion. It does NOT weaken any assertion — a test
    // that genuinely hangs still fails, just after 30s instead of 5s. The
    // alternative (per-test timeout arguments) would mean annotating each
    // affected test and re-annotating every future one that hits the same
    // import cost, and would leave the underlying flakiness in place.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
