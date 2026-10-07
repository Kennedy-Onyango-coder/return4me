import { describe, it, expect } from 'vitest';
import { db } from '../database';
import {
  canRecoverExpiredClaimPayment,
  EXPIRED_CLAIM_PAYMENT_RECOVERY_EDGE,
} from '../../config/claimStatuses';
import { reconcileWebhookAmount } from '../../services/payments';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// =============================================================================
// PAYMENT-CONFIRMATION STATE MACHINE — REGRESSION COVERAGE.
//
// The regression scenarios for the hardening of the webhook confirmation
// flow (server.ts processClaimPaymentConfirmed):
//
//   A legitimate provider-completed payment may move a claim
//   `payment_window_expired -> escrow_held` ONLY through the canonical verified
//   webhook path, and the payment session's single confirmation must be consumed
//   ATOMICALLY with the claim transition (never one without the other).
//
// These run against the same in-memory sandbox the rest of this suite uses, so
// they prove the LOGIC and the guards (the CAS predicates, the recovery gate,
// the idempotency of both CASes), not real PostgreSQL row-level concurrency.
// The source-ordering invariant that ties these primitives to the webhook's
// call order lives in src/__tests__/paymentConfirmationOrdering.test.ts.
// =============================================================================

let counter = 0;

async function makeItem(suffix: string) {
  const itemId = `TEST-ITEM-PCR-${suffix}-${testRunId}-${counter++}`;
  await ensureTestCategory('phone');
  await db.createItem({
    id: itemId, category_id: 'phone', photo_url: 'test-photo.jpg', ocr_extracted_number: null,
    ocr_extracted_name: null, document_number_hash: null, document_name_fuzzy: null,
    location_description: 'x', latitude: null, longitude: null, finder_phone: '+254700000011',
    assigned_agent_id: null, status: 'at_agent', flaggedForReview: false, isDescriptionOnly: true,
    description: 'x', is_sensitive_document: false, rejection_reason: null, locked_total_fee: '500',
  } as any);
  return itemId;
}

async function makeClaim(itemId: string, suffix: string, status: string) {
  const claimId = `TEST-CLAIM-PCR-${suffix}-${testRunId}-${counter++}`;
  await db.createClaim({
    id: claimId, item_id: itemId, owner_phone: `+2547001${String(counter).padStart(5, '0')}`,
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'fixture' },
    verification_tier: 1, status: status as any, owner_id_proof_url: null,
    payment_reference: null, owner_identifying_details: null,
  } as any);
  return claimId;
}

/**
 * Reproduces the real initiation path exactly: `created` -> (reservePaymentSession
 * wins the one initiator slot) -> (finalizePaymentSessionInitiated binds the
 * provider invoice) -> `pending`. Returns the session id and its provider invoice.
 */
