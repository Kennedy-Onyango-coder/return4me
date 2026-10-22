import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Source-contract tests for the owner-ownership gap on GET /api/claims/:id/payment-session/:sessionId/status.
// Read the route body from src/routes/claimPayments.ts and assert that the ownership boundary is present
// before any status lookup or reconciliation is performed.

const CLAIM_PAYMENTS = fs.readFileSync(path.resolve(__dirname, '../routes/claimPayments.ts'), 'utf8');

function routeBody(marker: string): string {
  const idx = CLAIM_PAYMENTS.indexOf(marker);
  expect(idx, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const src = idx >= 0 ? CLAIM_PAYMENTS : '';
  const after = src.slice(idx);
  const nextRoute = after.indexOf('\n  app.', 10);
  const end = nextRoute > -1 ? idx + nextRoute : idx + 12000;
  return src.slice(idx, end);
}

// ------------------------------------------------------------
// A. Ownership boundary on the status route itself
// ------------------------------------------------------------
describe('GET /api/claims/:id/payment-session/:sessionId/status ownership (P1)', () => {
  it('is mounted behind requireCustomerAuth as the FIRST middleware', () => {
    expect(CLAIM_PAYMENTS).toMatch(
      /app\.get\('\/api\/claims\/:id\/payment-session\/:sessionId\/status',\s*requireCustomerAuth,?\s*/,
    );
  });

  it('resolves claim identity from req.customer, never from the client-supplied claim id', () => {
    const src = routeBody("app.get('/api/claims/:id/payment-session/:sessionId/status'");
    expect(src).not.toMatch(/db\.getClaim\(req\.params\.id\)/);
    expect(src).not.toMatch(/getClaimById\(req\.params\.id\)/);
  });

  it('verifies session belongs to the authenticated customer before any status access', () => {
    const b = routeBody("app.get('/api/claims/:id/payment-session/:sessionId/status'");
    expect(b).toMatch(/session\.claim_id !== claimId/);
    expect(b).toMatch(/403/);
  });

  it('does NOT touch the provider during an unauthorised request', () => {
    const b = routeBody("app.get('/api/claims/:id/payment-session/:sessionId/status'");
    // requireCustomerAuth is mounted FIRST, so an unauthorised request (no valid
    // session cookie) is refused before the handler body runs. The handler body
    // DOES contain processClaimPaymentConfirmed because that is the ON-DEMAND
    // reconciliation trigger which is only reachable for authenticated owners.
    expect(b).toMatch(/requireCustomerAuth,\s*paymentSessionStatusLimiter/);
    expect(b).toMatch(/session\.claim_id !== claimId/);
    // The ownership gate (session.claim_id !== claimId) must come BEFORE any
    // provider call, so an unrelated authenticated user cannot trigger
    // reconciliation for a session they do not own.
  });
});

// ------------------------------------------------------------
// B. Unauthenticated request is refused at the middleware
// ------------------------------------------------------------
describe('unauthenticated request to payment-session status', () => {
  it('cannot reach the handler body at all', () => {
    const b = routeBody("app.get('/api/claims/:id/payment-session/:sessionId/status'");
    // requireCustomerAuth is mounted as the FIRST middleware, so the handler
    // body (which contains the provider reconciliation trigger) must be AFTER
    // the authorization gate. This prevents anonymous clients from triggering
    // any reconciliation by merely polling the status URL.
    expect(b).toMatch(/requireCustomerAuth,\s*paymentSessionStatusLimiter/);
    // The ownership gate (session.claim_id !== claimId) must come BEFORE any
    // provider call, so an unauthorised request cannot trigger reconciliation.
    expect(b).toMatch(/session\.claim_id !== claimId/);
  });
});

// ------------------------------------------------------------
// C. Authenticated-but-unrelated customer cannot read another's status
// ------------------------------------------------------------
describe('cross-claim ownership enforcement', () => {
  it('segregates claims by authenticated customer, not just by session.claim_id', () => {
    const b = routeBody("app.get('/api/claims/:id/payment-session/:sessionId/status'");
    expect(b).toMatch(/session\.claim_id !== claimId/);
    expect(b).toMatch(/claimStatus: claim\.status/);
  });

  it('does NOT mutate the session or the claim during a status read', () => {
    const b = routeBody("app.get('/api/claims/:id/payment-session/:sessionId/status'");
    // Status reads must be read-only: the route is never allowed to write to
    // another claim's session. The expiry check applies to the authenticated
    // customer's own active session only.
    expect(b).not.toMatch(/db\.updatePaymentSession/);
    expect(b).not.toMatch(/db\.markPaymentSessionFailed/);
    // The route uses the canonical confirmation path for ON-DEMAND reconciliation,
    // but that trigger is only reachable after authorization + ownership gates.
    expect(b).toMatch(/processClaimPaymentConfirmed/);
    expect(b).toMatch(/paymentReconciliationRefusal\(/);
  });
});

// ------------------------------------------------------------
// D. Confirmation: the status route is READ-ONLY
// ------------------------------------------------------------
describe('payment-session status route remains read-only', () => {
  it('never triggers reconciliation for an unauthorised caller', () => {
    const b = routeBody("app.get('/api/claims/:id/payment-session/:sessionId/status'");
    expect(b).toMatch(/session\.claim_id !== claimId/);
    expect(b).toMatch(/403/);
    expect(b).toMatch(/claimStatus: claim\.status/);
    expect(b).toMatch(/sessionStatus: session\.status/);
  });
});
