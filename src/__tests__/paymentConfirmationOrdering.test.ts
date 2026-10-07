import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// =============================================================================
// WEBHOOK CONFIRMATION — ORDERING / ATOMICITY INVARIANTS.
//
// These pin the exact source-level ordering of the canonical payment path
// (server.ts processClaimPaymentConfirmed) that makes the claim CAS and the
// payment-session confirmation ATOMICALLY consistent:
//
//   * the payment session is NEVER written before the claim CAS (the pre-CAS
//     block is a READ-ONLY confirmability check);
//   * the session's single confirmation is consumed ONLY AFTER the claim CAS
//     actually won (`attemptClaimEscrowHold` then `if (!won) return null;`);
//   * the gated terminal-recovery predicate is evaluated on a freshly re-read
//     claim immediately before the CAS, and passes `recoverExpiredClaim: true`.
//
// The behavioural consequences of these primitives are exercised against a real
// in-memory db in src/db/__tests__/paymentConfirmationRecovery.test.ts.
// =============================================================================
const serverTs = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

const fnStart = serverTs.indexOf('async function processClaimPaymentConfirmed(');
const idx = (marker: string) => serverTs.indexOf(marker, fnStart);

describe('processClaimPaymentConfirmed: claim CAS precedes session confirmation', () => {
  it('defines the canonical confirmation function exactly once', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(serverTs.indexOf('async function processClaimPaymentConfirmed(')).toBe(fnStart);
  });

  it('consumes the session confirmation AFTER the claim CAS won', () => {
    const escrowIdx = idx('await db.attemptClaimEscrowHold(claimId, invoiceId');
    const nullReturnIdx = idx('if (!won) return null;');
    const sessionConfirmIdx = idx('await db.attemptPaymentSessionConfirm(session.id);');

    expect(escrowIdx, 'claim escrow CAS must exist').toBeGreaterThan(-1);
    expect(nullReturnIdx, 'the lost-CAS early return must exist').toBeGreaterThan(-1);
    expect(sessionConfirmIdx, 'the session confirmation must exist').toBeGreaterThan(-1);

    // escrow CAS  <  early return  <  session confirmation
    expect(escrowIdx).toBeLessThan(nullReturnIdx);
    expect(nullReturnIdx).toBeLessThan(sessionConfirmIdx);
  });

  it('guards the session confirmation behind `if (session)` after the CAS', () => {
    const sessionConfirmIdx = idx('await db.attemptPaymentSessionConfirm(session.id);');
    const window = serverTs.slice(sessionConfirmIdx - 80, sessionConfirmIdx + 60);
    expect(window).toContain('if (session) {');
  });
});

describe('the pre-CAS session block is READ-ONLY (never strands a confirmed session)', () => {
  const preCasStart = idx('const session = await db.getPaymentSessionByProviderInvoice(invoiceId);');
  const wonIdx = idx('const won = recoverExpiredClaim');
  const region = preCasStart > -1 && wonIdx > preCasStart ? serverTs.slice(preCasStart, wonIdx) : '';

  it('performs only a confirmability READ before the CAS', () => {
    expect(preCasStart).toBeGreaterThan(-1);
    expect(wonIdx).toBeGreaterThan(preCasStart);
    expect(region).toContain('let sessionConfirmed = false;');
    expect(region).toContain("session.status === 'confirmed' || session.status === 'pending' || session.status === 'expired'");
  });

  it('never writes the session before the claim CAS (no pre-CAS mutation)', () => {
    // The fix removed the pre-CAS session write. The session must not be
    // confirmed, reserved, expired or failed anywhere above `const won =`.
    expect(region).not.toContain('attemptPaymentSessionConfirm');
    expect(region).not.toContain('reservePaymentSession');
    expect(region).not.toContain('expirePaymentSession');
    expect(region).not.toContain('markPaymentSessionFailed');
    // And the intent is documented in-line.
    expect(region).toContain('is NOT written here');
  });
});

describe('the gated terminal-recovery edge is evaluated on freshly-read facts', () => {
  it('re-reads the claim and runs the predicate immediately before the CAS', () => {
    const rereadIdx = idx('const currentClaim = await db.getClaim(claimId);');
    const predicateIdx = idx('canRecoverExpiredClaimPayment({');
    const wonIdx = idx('const won = recoverExpiredClaim');

    expect(rereadIdx).toBeGreaterThan(-1);
    expect(predicateIdx).toBeGreaterThan(rereadIdx);
    expect(predicateIdx).toBeLessThan(wonIdx);
  });

  it('passes each provider-proven fact into the predicate', () => {
    const predicateIdx = idx('canRecoverExpiredClaimPayment({');
    const block = serverTs.slice(predicateIdx, predicateIdx + 420);
    expect(block).toContain('claimStatus: currentClaim.status');
    expect(block).toContain('paidAt: currentClaim.paid_at');
    expect(block).toContain("paymentVerified: claimRecon === 'match'");
    expect(block).toContain('paymentSessionBoundToClaim: !!session && session.claim_id === claimId');
    expect(block).toContain('sessionConfirmed');
  });

  it('only the predicate-driven branch may request the widened recovery CAS', () => {
    const wonIdx = idx('const won = recoverExpiredClaim');
    const block = serverTs.slice(wonIdx, wonIdx + 320);
    expect(block).toContain('recoverExpiredClaim');
    expect(block).toContain('attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true })');
    expect(block).toContain('attemptClaimEscrowHold(claimId, invoiceId)');
  });
});

// =============================================================================
// THE ATOMIC PAIR LIVES IN THE DB LAYER.
//
// server.ts still calls the claim CAS FIRST and the session confirmation after
// it (and the pre-CAS socket block stays read-only), but the two WRITES are now
// performed as ONE transaction inside attemptClaimEscrowHold. A failure between
// them can therefore no longer commit a paid claim whose session was never
// confirmed — the reverse inconsistency — nor a confirmed session against an
// unheld claim.
// =============================================================================
const dbTs = fs.readFileSync(path.resolve(__dirname, '../db/database.ts'), 'utf8');

describe('attemptClaimEscrowHold performs the claim CAS and the session CAS in ONE transaction', () => {
  const dbFn = dbTs.indexOf('public async attemptClaimEscrowHold(');
  const body = dbFn > -1 ? dbTs.slice(dbFn, dbFn + 9000) : '';

  it('wraps both writes in a single database transaction', () => {
    expect(dbFn).toBeGreaterThan(-1);
    expect(body).toContain('drizzleDb.transaction(');
  });

  it('orders the CLAIM CAS before the SESSION CAS', () => {
    const claimIdx = body.indexOf('update(claimsTable)');
    const sessionIdx = body.indexOf('update(paymentSessionsTable)');
    expect(claimIdx, 'the claim CAS must exist').toBeGreaterThan(-1);
    expect(sessionIdx, 'the session CAS must exist').toBeGreaterThan(-1);
    expect(claimIdx).toBeLessThan(sessionIdx);
  });

  it('rolls the claim CAS back if the session confirmation cannot be won', () => {
    // A lost session CAS THROWS inside the transaction, so the claim CAS above
    // cannot commit on its own.
    expect(body).toMatch(/could not be confirmed atomically/);
  });
});
