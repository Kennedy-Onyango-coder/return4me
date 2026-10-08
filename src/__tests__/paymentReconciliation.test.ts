import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// DURABLE PAYMENT RECONCILIATION.
//
// A completed M-Pesa payment must not depend on the claimant keeping the browser
// open, on a 90-second frontend poll, or on a single webhook delivery. Two
// server-side paths recover a missed webhook, and BOTH go through the ONE
// canonical confirmation function (processClaimPaymentConfirmed):
//   A. On demand — the payment-session status route asks the provider.
//   B. Background — a 60-second sweep over pending payment sessions.
//
// These source-audit assertions pin that both exist, are bounded, and never
// re-implement confirmation or re-initiate an STK push.
// =============================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

const SERVER = read('src/server.ts');
const CLAIM_PAYMENTS = read('src/routes/claimPayments.ts');
const DB = read('src/db/database.ts');
const SELECTION = read('src/config/paymentReconciliation.ts');

// =============================================================================
// STABLE SOURCE BOUNDARIES.
//
// These used to be fixed character budgets (`.slice(i, i + 4500)`), which are a
// guess about length rather than a contract: they silently truncate the moment a
// comment is added, and the assertions then fail against correct code. The
// boundaries below are STRUCTURAL — a route runs to the next route registration;
// a nested function runs to the statement that follows it — so adding comments
// can never move the goalposts, and a genuinely missing body still fails loudly.
// =============================================================================
/** The body of one route registration, up to the next registration. */
function routeBody(source: string, startMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `route not found: ${startMarker}`).toBeGreaterThan(-1);
  const next = source.indexOf('\n    app.', start + startMarker.length);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('on-demand reconciliation (payment-session status route)', () => {
  const body = routeBody(
    CLAIM_PAYMENTS,
    "app.get('/api/claims/:id/payment-session/:sessionId/status'",
  );

  it('the route exists and asks the provider through the canonical path', () => {
    expect(body).toContain('processClaimPaymentConfirmed(claimId, session.provider_invoice_id)');
  });

  it('is throttled so a 3-second poll cannot hammer IntaSend', () => {
    expect(body).toContain('SESSION_RECONCILE_MIN_INTERVAL_MS');
    expect(body).toContain('lastSessionReconcileAttempt');
  });

  it('selects through the SAME shared predicate the sweep uses', () => {
    // Not a local copy of the rule: the two entry points must not be able to
    // drift apart on which sessions are worth a provider lookup.
    expect(body).toContain('paymentReconciliationRefusal({');
    expect(body).toContain('hasProviderInvoice: !!session.provider_invoice_id');
    expect(CLAIM_PAYMENTS).toContain(
      "import { paymentReconciliationRefusal } from '../config/paymentReconciliation.ts'",
    );
  });

  it('hand-writes no session-status allow-list of its own any more', () => {
    // The old inline predicate. Its absence is the point: one implementation.
    expect(body).not.toMatch(/session\.status === 'pending'\s*\|\|/);
  });

  it('is gated on persisted rows, never on anything the client sent', () => {
    expect(body).toContain('claimStatus: claim.status');
    expect(body).toContain('paidAt: claim.paid_at');
    expect(body).toContain('sessionStatus: session.status');
    expect(body).not.toMatch(/req\.body\.(paid|status|confirmed|amount)/);
  });
});

// The sweep runs to the statement that publishes it to the app — a structural
// boundary that does not move when the body's comments grow.
function sweepBody(): string {
  const marker = 'async function reconcilePendingPaymentSessions()';
  const start = SERVER.indexOf(marker);
  expect(start, 'reconciliation sweep not found').toBeGreaterThan(-1);
  const end = SERVER.indexOf('(app as any).__reconcilePendingPaymentSessions', start);
  expect(end, 'sweep end boundary not found').toBeGreaterThan(start);
  return SERVER.slice(start, end);
}

describe('background reconciliation sweep', () => {
  it('is defined once and uses the canonical confirmation path', () => {
    expect(SERVER).toContain('async function reconcilePendingPaymentSessions()');
    const body = sweepBody();
    expect(body).toContain('processClaimPaymentConfirmed(claim.id, session.provider_invoice_id)');
    expect(body).toContain("claim.status !== 'pending_payment'");
    // It must not defect to a second confirmation implementation or re-push STK.
    expect(body).not.toContain('attemptClaimEscrowHold');
    expect(body).not.toContain('triggerMpesaStkPush');
  });

  it('selects through the SAME shared predicate the status route uses', () => {
    const body = sweepBody();
    expect(body).toContain('isPaymentReconciliationEligible({');
    expect(body).toContain('hasProviderInvoice: true');
    expect(SERVER).toContain(
      "import { isPaymentReconciliationEligible } from './config/paymentReconciliation'",
    );
    // The old inline session-status allow-list is gone: one implementation.
    expect(body).not.toMatch(/session\.status !== 'pending' &&/);
  });

  it('only considers sessions that carry a provider invoice', () => {
    expect(sweepBody()).toContain('session.provider_invoice_id');
  });

  it('is bounded per run and throttled per invoice', () => {
    expect(SERVER).toContain('RECONCILE_MIN_INTERVAL_MS');
    expect(SERVER).toContain('RECONCILE_MAX_PER_SWEEP');
  });

  it('bounds the confirmed-session repair instead of polling forever', () => {
    // A 'confirmed' session is a terminal provider fact, so the repair cannot
    // become a permanent every-60-seconds provider query.
    expect(SERVER).toContain('RECONCILE_CONFIRMED_REPAIR_MAX_ATTEMPTS');
    expect(sweepBody()).toContain('confirmedSessionRepairAttempts');
  });

  it('is scheduled by startServer via the function attached by createApp', () => {
    expect(SERVER).toContain('__reconcilePendingPaymentSessions');
    expect(SERVER).toContain('setInterval(reconcileSweep, 60 * 1000)');
  });

  it('cannot crash the server on a provider outage (wrapped in try/catch)', () => {
    expect(sweepBody()).toMatch(/catch \(err\)/);
  });
});

describe('confirmation remains a single compare-and-swap', () => {
  it('a provider-confirmed COMPLETE can win even from a locally-expired session', () => {
    // The session window is short; the claim window is 24h. A late approval must
    // still confirm the claim rather than being silently dropped.
    expect(DB).toMatch(/'pending', 'expired'/);
  });

  it('the session CAS produces exactly one winner (idempotent)', () => {
    const i = DB.indexOf('public async attemptPaymentSessionConfirm(');
    const body = DB.slice(i, i + 700);
    expect(body).toContain("status: 'confirmed'");
    expect(body).toContain('.returning()');
  });
});