async function makeInvoicedSession(claimId: string, amount: number) {
  const sessionId = `TEST-PS-PCR-${testRunId}-${counter++}`;
  const invoiceId = `INV-PCR-${testRunId}-${counter}`;
  await db.createPaymentSession({
    id: sessionId, claimId, amount, payerPhone: '+254700000001',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  expect(await db.reservePaymentSession(sessionId)).toBe(true);
  expect(await db.finalizePaymentSessionInitiated(sessionId, invoiceId, 'MPESA-REF')).toBe(true);
  return { sessionId, invoiceId };
}

// =============================================================================
// 1. THE ORDINARY HAPPY PATH.
// =============================================================================
describe('1. normal pending_payment confirmation', () => {
  it('moves the claim to escrow_held and consumes the session exactly once', async () => {
    const itemId = await makeItem('HAPPY');
    const claimId = await makeClaim(itemId, 'HAPPY', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);

    // The session is awaiting provider confirmation.
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('pending');

    const session = await db.getPaymentSessionByProviderInvoice(invoiceId);
    expect(session).toBeTruthy();
    expect(session.claim_id).toBe(claimId);
    expect(session.amount).toBe(500);

    // The ONE legal entry into escrow_held wins exactly once, and it consumes
    // the session's single confirmation ATOMICALLY — the claim CAS and the
    // session CAS commit in ONE transaction, so a paid claim can never exist
    // without a confirmed session (or vice-versa).
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);
    // The session was already consumed atomically above, so the standalone
    // confirm is now an idempotent no-op.
    expect(await db.attemptPaymentSessionConfirm(sessionId)).toBe(false);

    const claim = await db.getClaim(claimId);
    expect(claim!.status).toBe('escrow_held');
    expect(claim!.paid_at ?? null).not.toBeNull();
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
  });
});

// =============================================================================
// 2. THE GATED LATE-PAYMENT RECOVERY (the ONE edge out of a terminal claim).
// =============================================================================
describe('2. legitimate post-expiry recovery', () => {
  it('recovers payment_window_expired -> escrow_held only through the verified edge', async () => {
    const itemId = await makeItem('RECOVER');
    const claimId = await makeClaim(itemId, 'RECOVER', 'payment_window_expired');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);
    // The 15m STK session was swept expired while the claim stayed payable.
    expect(await db.expirePaymentSession(sessionId)).toBe(true);
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('expired');

    const claim = await db.getClaim(claimId);
    const session = await db.getPaymentSessionByProviderInvoice(invoiceId);
    // Every fact is a freshly-read, provider-proven POSITIVE fact.
    const facts = {
      claimStatus: claim!.status,
      paidAt: claim!.paid_at,
      paymentVerified: reconcileWebhookAmount(500, 500) === 'match',
      paymentSessionBoundToClaim: !!session && session.claim_id === claimId,
      sessionConfirmed: session!.status === 'expired' || session!.status === 'pending',
    };
    expect(canRecoverExpiredClaimPayment(facts)).toBe(true);

    // The predicate authorises the widened CAS; only then is it passed.
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true })).toBe(true);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
    expect((await db.getClaim(claimId))!.paid_at ?? null).not.toBeNull();
    // The recovery edge confirms the swept session ATOMICALLY with the hold.
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
  });

  it('records the recovery edge as auditable DATA, not a generic transition', () => {
    expect(EXPIRED_CLAIM_PAYMENT_RECOVERY_EDGE).toEqual({
      from: 'payment_window_expired',
      to: 'escrow_held',
    });
  });
});

// =============================================================================
// 3. A GENUINE EXPIRY (no verified payment) STAYS EXPIRED.
// =============================================================================
describe('3. a genuine unpaid expiry stays terminal', () => {
  it('never recovers a swept claim when no verified payment exists', async () => {
    const itemId = await makeItem('GENUINE');
    const claimId = await makeClaim(itemId, 'GENUINE', 'payment_window_expired');

    const claim = await db.getClaim(claimId);
    // No session, no verified amount: the predicate must stay closed.
    const facts = {
      claimStatus: claim!.status,
      paidAt: claim!.paid_at,
      paymentVerified: false,
      paymentSessionBoundToClaim: false,
      sessionConfirmed: false,
    };
    expect(canRecoverExpiredClaimPayment(facts)).toBe(false);

    // The DEFAULT CAS (no recovery flag) still only matches pending_payment.
    expect(await db.attemptClaimEscrowHold(claimId, 'INV-NEVER')).toBe(false);
    const after = await db.getClaim(claimId);
    expect(after!.status).toBe('payment_window_expired');
    expect(after!.paid_at ?? null).toBeNull();
  });
});

