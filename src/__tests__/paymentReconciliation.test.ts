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

describe('on-demand reconciliation (payment-session status route)', () => {
  const i = CLAIM_PAYMENTS.indexOf("app.get('/api/claims/:id/payment-session/:sessionId/status'");
  const body = i > -1 ? CLAIM_PAYMENTS.slice(i, i + 4500) : '';

  it('the route exists and asks the provider through the canonical path', () => {
    expect(i).toBeGreaterThan(-1);
    expect(body).toContain('processClaimPaymentConfirmed(claimId, session.provider_invoice_id)');
  });

  it('is throttled so a 3-second poll cannot hammer IntaSend', () => {
    expect(body).toContain('SESSION_RECONCILE_MIN_INTERVAL_MS');
    expect(body).toContain('lastSessionReconcileAttempt');
  });

  it('only reconciles a claim still awaiting payment', () => {
    expect(body).toContain("claim.status === 'pending_payment'");
  });

  it('never marks success from client input', () => {
    expect(body).not.toMatch(/req\.body\.(paid|status|confirmed)/);
  });
});

describe('background reconciliation sweep', () => {
  it('is defined once and uses the canonical confirmation path', () => {
    expect(SERVER).toContain('async function reconcilePendingPaymentSessions()');
    const i = SERVER.indexOf('async function reconcilePendingPaymentSessions()');
    const body = SERVER.slice(i, i + 2200);
    expect(body).toContain('processClaimPaymentConfirmed(claim.id, session.provider_invoice_id)');
    expect(body).toContain("claim.status !== 'pending_payment'");
    // It must not defect to a second confirmation implementation or re-push STK.
    expect(body).not.toContain('attemptClaimEscrowHold');
    expect(body).not.toContain('triggerMpesaStkPush');
  });

  it('only considers sessions that carry a provider invoice', () => {
    const i = SERVER.indexOf('async function reconcilePendingPaymentSessions()');
    const body = SERVER.slice(i, i + 2200);
    expect(body).toContain('session.provider_invoice_id');
  });

  it('is bounded per run and throttled per invoice', () => {
    expect(SERVER).toContain('RECONCILE_MIN_INTERVAL_MS');
    expect(SERVER).toContain('RECONCILE_MAX_PER_SWEEP');
  });

  it('is scheduled by startServer via the function attached by createApp', () => {
    expect(SERVER).toContain('__reconcilePendingPaymentSessions');
    expect(SERVER).toContain('setInterval(reconcileSweep, 60 * 1000)');
  });

  it('cannot crash the server on a provider outage (wrapped in try/catch)', () => {
    const i = SERVER.indexOf('async function reconcilePendingPaymentSessions()');
    const body = SERVER.slice(i, i + 2200);
    expect(body).toMatch(/catch \(err\)/);
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
