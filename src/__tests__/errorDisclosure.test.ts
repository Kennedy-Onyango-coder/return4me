import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// P1 REGRESSION TEST — error disclosure. ~50 generic
// `catch (e: any) { res.status(500).json({ error: e.message }) }` blocks
// (plus a few variant-spelling duplicates) used to hand the caught
// exception's raw .message straight to the client — a Postgres constraint
// violation, a filesystem path, a raw third-party provider error body, or
// any other internal detail could reach an end user verbatim. Fixed via a
// shared sendServerError() helper: always logs the full error
// server-side, returns a generic safe message in production, still shows
// the real message in development for debugging convenience.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

describe('no route hands a raw caught-exception .message straight to the client', () => {
  it('sendServerError is defined and fails closed (generic message) in production', () => {
    const start = serverTs.indexOf('function sendServerError(');
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 800);
    expect(body).toMatch(/NODE_ENV === 'production'/);
    expect(body).toMatch(/console\.error/);
  });

  it('no remaining raw error.message leak exists anywhere in server.ts (excluding this fix\'s own explanatory comments)', () => {
    // Matches e.message, err.message, or an `|| String(e)` variant, but not
    // through the sendServerError wrapper. Checked line-by-line, skipping
    // comment lines, since sendServerError's own doc-comment quotes this
    // exact pattern as an example of what it replaced.
    const rawLeakPattern = /res\.status\(500\)\.json\(\{\s*error:\s*(e|err|error)\.message/;
    const codeLines = serverTs.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
    const matches = codeLines.filter(line => rawLeakPattern.test(line));
    expect(matches, `found raw leaks: ${JSON.stringify(matches)}`).toEqual([]);
  });

  it('sendServerError is used at least 40 times (the bulk of the original ~50 call sites)', () => {
    const matches = serverTs.match(/sendServerError\(res,/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(40);
  });
});

describe('sendCodeViaSms no longer embeds the raw provider error in its returned message', () => {
  const authTs = fs.readFileSync(path.resolve(__dirname, '../services/auth.ts'), 'utf8');

  it('the SMS-send catch block does not interpolate error.message into the returned message string', () => {
    const start = authTs.indexOf("[SMS ${label} GATEWAY ERROR]");
    expect(start).toBeGreaterThan(-1);
    const body = authTs.slice(start, start + 400);
    expect(body).not.toMatch(/message: `[^`]*\$\{error\.message/);
  });
});

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('sendCodeViaSms behavior (dev sandbox path, which does not touch the fixed catch block)', () => {
  it('returns success in the dev/sandbox simulation path regardless of the error-message fix', async () => {
    vi.resetModules();
    const { sendCodeViaSms } = await import('../services/auth');
    const result = await sendCodeViaSms('+254700000000', '1234', 'TEST', 'test message');
    expect(result.success).toBe(true);
  });
});
