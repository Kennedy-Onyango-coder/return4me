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

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('production database fail-closed guarantee', () => {
  it('throws at import time when DATABASE_URL is missing in production', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    // Set to EMPTY STRING rather than `delete`: db/index.ts calls
    // dotenv.config() at import time, and dotenv does not override variables
    // that already exist in process.env — but it WOULD re-populate a deleted
    // one from a developer's local .env file, silently defeating this test
    // whenever one was present. An empty string still counts as "missing" to
    // the fail-closed guard (dbUrl = process.env.DATABASE_URL || '').
    process.env.DATABASE_URL = '';

    await expect(import('../index')).rejects.toThrow(/DATABASE_URL/i);
  });

  it('throws at import time when DATABASE_URL is still the example placeholder in production', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://user:password@host/dbname?sslmode=require';

    await expect(import('../index')).rejects.toThrow(/DATABASE_URL/i);
  });

  it('does NOT throw in development even with a missing/placeholder DATABASE_URL (mock mode is a dev-only convenience)', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;

    await expect(import('../index')).resolves.toBeDefined();
  });
});
