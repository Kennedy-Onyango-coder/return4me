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

// =============================================================================
// PHASE 12 — GAP CLOSED IN THE TRIPWIRE ABOVE
// =============================================================================
// The single-line tripwire at the top of this file only matched the shape
//   res.status(500).json({ error: (e|err|error).message
// so it could not see a raw message echoed from a MULTI-LINE response object.
// A real instance of that shape was found and fixed in Phase 12:
// GET /api/health's database-unreachable branch answered 503 with
// `error: err.message || String(err)`, and the measured pg message for that
// path is "connect ECONNREFUSED 127.0.0.1:5599" — i.e. host and port, on an
// endpoint that is unauthenticated and exempt from the global limiter. Other pg
// failure modes name the user, the database, or an internal hostname.
// The assertions below make that shape impossible to reintroduce.
// =============================================================================

/** The original, single-line-only pattern (kept to document its blind spot). */
const SINGLE_LINE_LEAK_RE = /res\.status\(500\)\.json\(\{\s*error:\s*(e|err|error)\.message/;

/**
 * A response body field whose value is a CAUGHT error's message. Deliberately
 * narrow in two ways:
 *   - the receiver must literally be a catch variable (e/err/error). A predicate
 *     result such as `result.message` is an intentional, bilingual VALIDATION
 *     message, not a leak, and must not be flagged.
 *   - `[^{}]` keeps each match inside ONE object literal, so it cannot "span
 *     forward" into a later statement and report an unrelated route.
 */
const CAUGHT_MESSAGE_FIELD_RES = [
  /res\s*\.\s*status\([^)]*\)\s*\.\s*json\(\s*\{[^{}]{0,200}?\berror\s*:\s*(?:e|err|error)\s*(?:\?\.|\.)\s*message\b/g,
  /res\s*\.\s*status\([^)]*\)\s*\.\s*json\(\s*\{[^{}]{0,200}?\berror\s*:\s*String\s*\(\s*(?:e|err|error)\b/g,
];

/** Fresh regex instances per call so /g lastIndex state cannot leak between tests. */
function caughtMessageLeaks(text: string): string[] {
  const found: string[] = [];
  for (const re of CAUGHT_MESSAGE_FIELD_RES) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      found.push(m[0].replace(/\s+/g, ' ').slice(0, 140));
    }
  }
  return found;
}

describe('Phase 12: a raw caught-error message can never reach a response body, even multi-line', () => {
  // Comment lines are dropped with the repository's line-based filter. A
  // /* ... */ strip is deliberately NOT used: server.ts's own comments legitimately
  // contain sequences like /src/* and /api/*, which an unterminated-looking block
  // strip would swallow wholesale (it removed the health route and the
  // sendServerError helper when this test was first written that way).
  const codeOnly = serverTs
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

  // sendServerError is the ONE sanctioned reader of a caught error's message: it
  // is the helper the whole policy funnels through, it logs the full error
  // server-side, and it only echoes the raw message when NODE_ENV is NOT
  // production (a documented dev-only convenience, asserted below). Its body is
  // removed before the scan so the assertion is about every OTHER response body.
  const sendErrStart = codeOnly.indexOf('function sendServerError(');
  const sendErrEnd = sendErrStart < 0 ? -1 : codeOnly.indexOf('\n}', sendErrStart);
  const scannedCode =
    sendErrStart < 0 || sendErrEnd < 0
      ? codeOnly
      : codeOnly.slice(0, sendErrStart) + codeOnly.slice(sendErrEnd);

  it('the old single-line tripwire really did have this blind spot', () => {
    const formerHealthLeak = [
      "res.status(503).json({",
      "  status: 'error',",
      "  db: 'disconnected',",
      "  error: err.message || String(err),",
      "  timestamp: new Date().toISOString()",
      "});",
    ].join('\n');
    expect(SINGLE_LINE_LEAK_RE.test(formerHealthLeak), 'the old pattern must NOT catch it').toBe(false);
    expect(caughtMessageLeaks(formerHealthLeak).length, 'the new scan MUST catch it').toBeGreaterThan(0);
  });

  it('sendServerError is still the single sanctioned reader, and still production-gated', () => {
    // Guards the exemption above: if sendServerError were deleted or lost its
    // production gate, the scan below would have to be re-derived, not silently
    // widened.
    expect(sendErrStart, 'sendServerError helper not found').toBeGreaterThan(-1);
    const body = codeOnly.slice(sendErrStart, sendErrStart + 600);
    expect(body).toMatch(/NODE_ENV === 'production'/);
    expect(body).toMatch(/console\.error/);
  });

  it('no other response body in server.ts is built from a caught error message', () => {
    const offenders = caughtMessageLeaks(scannedCode);
    expect(offenders, `raw error messages echoed to clients: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it('the health-check failure response carries status and db only, never an error string', () => {
    const start = serverTs.indexOf("app.get('/api/health'");
    expect(start, 'health route not found').toBeGreaterThan(-1);
    // Comments stripped: the route's own explanatory comment quotes the removed
    // `error: err.message || String(err)` line verbatim.
    const route = codeOnly.slice(
      codeOnly.indexOf("app.get('/api/health'"),
      codeOnly.indexOf("app.get('/api/health'") + 900
    );
    expect(route).toContain("db: 'disconnected'");
    expect(route).not.toMatch(/error\s*:\s*err\.message/);
    expect(route).not.toMatch(/error\s*:\s*String\(/);
  });
});