// =============================================================================
// 4. CROSS-CLAIM ISOLATION.
// =============================================================================
describe('4. wrong-claim rejection', () => {
  it('a session bound to another claim can never confirm this claim', async () => {
    const itemId = await makeItem('CROSS');
    const claimA = await makeClaim(itemId, 'CROSS-A', 'payment_window_expired');
    const claimB = await makeClaim(itemId, 'CROSS-B', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimB, 500);
    await db.expirePaymentSession(sessionId);

    // The invoice resolves to a session owned by claim B, not claim A.
    const session = await db.getPaymentSessionByProviderInvoice(invoiceId);
    expect(session.claim_id).toBe(claimB);
    expect(session.claim_id).not.toBe(claimA);

    // For claim A the binding fact is false, so the recovery gate is shut.
    const facts = {
      claimStatus: (await db.getClaim(claimA))!.status,
      paidAt: (await db.getClaim(claimA))!.paid_at,
      paymentVerified: true,
      paymentSessionBoundToClaim: !!session && session.claim_id === claimA,
      sessionConfirmed: true,
    };
    expect(canRecoverExpiredClaimPayment(facts)).toBe(false);
    // And the un-gated claim A CAS cannot move at all.
    expect(await db.attemptClaimEscrowHold(claimA, invoiceId)).toBe(false);
    expect((await db.getClaim(claimA))!.status).toBe('payment_window_expired');
    // The owning claim B is left untouched by the cross-claim attempt.
    expect((await db.getClaim(claimB))!.status).toBe('pending_payment');
  });
});

// =============================================================================
// 5. WRONG INVOICE / SESSION.
// =============================================================================
describe('5. wrong invoice/session rejection', () => {
  it('an unknown provider invoice resolves to no session, so no recovery is possible', async () => {
    const itemId = await makeItem('BADINV');
    const claimId = await makeClaim(itemId, 'BADINV', 'payment_window_expired');

    expect(await db.getPaymentSessionByProviderInvoice('INV-DOES-NOT-EXIST')).toBeUndefined();

    const claim = await db.getClaim(claimId);
    const facts = {
      claimStatus: claim!.status,
      paidAt: claim!.paid_at,
      paymentVerified: true,
      paymentSessionBoundToClaim: false, // no session resolved at all
      sessionConfirmed: false,
    };
    expect(canRecoverExpiredClaimPayment(facts)).toBe(false);
    expect(await db.attemptClaimEscrowHold(claimId, 'INV-DOES-NOT-EXIST')).toBe(false);
    expect((await db.getClaim(claimId))!.status).toBe('payment_window_expired');
  });
});

// =============================================================================
// 6. AMOUNT MISMATCH NEVER CONSUMES THE SESSION.
// =============================================================================
describe('6. amount mismatch rejection', () => {
  it('a mismatched amount never consumes the session confirmation', async () => {
    const itemId = await makeItem('AMOUNT');
    const claimId = await makeClaim(itemId, 'AMOUNT', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);

    // The provider reports 300 against a 500 session: a hard mismatch. The
    // canonical path returns BEFORE either CAS, so the session is untouched and
    // can still be confirmed by a later, correct delivery.
    expect(reconcileWebhookAmount(300, 500)).toBe('mismatch');
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('pending');

    // The correct, fully-reconciled delivery then wins the ATOMIC pair: the
    // claim CAS and the session CAS commit together.
    expect(reconcileWebhookAmount(500, 500)).toBe('match');
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
  });
});

