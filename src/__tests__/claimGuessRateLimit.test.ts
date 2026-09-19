import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Claim IDs (CLM-100000..CLM-999999, see generateUniqueClaimId in
// server.ts) are 6-digit numeric codes — under 900,000 possible values.
// /api/claims/:id/pay is unauthenticated (the claimant pays before any
// account is required) and only takes a claim ID, with an optional phone that
// is not required to match. Without a route-level rate limit keyed tighter
// than the general 1000-req/15min-per-IP cap it is brute-forceable — worst
// case, an attacker who guesses a claim ID sitting in 'pending_payment' can
// trigger a real M-Pesa STK push to an uninvolved third party's phone with no
// proof of ownership.
//
// PHASE 16 UPDATE — /api/claims/lookup has LEFT that list. It now resolves the
// customer session FIRST (requireCustomerAuth), because Track My Claim is an
// authenticated journey. The discrete limiter was NOT removed: it is still
// applied, immediately behind that boundary. Both facts are pinned below, so
// neither the new authentication boundary nor the existing limit can be
// silently dropped by a later change.
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

  it('applies claimGuessLimiter to POST /api/claims/lookup, behind the Phase 16 auth boundary', () => {
    // PHASE 16: requireCustomerAuth was added as the FIRST middleware on this
    // route (Track My Claim is now an authenticated journey). The limit was
    // additive, not replaced — it is still applied to the same route.
    expect(serverTs).toMatch(/app\.post\('\/api\/claims\/lookup',\s*requireCustomerAuth,\s*claimGuessLimiter,/);
  });
});
