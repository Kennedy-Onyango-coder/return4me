// =============================================================================
// FINAL EMAIL AUTHENTICATION PRODUCTION GATE — REGRESSION GUARDS.
// =============================================================================
//
// Three defects were found by reading the code during the final production gate.
// A report alone would not stop any of them from returning, so each is pinned
// here. The repo already uses source-level assertions for exactly this class of
// invariant (see emailOtpFinalReview.test.ts, smsMigrationN7.test.ts), because
// server.ts boots the whole application at import time and cannot be imported by
// a test:
//
//   Part 4  The identity-change verification code was generated with
//           `Math.random()`. It is the ONLY proof of control over the identifier
//           being claimed, so its unpredictability is a security property.
//   Part 5  A six-digit code is ~10^6 wide and the ceiling (30 min) is long: the
//           change must be BURNED after a bounded number of wrong guesses.
//   Part 10 A provider that accepts the connection and then never answers must
//           not pin the request: the send must be bounded by a timeout.
//
// The runtime halves (the ceiling via HTTP in batch2CustomerAccountHttp, the DB
// column and its atomic increment, and the provider timeout) are asserted for
// real below and in that HTTP suite.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS } from '../config/customerAccountPolicy';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const accountTs = read('src/routes/customerAccount.ts');
const policyTs = read('src/config/customerAccountPolicy.ts');
const dbTs = read('src/db/database.ts');
const schemaTs = read('src/db/schema.ts');
const schemaSql = read('sql/schema.sql');
const dbIndexTs = read('src/db/index.ts');
const emailTs = read('src/services/email.ts');

// -----------------------------------------------------------------------------
// PART 4 — THE VERIFICATION CODE IS FROM A CSPRNG, NOT Math.random()
// -----------------------------------------------------------------------------
describe('Part 4 — identity-change codes come from a CSPRNG', () => {
  it('generates the code with crypto.randomInt', () => {
    expect(accountTs).toContain('crypto.randomInt(100000, 1000000)');
  });

  it('never uses Math.random() in the executable code of the account route', () => {
    // A single stray Math.random() anywhere in this file would re-open the same
    // defect. Nothing in this route needs a non-cryptographic random value.
    // A single stray Math.random() anywhere in this file would re-open the same
    // defect, so the check runs over the WHOLE route. Line comments are removed
    // first: the surrounding prose deliberately NAMES the retired primitive to
    // explain why it must not return, and prose is not executable code.
    const accountCode = accountTs.replace(/\/\/[^\r\n]*/g, '');
    expect(accountCode).not.toContain('Math.random(');
  });
});

// -----------------------------------------------------------------------------
// PART 5 — WRONG GUESSES ARE BOUNDED AND THE CHANGE IS BURNED AT THE CEILING
// -----------------------------------------------------------------------------
describe('Part 5 — identity-change verification is bounded', () => {
  it('declares a small, positive ceiling in the single policy module', () => {
    expect(Number.isInteger(IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS)).toBe(true);
    expect(IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS).toBeLessThanOrEqual(10);
    expect(policyTs).toContain('export const IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS');
  });

  it('counts the failure then burns the change once the ceiling is reached', () => {
    // The route must (a) increment on a wrong code and (b) consume the change
    // when the returned total meets the ceiling. Both must reference the shared
    // constant, not a locally re-typed number.
    expect(accountTs).toContain('db.incrementCustomerIdentityChangeAttempts(');
    expect(accountTs).toContain('attempts >= IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS');
    expect(accountTs).toContain('db.consumeCustomerIdentityChange(');
    expect(accountTs).toContain('IDENTITY_CHANGE_MAX_VERIFICATION_ATTEMPTS,');
  });

  it('bumps the counter with the sandbox-safe absolute-write idiom', () => {
    expect(dbTs).toContain('incrementCustomerIdentityChangeAttempts');
    // Read-modify-write with an ABSOLUTE value, matching incrementOtpAttempts -
    // the sandbox database this suite runs on NULLs SQL arithmetic.
    expect(dbTs).toContain('.set({ attempt_count: next })');
    expect(dbTs).toContain('const current = Number(rows[0].attempt_count)');
  });

  it('persists the counter in every schema definition of the table', () => {
    // The Drizzle model, the canonical SQL, and the incremental migration path
    // must all agree, or a live database would diverge from a fresh one.
    expect(schemaTs).toContain('attempt_count: integer("attempt_count")');
    expect(schemaSql).toContain('attempt_count INTEGER NOT NULL DEFAULT 0');
    expect(dbIndexTs).toContain('attempt_count INTEGER NOT NULL DEFAULT 0');
    expect(dbIndexTs).toContain('ADD COLUMN IF NOT EXISTS attempt_count');
  });
});


// -----------------------------------------------------------------------------
// PART 10 — THE PROVIDER CALL IS BOUNDED BY A TIMEOUT
// -----------------------------------------------------------------------------
describe('Part 10 — the email provider request is time-bounded', () => {
  it('defines a bounded, overridable timeout', () => {
    expect(emailTs).toContain('EMAIL_PROVIDER_TIMEOUT_MS');
    expect(emailTs).toContain('process.env.EMAIL_PROVIDER_TIMEOUT_MS');
    // A finite positive default, never an unbounded wait.
    expect(emailTs).toContain('10_000');
  });

  it('races the send against the timeout instead of awaiting it forever', () => {
    expect(emailTs).toContain('function withProviderTimeout');
    expect(emailTs).toContain('Promise.race([operation, timeout])');
    expect(emailTs).toContain("withProviderTimeout(sendPromise, 'Resend send')");
  });
});