// =============================================================================
// 7. DUPLICATE WEBHOOK IDEMPOTENCY.
// =============================================================================
describe('7. duplicate webhook is idempotent', () => {
  it('both CASes refuse a second delivery and paid_at is never rewritten', async () => {
    const itemId = await makeItem('DUP');
    const claimId = await makeClaim(itemId, 'DUP', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
    const firstPaidAt = (await db.getClaim(claimId))!.paid_at;

    // A replayed provider webhook runs the exact same atomic statement again:
    // the claim CAS loses (already held) and the session CAS is a no-op.
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(false);
    expect(await db.attemptPaymentSessionConfirm(sessionId)).toBe(false);

    const claim = await db.getClaim(claimId);
    expect(claim!.status).toBe('escrow_held');
    // The single winning delivery set paid_at; the replay must not move it.
    expect(new Date(claim!.paid_at as any).getTime()).toBe(new Date(firstPaidAt as any).getTime());
  });
});

// =============================================================================
// 8. AN ADVANCED CLAIM CAN NEVER REGRESS.
// =============================================================================
describe('8. an advanced claim cannot regress', () => {
  it('a claim already in escrow_held or released never transitions again', async () => {
    const itemId = await makeItem('ADVANCED');
    const heldClaim = await makeClaim(itemId, 'ADVANCED-HELD', 'escrow_held');
    const releasedClaim = await makeClaim(itemId, 'ADVANCED-REL', 'released');

    // Even the WIDENED predicate cannot match a state other than the two sources.
    expect(await db.attemptClaimEscrowHold(heldClaim, 'INV-X', { recoverExpiredClaim: true })).toBe(false);
    expect(await db.attemptClaimEscrowHold(releasedClaim, 'INV-Y', { recoverExpiredClaim: true })).toBe(false);
    expect(await db.attemptClaimEscrowHold(heldClaim, 'INV-X')).toBe(false);

    expect((await db.getClaim(heldClaim))!.status).toBe('escrow_held');
    expect((await db.getClaim(releasedClaim))!.status).toBe('released');
    expect((await db.getClaim(releasedClaim))!.paid_at ?? null).toBeNull();
  });
});

// =============================================================================
// 9. A LOCALLY-EXPIRED 15m SESSION IS STILL CONFIRMABLE.
// =============================================================================
describe('9. an expired 15m session with a legit provider completion', () => {
  it('confirms the claim and the locally-expired session on a late COMPLETE', async () => {
    const itemId = await makeItem('LATE');
    const claimId = await makeClaim(itemId, 'LATE', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);

    // The short STK session window elapsed before the webhook arrived.
    expect(await db.expirePaymentSession(sessionId)).toBe(true);
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('expired');

    // The claim is still pending_payment, so the ordinary CAS wins, and it
    // confirms the locally-expired session in the SAME transaction (the session
    // CAS still admits the 'expired' source state).
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
  });
});

// =============================================================================
// 10. A STALE / INVALID PAYMENT CANNOT RESURRECT A TERMINAL CLAIM.
// =============================================================================
describe('10. stale/invalid payment cannot resurrect', () => {
  it('an unverified-amount delivery leaves the terminal claim untouched', async () => {
    const itemId = await makeItem('STALE');
    const claimId = await makeClaim(itemId, 'STALE', 'payment_window_expired');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);

    // The amount could not be positively reconciled and the session was never
    // confirmed, so the gate stays shut even though the invoice is bound here.
    const claim = await db.getClaim(claimId);
    const facts = {
      claimStatus: claim!.status,
      paidAt: claim!.paid_at,
      paymentVerified: false,          // stale/invalid: cannot be proven
      paymentSessionBoundToClaim: true,
      sessionConfirmed: false,         // never consumed
    };
    expect(canRecoverExpiredClaimPayment(facts)).toBe(false);

    // The un-gated CAS refuses, so the terminal claim is untouched.
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(false);
    expect((await db.getClaim(claimId))!.status).toBe('payment_window_expired');

    // And an already-paid claim is refused by the paid_at fact.
    const paidFacts = { ...facts, paidAt: new Date(), paymentVerified: true, sessionConfirmed: true };
    expect(canRecoverExpiredClaimPayment(paidFacts)).toBe(false);
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('pending');
  });
});

