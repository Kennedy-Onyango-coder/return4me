import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Claim IDs (CLM-100000..CLM-999999, see generateUniqueClaimId in
// server.ts) are 6-digit numeric codes — under 900,000 possible values.
// /api/claims/:id/pay and /api/claims/lookup are both unauthenticated
// (owners aren't logged in) and only take a claim ID (and, for /pay,
// optionally a phone that isn't required to match). Without a route-level
// rate limit keyed tighter than the general 1000-req/15min-per-IP cap,
// either route is brute-forceable — worst case for /pay, an attacker who
// guesses a claim ID sitting in 'pending_payment' can trigger a real M-Pesa
// STK push to an uninvolved third party's phone with no proof of ownership.
//
// Static source-audit test (same pattern as adminRouteAudit.test.ts) since
// server.ts doesn't export its Express app separately from startServer()'s
// bootstrap — this still catches the limiter being removed or a future
// claim-ID-keyed route being added without one.

const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

describe('claim-ID-guessable routes are rate limited beyond the general IP cap', () => {
  it('defines a dedicated limiter for claim-guessing routes', () => {
    expect(serverTs).toMatch(/const claimGuessLimiter = rateLimit\(/);
  });

  it('applies claimGuessLimiter to POST /api/claims/:id/pay', () => {
    expect(serverTs).toMatch(/app\.post\('\/api\/claims\/:id\/pay',\s*claimGuessLimiter,/);
  });

  it('applies claimGuessLimiter to POST /api/claims/lookup', () => {
    expect(serverTs).toMatch(/app\.post\('\/api\/claims\/lookup',\s*claimGuessLimiter,/);
  });
});
