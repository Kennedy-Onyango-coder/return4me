import { describe, it, expect, afterEach, vi } from 'vitest';

// This pins down the single most consequence-heavy fix in this pass: a
// production deployment with a missing or still-placeholder DATABASE_URL
// must crash at startup, not silently accept found-item reports, claims,
// and payments into an in-memory database that's wiped on every restart
// while every API response looks completely normal. Runs each case in its
// own dynamic import + vi.resetModules() so the module's top-level
// createPool() side effect actually re-executes per test — a plain static
// import would only ever run that code once, for whichever env was active
// first.
//
// dotenv is mocked out entirely: on a real developer/production machine a
// .env file exists, and the module under test (src/db/index.ts) calls
// dotenv.config() at the top level, which would re-populate
// process.env.DATABASE_URL (and every other secret) from disk. That would
// mask the exact fail-closed scenarios these tests exist to pin down — a
// "missing" DATABASE_URL would silently be replaced by the real one and the
// module would boot normally instead of throwing. With dotenv a no-op, the
// tests are fully hermetic: the only DATABASE_URL in play is the one the
// test itself sets.

vi.mock('dotenv', () => ({
  default: { config: vi.fn() },
}));

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

// Cold dynamic imports pull in the full module graph (Sentry, pg, Drizzle,
// @sentry/node, etc.), which can take well over the default 5s vitest
// timeout on slower machines — give the import-time assertions real room.
const DYNAMIC_IMPORT_TIMEOUT_MS = 30_000;

describe('production database fail-closed guarantee', () => {
  it('throws at import time when DATABASE_URL is missing in production', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;

    await expect(import('../index')).rejects.toThrow(/DATABASE_URL/i);
  }, DYNAMIC_IMPORT_TIMEOUT_MS);

  it('throws at import time when DATABASE_URL is still the example placeholder in production', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://user:password@host/dbname?sslmode=require';

    await expect(import('../index')).rejects.toThrow(/DATABASE_URL/i);
  }, DYNAMIC_IMPORT_TIMEOUT_MS);

  it('does NOT throw in development even with a missing/placeholder DATABASE_URL (mock mode is a dev-only convenience)', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;

    await expect(import('../index')).resolves.toBeDefined();
  }, DYNAMIC_IMPORT_TIMEOUT_MS);
});