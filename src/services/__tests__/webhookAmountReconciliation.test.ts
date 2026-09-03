import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { reconcileWebhookAmount } from '../payments';

// P1 REGRESSION TEST — webhook amount reconciliation. The IntaSend
// webhook handler used to confirm a claim's payment based solely on
// invoice_id, state, and api_ref — never looking at the paid amount at
// all. Signature verification means an attacker can't forge/alter a
// payload without the shared secret, but that's a different guarantee:
// a legitimately-signed webhook could still report a different amount
// than what the claim actually owes (a fee-calculation bug, a race
// between STK-push initiation and confirmation, a provider-side anomaly)
// and nothing would have caught it. reconcileWebhookAmount is the pure
// decision logic behind processClaimPaymentConfirmed's new check,
// extracted to services/payments.ts so it's directly testable — same
// reasoning as isAgentActionable/isAdminSessionCurrent: server.ts has no
// exports and unsafe top-level side effects to import in a test file.

describe('reconcileWebhookAmount', () => {
  it('an exact match reconciles', () => {
    expect(reconcileWebhookAmount(500, 500)).toBe('match');
    expect(reconcileWebhookAmount('500', '500')).toBe('match');
  });

  it('formatting differences within epsilon still reconcile ("500" vs "500.00")', () => {
    expect(reconcileWebhookAmount('500.00', 500)).toBe('match');
    expect(reconcileWebhookAmount(500.3, 500)).toBe('match'); // within 0.5 tolerance
  });

  it('a genuine mismatch is flagged, not silently accepted', () => {
    expect(reconcileWebhookAmount(300, 500)).toBe('mismatch');
    expect(reconcileWebhookAmount(500, 300)).toBe('mismatch');
  });

  it('a mismatch just outside the epsilon tolerance is still flagged', () => {
    expect(reconcileWebhookAmount(500.51, 500)).toBe('mismatch');
  });

  it('a missing/absent amount is "unknown", not silently treated as a match', () => {
    expect(reconcileWebhookAmount(undefined, 500)).toBe('unknown');
    expect(reconcileWebhookAmount(null, 500)).toBe('unknown');
    expect(reconcileWebhookAmount('', 500)).toBe('unknown');
  });

  it('a non-numeric amount is "unknown", not silently treated as a match', () => {
    expect(reconcileWebhookAmount('not-a-number', 500)).toBe('unknown');
  });
});

const serverTs = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');

describe('processClaimPaymentConfirmed is wired to actually enforce the reconciliation result', () => {
  it('a mismatch refuses BEFORE the atomic escrow-hold transition (never holds escrow with a wrong amount)', () => {
    const fnStart = serverTs.indexOf('async function processClaimPaymentConfirmed');
    expect(fnStart).toBeGreaterThan(-1);
    const body = serverTs.slice(fnStart, fnStart + 4000);
    const mismatchIdx = body.indexOf("reconciliation === 'mismatch'");
    const escrowHoldIdx = body.indexOf('attemptClaimEscrowHold(claimId, invoiceId)');
    expect(mismatchIdx, 'mismatch check not found').toBeGreaterThan(-1);
    expect(escrowHoldIdx, 'attemptClaimEscrowHold call not found').toBeGreaterThan(-1);
    expect(mismatchIdx).toBeLessThan(escrowHoldIdx);
  });

  it('the webhook route extracts and passes the amount field into processClaimPaymentConfirmed', () => {
    const start = serverTs.indexOf("app.post('/api/webhooks/intasend'");
    expect(start).toBeGreaterThan(-1);
    const body = serverTs.slice(start, start + 6000);
    expect(body).toMatch(/const webhookAmount = value \?\? amount;/);
    expect(body).toMatch(/processClaimPaymentConfirmed\(claimId, invoice_id, webhookAmount\)/);
  });

  it('a mismatch is audit-logged for manual review, not just console-logged and silently dropped', () => {
    const fnStart = serverTs.indexOf('async function processClaimPaymentConfirmed');
    const body = serverTs.slice(fnStart, fnStart + 4000);
    expect(body).toMatch(/WEBHOOK_AMOUNT_MISMATCH_REFUSED/);
  });
});