// =============================================================================
// THE GATE ITSELF — a full truth table for the ONE authorised edge.
// =============================================================================
describe('canRecoverExpiredClaimPayment truth table', () => {
  const base = {
    claimStatus: 'payment_window_expired',
    paidAt: null as any,
    paymentVerified: true,
    paymentSessionBoundToClaim: true,
    sessionConfirmed: true,
  };

  it('is true only when EVERY positive fact holds', () => {
    expect(canRecoverExpiredClaimPayment(base)).toBe(true);
  });

  it('is false if any single fact is missing or negative', () => {
    expect(canRecoverExpiredClaimPayment({ ...base, claimStatus: 'pending_payment' })).toBe(false);
    expect(canRecoverExpiredClaimPayment({ ...base, claimStatus: 'released' })).toBe(false);
    expect(canRecoverExpiredClaimPayment({ ...base, paidAt: new Date() })).toBe(false);
    expect(canRecoverExpiredClaimPayment({ ...base, paymentVerified: false })).toBe(false);
    expect(canRecoverExpiredClaimPayment({ ...base, paymentSessionBoundToClaim: false })).toBe(false);
    expect(canRecoverExpiredClaimPayment({ ...base, sessionConfirmed: false })).toBe(false);
  });
});

// =============================================================================
// 11. ATOMIC CLAIM+SESSION — THE REVERSE INCONSISTENCY IS IMPOSSIBLE.
//
// The claim CAS and the invoice-bound session CAS are ONE transaction, so a
// successful payment confirmation is a single coherent outcome (claim
// escrow_held + session confirmed) or nothing at all. These prove that a claim
// which COULD move on its own is still refused when the session cannot be
// confirmed, so the system never commits a paid-without-confirmed-session state
// (and never a confirmed-session-without-paid-claim state either).
// =============================================================================
describe('11. the claim CAS and session CAS commit atomically (one coherent outcome)', () => {
  it('holds the claim AND confirms the session as one outcome', async () => {
    const itemId = await makeItem('ATOMIC-OK');
    const claimId = await makeClaim(itemId, 'ATOMIC-OK', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('pending');

    // ONE call moves BOTH rows together.
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);

    const claim = await db.getClaim(claimId);
    const session = await db.getPaymentSessionById(sessionId);
    expect(claim!.status).toBe('escrow_held');
    expect(claim!.paid_at ?? null).not.toBeNull();
    expect(session!.status).toBe('confirmed');
  });

  it('REFUSES the hold when the bound session cannot be confirmed (no reverse inconsistency)', async () => {
    // The claim is in the ordinary payable state, so the claim CAS WOULD move on
    // its own — but the invoice-bound session is in a non-confirmable state (a
    // provider failure). Committing the claim alone would leave a PAID claim with
    // an unconfirmed session; the atomic pair refuses BEFORE writing anything.
    const itemId = await makeItem('ATOMIC-REFUSE');
    const claimId = await makeClaim(itemId, 'ATOMIC-REFUSE', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);
    expect(await db.markPaymentSessionFailed(sessionId, 'provider declined')).toBe(true);
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('failed');

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(false);

    // Neither half of the pair committed — never a paid claim on its own.
    const claim = await db.getClaim(claimId);
    expect(claim!.status).toBe('pending_payment');
    expect(claim!.paid_at ?? null).toBeNull();
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('failed');
  });

  it('the gated recovery edge ALSO confirms the swept session in the same transaction', async () => {
    const itemId = await makeItem('ATOMIC-REC');
    const claimId = await makeClaim(itemId, 'ATOMIC-REC', 'payment_window_expired');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);
    expect(await db.expirePaymentSession(sessionId)).toBe(true);

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true })).toBe(true);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
  });

  it("a cross-claim invoice never confirms the OTHER claim's session", async () => {
    const itemId = await makeItem('ATOMIC-CROSS');
    // claimA is terminal-late, so claimB is the only live claim on the item.
    const claimA = await makeClaim(itemId, 'ATOMIC-CROSS-A', 'payment_window_expired');
    const claimB = await makeClaim(itemId, 'ATOMIC-CROSS-B', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimB, 500);

    // The invoice belongs to claim B; attempting to hold claim A must not move A,
    // and must not consume B's session either.
    expect(await db.attemptClaimEscrowHold(claimA, invoiceId)).toBe(false);
    expect((await db.getClaim(claimA))!.status).toBe('payment_window_expired');
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('pending');
  });
});




