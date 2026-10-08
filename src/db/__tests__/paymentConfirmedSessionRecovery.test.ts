import { describe, it, expect } from 'vitest';
import { db } from '../database';
import {
  canRecoverExpiredClaimPayment,
  EXPIRED_CLAIM_PAYMENT_RECOVERY_EDGE,
} from '../../config/claimStatuses';
import {
  isPaymentReconciliationEligible,
  paymentReconciliationRefusal,
  RECONCILABLE_CLAIM_STATUSES,
  RECONCILABLE_SESSION_STATUSES,
} from '../../config/paymentReconciliation';
import { reconcileWebhookAmount } from '../../services/payments';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// =============================================================================
// A CONFIRMED PAYMENT SESSION AGAINST AN UNPAID CLAIM — RECOVERY.
// =============================================================================
//
// THE FAILURE CLASS THIS SUITE REPRODUCES
//
// A payment session can exist in `confirmed` while its claim is still UNPAID and
// has already been swept to `payment_window_expired`. Both recovery entry points
// — the on-demand payment-status route and the background reconciliation sweep —
// used to select only `pending`/`expired` sessions, so such a session became
// permanently unreachable: the provider had genuinely taken the money, and the
// claim was orphaned with `paid_at IS NULL` and no path back.
//
// The suite is written against SYNTHETIC IN-MEMORY FIXTURES ONLY. It does not
// read, replay, confirm, reconcile or mutate any production record, and it
// deliberately names no real claim, item, session, invoice or provider
// reference. The fixture that produces the stranded state uses only the public
// database primitives the pre-atomic confirmation order used
// (attemptPaymentSessionConfirm without moving the claim), so the STATE is
// reproduced without touching the historical incident it was observed from.
//
// THE INVARIANT UNDER TEST
//
//   `claims.paid_at IS NOT NULL` is the ONLY proof a claim was paid. A session
//   marked `confirmed` is NOT by itself proof that its claim was paid, so a
//   confirmed session must stay reachable by recovery — while the claim's own
//   CAS and the canonical gates keep deciding whether anything is written.
//
// These run against the in-memory sandbox the rest of this suite uses, so they
// prove the LOGIC and the guards (the CAS predicates, the recovery gate, the
// idempotency of both CASes), not real PostgreSQL row-level concurrency.
// =============================================================================

const DISPUTE_WINDOW_MS = 48 * 60 * 60 * 1000;

let counter = 0;
const nextId = (tag: string) => `${tag}-${testRunId}-${counter++}`;

/** An item carrying a locked fee (and optionally a locked split + an agent). */
async function makeItem(
  suffix: string,
  opts: { agentId?: string | null; categoryId?: string } = {},
) {
  const categoryId = opts.categoryId ?? 'phone';
  if (!opts.categoryId) await ensureTestCategory(categoryId);
  const itemId = nextId(`TEST-ITEM-CSR-${suffix}`);
  await db.createItem({
    id: itemId, category_id: categoryId, photo_url: 'test-photo.jpg', ocr_extracted_number: null,
    ocr_extracted_name: null, document_number_hash: null, document_name_fuzzy: null,
    location_description: 'x', latitude: null, longitude: null, finder_phone: '+254700000011',
    assigned_agent_id: opts.agentId ?? null, status: 'at_agent', flaggedForReview: false,
    isDescriptionOnly: true, description: 'x', is_sensitive_document: false, rejection_reason: null,
    locked_total_fee: '500',
  } as any);
  return itemId;
}

async function makeClaim(itemId: string, suffix: string, status: string) {
  const claimId = nextId(`TEST-CLAIM-CSR-${suffix}`);
  await db.createClaim({
    id: claimId, item_id: itemId, owner_phone: `+2547001${String(counter).padStart(5, '0')}`,
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'fixture' },
    verification_tier: 1, status: status as any, owner_id_proof_url: null,
    payment_reference: null, owner_identifying_details: null,
  } as any);
  return claimId;
}

/** Real initiation path: created -> payment_initiated -> pending, with an invoice. */
async function makeInvoicedSession(claimId: string, amount: number) {
  const sessionId = nextId('TEST-PS-CSR');
  const invoiceId = `INV-CSR-${testRunId}-${counter}`;
  await db.createPaymentSession({
    id: sessionId, claimId, amount, payerPhone: '+254700000001',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  expect(await db.reservePaymentSession(sessionId)).toBe(true);
  expect(await db.finalizePaymentSessionInitiated(sessionId, invoiceId, 'MPESA-REF')).toBe(true);
  return { sessionId, invoiceId };
}

/**
 * THE STRANDED STATE — a `confirmed` session whose claim is untouched.
 *
 * `attemptPaymentSessionConfirm` is the session's ONE confirmation CAS and the
 * only public producer of `confirmed`. Consuming it WITHOUT moving the claim is
 * exactly what the pre-atomic confirmation order could do, and it is the state
 * the reconciliation gap left unreachable. No private API and no raw SQL is used.
 */
async function makeStrandedConfirmedSession(claimId: string, amount = 500) {
  const { sessionId, invoiceId } = await makeInvoicedSession(claimId, amount);
  expect(await db.attemptPaymentSessionConfirm(sessionId)).toBe(true);
  expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
  // And the claim is demonstrably NOT paid: the whole point of the fixture.
  expect((await db.getClaim(claimId))!.paid_at ?? null).toBeNull();
  return { sessionId, invoiceId };
}

// =============================================================================
// 1. THE SHARED SELECTION PREDICATE (pure — no database, no network).
// =============================================================================
describe('1. the shared reconciliation-selection predicate', () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    claimStatus: 'pending_payment',
    paidAt: null as string | Date | null,
    sessionStatus: 'pending',
    hasProviderInvoice: true,
    ...over,
  });

  it('admits the ordinary in-window case', () => {
    expect(isPaymentReconciliationEligible(facts())).toBe(true);
  });

  it('admits a locally-expired session, because the provider may still say COMPLETE', () => {
    expect(isPaymentReconciliationEligible(facts({ sessionStatus: 'expired' }))).toBe(true);
  });

  it('ADMITS A CONFIRMED SESSION — the regression this batch closes', () => {
    // Previously excluded by both entry points, which is exactly what made a
    // stranded confirmed session unrecoverable.
    expect(RECONCILABLE_SESSION_STATUSES).toContain('confirmed');
    expect(isPaymentReconciliationEligible(facts({ sessionStatus: 'confirmed' }))).toBe(true);
    // ...including for a claim the expiry sweep has already moved.
    expect(
      isPaymentReconciliationEligible(facts({
        sessionStatus: 'confirmed',
        claimStatus: 'payment_window_expired',
      })),
    ).toBe(true);
  });

  it('REFUSES an already-paid claim, whatever the session says', () => {
    // `paid_at` is the authoritative marker: there is nothing left to reconcile,
    // so an ordinary polling cycle must not even ask the provider.
    for (const sessionStatus of RECONCILABLE_SESSION_STATUSES) {
      expect(isPaymentReconciliationEligible(facts({ sessionStatus, paidAt: new Date() })), sessionStatus).toBe(false);
    }
    expect(paymentReconciliationRefusal(facts({ paidAt: '2026-01-01T00:00:00.000Z' })))
      .toBe('claim_already_paid');
  });

  it('refuses a session with no provider invoice — there is no identity to verify', () => {
    expect(paymentReconciliationRefusal(facts({ hasProviderInvoice: false })))
      .toBe('no_provider_invoice');
  });

  it('refuses every claim status that is not open or freshly swept', () => {
    const notReconcilable = ['escrow_held', 'pending_settlement', 'releasing', 'released', 'refunded', 'rejected', 'disputed', 'refunding'];
    for (const status of notReconcilable) {
      expect(isPaymentReconciliationEligible(facts({ claimStatus: status })), status).toBe(false);
    }
    for (const status of RECONCILABLE_CLAIM_STATUSES) {
      expect(isPaymentReconciliationEligible(facts({ claimStatus: status })), status).toBe(true);
    }
  });

  it('refuses every session status that cannot be confirmed', () => {
    for (const status of ['created', 'payment_initiated', 'failed', 'cancelled']) {
      expect(isPaymentReconciliationEligible(facts({ sessionStatus: status })), status).toBe(false);
    }
    expect(paymentReconciliationRefusal(facts({ sessionStatus: 'failed' })))
      .toBe('session_status_not_reconcilable');
  });

  it('treats absent or unknown values as "do not select", never as "go ahead"', () => {
    for (const bad of [undefined, null, '', 'PENDING', 'unknown']) {
      expect(isPaymentReconciliationEligible(facts({ sessionStatus: bad }))).toBe(false);
      expect(isPaymentReconciliationEligible(facts({ claimStatus: bad }))).toBe(false);
    }
  });

  it('reports a stable, non-sensitive refusal code for every refusal', () => {
    expect([
      paymentReconciliationRefusal(facts({ hasProviderInvoice: false })),
      paymentReconciliationRefusal(facts({ paidAt: new Date() })),
      paymentReconciliationRefusal(facts({ claimStatus: 'released' })),
      paymentReconciliationRefusal(facts({ sessionStatus: 'failed' })),
    ]).toEqual([
      'no_provider_invoice', 'claim_already_paid',
      'claim_status_not_reconcilable', 'session_status_not_reconcilable',
    ]);
    expect(paymentReconciliationRefusal(facts())).toBeNull();
  });
});

// =============================================================================
// 2. PROVIDER VERIFICATION OUTCOMES (pure — the decision, not the transport).
//
// These drive the canonical path's amount reconciliation directly, so success,
// pending, failure and unavailable are all covered without a network call. A
// value that cannot be positively reconciled is never a licence to enter escrow.
// =============================================================================
describe('2. provider verification outcomes gate the recovery', () => {
  it('a verified, matching amount reconciles', () => {
    expect(reconcileWebhookAmount('500', '500')).toBe('match');
    expect(reconcileWebhookAmount(500, '500.00')).toBe('match');
    expect(reconcileWebhookAmount('499.75', '500')).toBe('match');
  });

  it('an unverified or unusable provider answer never reconciles', () => {
    // The shapes a PENDING, FAILED or unavailable provider lookup produces:
    // absent, malformed, non-numeric, zero or negative. Each one is 'unknown',
    // i.e. "no usable amount in this payload" — NEVER a reconciliation.
    for (const value of [undefined, null, '', 'PENDING', 'FAILED', {}, NaN, 0, -500, '500abc']) {
      expect(reconcileWebhookAmount(value, '500'), String(value)).toBe('unknown');
    }
  });

  it('a verified amount that does NOT match the fee is a refusal, never a write', () => {
    expect(reconcileWebhookAmount('200', '500')).toBe('mismatch');
    expect(reconcileWebhookAmount('501', '500')).toBe('mismatch');
  });

  it('only an exact \'match\' is a licence to hold escrow — the canonical gate', () => {
    const verified = (amount: unknown, fee: unknown) => reconcileWebhookAmount(amount, fee) === 'match';
    expect(verified('500', '500')).toBe(true);
    expect(verified('PENDING', '500')).toBe(false);
    expect(verified(undefined, '500')).toBe(false);
    expect(verified('200', '500')).toBe(false);
  });
});

// =============================================================================
// 3. THE FAILURE CLASS — a confirmed session against an unpaid claim.
// =============================================================================
describe('3. a confirmed session whose claim is still unpaid is recoverable', () => {
  it('the fixture really does reproduce the stranded state', async () => {
    const claimId = await makeClaim(await makeItem('STRANDED'), 'STRANDED', 'pending_payment');
    const { sessionId } = await makeStrandedConfirmedSession(claimId);
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
    expect((await db.getClaim(claimId))!.status).toBe('pending_payment');
    expect((await db.getClaim(claimId))!.paid_at ?? null).toBeNull();
  });

  it('the ordinary canonical CAS repairs it: session confirmed, claim still payable', async () => {
    const claimId = await makeClaim(await makeItem('REPAIR-IN'), 'REPAIR-IN', 'pending_payment');
    const { sessionId, invoiceId } = await makeStrandedConfirmedSession(claimId);

    // Before this batch no entry point would ever have called with this invoice
    // again, so the claim could never be credited. The canonical path treats the
    // already-confirmed session as an idempotent replay and moves the claim.
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);

    const claim = await db.getClaim(claimId);
    expect(claim!.status).toBe('escrow_held');
    expect(claim!.paid_at ?? null).not.toBeNull();
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
  });

  it('repairs a SWEPT claim (payment_window_expired) through the gated edge', async () => {
    const claimId = await makeClaim(await makeItem('REPAIR-SWEPT'), 'REPAIR-SWEPT', 'pending_payment');
    const { sessionId, invoiceId } = await makeStrandedConfirmedSession(claimId);

    // The 60-second expiry sweep moves the claim while the session stays confirmed.
    expect(await db.expirePendingPaymentClaim(claimId)).toBe(true);
    expect((await db.getClaim(claimId))!.status).toBe('payment_window_expired');

    // The gate is satisfied on freshly-read facts.
    const current = (await db.getClaim(claimId))!;
    expect(canRecoverExpiredClaimPayment({
      claimStatus: current.status,
      paidAt: current.paid_at,
      paymentVerified: true,
      paymentSessionBoundToClaim: true,
      sessionConfirmed: true,
    })).toBe(true);

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true })).toBe(true);
    const claim = await db.getClaim(claimId);
    expect(claim!.status).toBe('escrow_held');
    expect(claim!.paid_at ?? null).not.toBeNull();
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
  });

  it('the DEFAULT call cannot reach the swept claim — the gate is required', async () => {
    const claimId = await makeClaim(await makeItem('GATE'), 'GATE', 'pending_payment');
    const { invoiceId } = await makeStrandedConfirmedSession(claimId);
    await db.expirePendingPaymentClaim(claimId);

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(false);
    expect((await db.getClaim(claimId))!.status).toBe('payment_window_expired');
    expect((await db.getClaim(claimId))!.paid_at ?? null).toBeNull();
  });

  it('recovers exactly ONCE — a repeat never writes payment truth twice', async () => {
    const claimId = await makeClaim(await makeItem('ONCE'), 'ONCE', 'pending_payment');
    const { invoiceId } = await makeStrandedConfirmedSession(claimId);
    await db.expirePendingPaymentClaim(claimId);

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true })).toBe(true);
    const paidAt = (await db.getClaim(claimId))!.paid_at;
    expect(paidAt ?? null).not.toBeNull();

    // A replayed delivery and a repeated recovery are both no-ops.
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true })).toBe(false);
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(false);
    expect((await db.getClaim(claimId))!.paid_at).toBe(paidAt);
  });
});

// =============================================================================
// 4. IDEMPOTENCY AND CONCURRENCY — the repair cannot double-write.
//
// Both CASes are single-winner compare-and-swaps, so this covers: the session's
// confirmation, the claim's escrow hold, the gated swept-claim recovery, and a
// replayed provider delivery. (In-memory sandbox: these prove the CAS PREDICATES
// and the outcome, not real PostgreSQL row locking.)
// =============================================================================
describe('4. duplicate and concurrent recovery cannot double-confirm', () => {
  it('the session confirmation CAS has exactly one winner', async () => {
    const claimId = await makeClaim(await makeItem('CONC-S'), 'CONC-S', 'pending_payment');
    const { sessionId } = await makeInvoicedSession(claimId, 500);

    const results = await Promise.all([
      db.attemptPaymentSessionConfirm(sessionId),
      db.attemptPaymentSessionConfirm(sessionId),
      db.attemptPaymentSessionConfirm(sessionId),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
  });

  it('concurrent repair attempts produce exactly one escrow hold', async () => {
    const claimId = await makeClaim(await makeItem('CONC-H'), 'CONC-H', 'pending_payment');
    const { invoiceId } = await makeStrandedConfirmedSession(claimId);

    const results = await Promise.all([
      db.attemptClaimEscrowHold(claimId, invoiceId),
      db.attemptClaimEscrowHold(claimId, invoiceId),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
  });

  it('concurrent GATED recovery of a swept claim produces exactly one hold', async () => {
    const claimId = await makeClaim(await makeItem('CONC-G'), 'CONC-G', 'pending_payment');
    const { invoiceId } = await makeStrandedConfirmedSession(claimId);
    await db.expirePendingPaymentClaim(claimId);

    const results = await Promise.all([
      db.attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true }),
      db.attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true }),
      db.attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
  });

  it('a replayed delivery after a completed repair is inert', async () => {
    const claimId = await makeClaim(await makeItem('REPLAY'), 'REPLAY', 'pending_payment');
    const { sessionId, invoiceId } = await makeStrandedConfirmedSession(claimId);

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);
    const paidAt = (await db.getClaim(claimId))!.paid_at;

    // The provider retries the webhook; the session CAS is already consumed and
    // the claim CAS can no longer match.
    expect(await db.attemptPaymentSessionConfirm(sessionId)).toBe(false);
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(false);
    expect((await db.getClaim(claimId))!.paid_at).toBe(paidAt);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
  });

  it('repeated repair attempts never change paid_at once it is set', async () => {
    const claimId = await makeClaim(await makeItem('STABLE'), 'STABLE', 'pending_payment');
    const { invoiceId } = await makeStrandedConfirmedSession(claimId);
    await db.expirePendingPaymentClaim(claimId);

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true })).toBe(true);
    const paidAt = (await db.getClaim(claimId))!.paid_at;
    for (let i = 0; i < 3; i++) {
      expect(await db.attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true })).toBe(false);
      expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(false);
    }
    expect((await db.getClaim(claimId))!.paid_at).toBe(paidAt);
  });
});

// =============================================================================
// 5. PRECONDITIONS — every refusal leaves the money untouched, and the ordinary
//    (non-stranded) flow is entirely unchanged.
// =============================================================================
describe('5. recovery is refused whenever a precondition fails', () => {
  it('the gated edge names exactly one legal transition', () => {
    // The edge is DATA, and it is deliberately absent from the generic
    // transition table — only the canonical payment path may pass the flag.
    expect(EXPIRED_CLAIM_PAYMENT_RECOVERY_EDGE.from).toBe('payment_window_expired');
    expect(EXPIRED_CLAIM_PAYMENT_RECOVERY_EDGE.to).toBe('escrow_held');
  });

  it('an ALREADY-PAID claim is refused by the gate and by the CAS', async () => {
    const claimId = await makeClaim(await makeItem('PREC-PAID'), 'PREC-PAID', 'pending_payment');
    const { invoiceId } = await makeInvoicedSession(claimId, 500);
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);
    const paidAt = (await db.getClaim(claimId))!.paid_at;

    const current = (await db.getClaim(claimId))!;
    expect(canRecoverExpiredClaimPayment({
      claimStatus: current.status,
      paidAt: current.paid_at,
      paymentVerified: true,
      paymentSessionBoundToClaim: true,
      sessionConfirmed: true,
    })).toBe(false);

    for (const opts of [undefined, { recoverExpiredClaim: true } as any]) {
      expect(await db.attemptClaimEscrowHold(claimId, invoiceId, opts)).toBe(false);
    }
    expect((await db.getClaim(claimId))!.paid_at).toBe(paidAt);
  });

  it('a status the gate does not cover is refused', async () => {
    // A claim that has moved on (here: released) can never be re-credited.
    const claimId = await makeClaim(await makeItem('PREC-REL'), 'PREC-REL', 'released');
    expect(canRecoverExpiredClaimPayment({
      claimStatus: 'released', paidAt: null, paymentVerified: true,
      paymentSessionBoundToClaim: true, sessionConfirmed: true,
    })).toBe(false);
    expect(await db.attemptClaimEscrowHold(claimId, 'INV-CSR-NEVER', { recoverExpiredClaim: true })).toBe(false);
    expect((await db.getClaim(claimId))!.status).toBe('released');
  });

  it('a session that cannot be confirmed refuses the hold BEFORE any write', async () => {
    const claimId = await makeClaim(await makeItem('PREC-FAILED'), 'PREC-FAILED', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);
    // The provider reported a failure: the session keeps its invoice but can
    // never be confirmed, so holding the claim now would strand payment truth.
    expect(await db.markPaymentSessionFailed(sessionId, 'provider declined')).toBe(true);
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('failed');

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(false);
    expect((await db.getClaim(claimId))!.status).toBe('pending_payment');
    expect((await db.getClaim(claimId))!.paid_at ?? null).toBeNull();
    // No session confirmation was stolen by the failed attempt either.
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('failed');
  });

  it('an invoice bound to a DIFFERENT claim can never credit this one', async () => {
    const itemA = await makeItem('PREC-X-A');
    const itemB = await makeItem('PREC-X-B');
    const claimA = await makeClaim(itemA, 'PREC-X-A', 'pending_payment');
    const claimB = await makeClaim(itemB, 'PREC-X-B', 'pending_payment');
    const { invoiceId } = await makeStrandedConfirmedSession(claimA);

    // Claim B is untouched: the invoice belongs to A.
    expect(await db.attemptClaimEscrowHold(claimB, invoiceId)).toBe(false);
    expect((await db.getClaim(claimB))!.status).toBe('pending_payment');
    expect((await db.getClaim(claimB))!.paid_at ?? null).toBeNull();
  });
});

// =============================================================================
// 5b. THE LEGACY / ORDINARY FLOW IS UNCHANGED (no regression from the widening).
// =============================================================================
describe('5b. the ordinary flow is unchanged by the widening', () => {
  it('a claim that was never stranded still confirms exactly as before', async () => {
    const claimId = await makeClaim(await makeItem('LEGACY-OK'), 'LEGACY-OK', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);

    // Never confirmed early: the ordinary path is the one that consumes it.
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('pending');
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
  });

  it('a swept claim with an UNCONFIRMED session still recovers via the gate', async () => {
    const claimId = await makeClaim(await makeItem('LEGACY-LATE'), 'LEGACY-LATE', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);
    // The local STK window lapsed while the claim stayed payable.
    expect(await db.expirePaymentSession(sessionId)).toBe(true);
    expect(await db.expirePendingPaymentClaim(claimId)).toBe(true);

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true })).toBe(true);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
  });

  it('a session that never reached the provider is still not selectable', async () => {
    // `created` carries no provider invoice, so no reconciliation is possible —
    // the shared predicate refuses it rather than inventing an attempt.
    const claimId = await makeClaim(await makeItem('LEGACY-CREATED'), 'LEGACY-CREATED', 'pending_payment');
    const sessionId = nextId('TEST-PS-CSR-CREATED');
    await db.createPaymentSession({
      id: sessionId, claimId, amount: 500, payerPhone: '+254700000001',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    const session = (await db.getPaymentSessionById(sessionId))!;
    expect(session.status).toBe('created');
    expect(session.provider_invoice_id ?? null).toBeNull();
    expect(isPaymentReconciliationEligible({
      claimStatus: 'pending_payment',
      paidAt: null,
      sessionStatus: session.status,
      hasProviderInvoice: !!session.provider_invoice_id,
    })).toBe(false);
  });
});

// =============================================================================
// 6. ATOMICITY — the claim CAS and the session CAS are ONE outcome.
//
// `claims.paid_at IS NOT NULL` and `payment_sessions.status = 'confirmed'` must
// always agree for a claim that was paid. The two writes are performed inside one
// `drizzleDb.transaction`, with the claim CAS FIRST and a session CAS that THROWS
// on loss, so a paid claim can never exist without its session confirmation.
// =============================================================================
describe('6. the claim CAS and the session CAS are one outcome', () => {
  it('a session is validated BEFORE the claim moves, so nothing is half-written', async () => {
    const claimId = await makeClaim(await makeItem('ATOMIC-PRE'), 'ATOMIC-PRE', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);
    // An unconfirmable session: the refusal must happen with the claim untouched,
    // i.e. there is no partial write to undo.
    await db.markPaymentSessionFailed(sessionId, 'provider declined');

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(false);
    expect((await db.getClaim(claimId))!.status).toBe('pending_payment');
    expect((await db.getClaim(claimId))!.paid_at ?? null).toBeNull();
  });

  it('never commits a paid claim without its session confirmation', async () => {
    const claimId = await makeClaim(await makeItem('ATOMIC-ONE'), 'ATOMIC-ONE', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);
    const claim = (await db.getClaim(claimId))!;
    const session = (await db.getPaymentSessionById(sessionId))!;

    // Both sides of the same financial fact, together.
    expect(claim.status).toBe('escrow_held');
    expect(claim.paid_at ?? null).not.toBeNull();
    expect(session.status).toBe('confirmed');
    expect(session.confirmed_at ?? null).not.toBeNull();
    // ...and the session really is the one the claim recorded as its payment.
    expect(session.provider_invoice_id).toBe(invoiceId);
    expect(claim.payment_reference).toBe(invoiceId);
  });

  it('an idempotent replay does not re-confirm a session (nothing new is written)', async () => {
    const claimId = await makeClaim(await makeItem('ATOMIC-REPLAY'), 'ATOMIC-REPLAY', 'pending_payment');
    const { sessionId, invoiceId } = await makeStrandedConfirmedSession(claimId);
    const firstConfirmedAt = (await db.getPaymentSessionById(sessionId))!.confirmed_at;

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);
    const after = (await db.getPaymentSessionById(sessionId))!;
    // Already-confirmed sessions take the idempotent branch: the confirmation
    // timestamp is NOT refreshed, so the original event stays auditable.
    expect(after.status).toBe('confirmed');
    expect(after.confirmed_at).toEqual(firstConfirmedAt);
  });

  it('a cross-claim invoice refuses without touching either claim', async () => {
    const claimA = await makeClaim(await makeItem('ATOMIC-X-A'), 'ATOMIC-X-A', 'pending_payment');
    const claimB = await makeClaim(await makeItem('ATOMIC-X-B'), 'ATOMIC-X-B', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimA, 500);

    expect(await db.attemptClaimEscrowHold(claimB, invoiceId)).toBe(false);
    // Neither claim moved, and the session is still unconsumed for A.
    expect((await db.getClaim(claimA))!.status).toBe('pending_payment');
    expect((await db.getClaim(claimB))!.status).toBe('pending_payment');
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('pending');
  });
});

// =============================================================================
// 7. SETTLEMENT PROTECTION — a RECOVERED payment settles once, and only once.
//
// The recovery path writes nothing new into the settlement lifecycle: it produces
// an ordinary `escrow_held` claim with `paid_at` set, and the pre-existing
// settlement guards then apply to it unchanged.
// =============================================================================
async function makeAgent(suffix: string) {
  const id = nextId(`TEST-AGENT-CSR-${suffix}`);
  await db.createAgent({
    id, business_name: 'Test Recovery Hub',
    contact_phone: `+2548${testRunId}${String(suffix.charCodeAt(0))}`,
    location_address: 'Test location', latitude: null, longitude: null,
    mpesa_till_or_paybill: `8${testRunId}${String(suffix.charCodeAt(0))}`,
    payout_method_type: 'Till Number', status: 'active', refundable_deposit: 0,
    national_id_hash: 'test-hash-csr', needs_manual_geocoding: false,
  } as any);
  return id;
}

async function makePricedCategory(suffix: string) {
  const id = nextId(`test-cat-csr-${suffix}`);
  await db.createCategory({
    id, name_en: 'Test Recovery Category', name_sw: 'Kategoria ya Urejeshaji',
    total_fee: 1000, finder_share: 250, agent_share: 350, platform_share: 400,
    is_sensitive_document: false,
  });
  return id;
}

/** An item with a locked 1000/250/350/400 split and an assigned agent. */
async function makeSettleableItem(suffix: string) {
  const categoryId = await makePricedCategory(suffix);
  const agentId = await makeAgent(suffix);
  const itemId = nextId(`TEST-ITEM-CSR-SETTLE-${suffix}`);
  await db.createItem({
    id: itemId, category_id: categoryId, photo_url: 'test-photo.jpg', ocr_extracted_number: null,
    ocr_extracted_name: null, document_number_hash: null, document_name_fuzzy: null,
    location_description: 'Test location', latitude: null, longitude: null,
    finder_phone: '+254700000041', assigned_agent_id: agentId, status: 'at_agent',
    flaggedForReview: false, isDescriptionOnly: false, description: null,
    is_sensitive_document: false, rejection_reason: null,
    locked_total_fee: 1000, locked_finder_share: 250, locked_agent_share: 350, locked_platform_share: 400,
  } as any);
  return { itemId, agentId, categoryId };
}

/** A claim whose payment was RECOVERED from `payment_window_expired`. */
async function makeRecoveredPaidClaim(suffix: string) {
  const { itemId, agentId, categoryId } = await makeSettleableItem(suffix);
  const claimId = await makeClaim(itemId, suffix, 'pending_payment');
  const { invoiceId } = await makeStrandedConfirmedSession(claimId);
  await db.expirePendingPaymentClaim(claimId);
  expect(await db.attemptClaimEscrowHold(claimId, invoiceId, { recoverExpiredClaim: true })).toBe(true);
  expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
  return { claimId, itemId, agentId, categoryId };
}

describe('7. a recovered payment settles exactly once, on the existing terms', () => {
  it('books the three payout rows once and keeps the 48-hour dispute window', async () => {
    const { claimId } = await makeRecoveredPaidClaim('SETTLE-A');
    const before = Date.now();
    const settlement = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
    expect(settlement.success, settlement.message).toBe(true);

    const claim = (await db.getClaim(claimId))!;
    expect(claim.status).toBe('pending_settlement');
    // The 48-hour protection is intact: settle_at is ~now + 48h, not shortened.
    const settleAt = new Date(claim.settle_at as any).getTime();
    expect(settleAt - before).toBeGreaterThanOrEqual(DISPUTE_WINDOW_MS - 5000);
    expect(settleAt - before).toBeLessThanOrEqual(DISPUTE_WINDOW_MS + 5000);

    const entries = await db.getLedgerEntriesForClaim(claimId);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.type).sort()).toEqual(['agent_payout', 'finder_payout', 'platform_fee']);
    // The LOCKED values are authoritative; the category's own shares were not
    // used to invent a different split.
    const byType = (t: string) => entries.find((e) => e.type === t)!;
    expect(Number(byType('finder_payout').amount)).toBe(250);
    expect(Number(byType('agent_payout').amount)).toBe(350);
    expect(Number(byType('platform_fee').amount)).toBe(400);
    // Every row starts pending — nothing has disbursed yet.
    expect(entries.every((e) => e.status === 'pending')).toBe(true);
  });

  it('a retried settlement attempt books nothing further (no duplicate booking)', async () => {
    const { claimId } = await makeRecoveredPaidClaim('SETTLE-B');
    expect((await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS)).success).toBe(true);
    expect(await db.getLedgerEntriesForClaim(claimId)).toHaveLength(3);

    const second = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
    expect(second.success, 'a repeat must lose the compare-and-swap').toBe(false);
    expect(await db.getLedgerEntriesForClaim(claimId)).toHaveLength(3);
  });

  it('cannot be released before the dispute window has elapsed (no acceleration)', async () => {
    const { claimId } = await makeRecoveredPaidClaim('SETTLE-C');
    expect((await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS)).success).toBe(true);
    // Not forced: the guard must refuse while settle_at is in the future.
    expect(await db.attemptSettlementRelease(claimId, false)).toBe(false);
    expect((await db.getClaim(claimId))!.status).toBe('pending_settlement');
  });
});

describe('7b. the recovered claim completes the ordinary settlement lifecycle', () => {
  it('cannot be finalized before the payouts are genuinely completed', async () => {
    const { claimId } = await makeRecoveredPaidClaim('FIN-GUARD');
    await db.enterPendingSettlement(claimId, -1000);
    expect(await db.attemptSettlementRelease(claimId, false)).toBe(true);

    // Nothing has actually disbursed yet, so finalize must refuse.
    const refused = await db.finalizeSettlement(claimId);
    expect(refused.success).toBe(false);
    expect((await db.getClaim(claimId))!.status).toBe('releasing');
  });

  it('finalizes exactly once, even on a concurrent retry', async () => {
    const { claimId } = await makeRecoveredPaidClaim('FIN-ONCE');
    await db.enterPendingSettlement(claimId, -1000);
    expect(await db.attemptSettlementRelease(claimId, false)).toBe(true);

    // The provider confirmed both recipients (what executeClaimSettlement records).
    for (const type of ['finder_payout', 'agent_payout']) {
      const row = (await db.getLedgerEntriesForClaim(claimId)).find((e) => e.type === type)!;
      await db.recordPayoutAttempt(row.id, {
        status: 'success', providerBatchId: 'BATCH-CSR', providerTransactionId: `TXN-CSR-${type}`,
      });
    }

    const [first, second] = await Promise.all([
      db.finalizeSettlement(claimId),
      db.finalizeSettlement(claimId),
    ]);
    expect([first.success, second.success].filter(Boolean)).toHaveLength(1);
    expect((await db.getClaim(claimId))!.status).toBe('released');

    // finalizeSettlement marks the existing rows; it never inserts new ones.
    const finalRows = await db.getLedgerEntriesForClaim(claimId);
    expect(finalRows).toHaveLength(3);
    expect(finalRows.every((r) => r.status === 'completed')).toBe(true);
  });

  it('the recovered claim carries the item lock it was priced with', async () => {
    const { claimId, itemId } = await makeRecoveredPaidClaim('FIN-LOCK');
    const item = (await db.getItem(itemId))!;
    expect(Number(item.locked_total_fee)).toBe(1000);
    expect(Number(item.locked_finder_share)).toBe(250);
    expect(Number(item.locked_agent_share)).toBe(350);
    expect(Number(item.locked_platform_share)).toBe(400);
    // ...and the atomic recovery is what set the payment marker.
    expect((await db.getClaim(claimId))!.paid_at ?? null).not.toBeNull();
  });

  it('a refund path is still refused for a recovered, already-released claim', async () => {
    const { claimId } = await makeRecoveredPaidClaim('FIN-TERM');
    await db.enterPendingSettlement(claimId, -1000);
    expect(await db.attemptSettlementRelease(claimId, false)).toBe(true);
    for (const type of ['finder_payout', 'agent_payout']) {
      const row = (await db.getLedgerEntriesForClaim(claimId)).find((e) => e.type === type)!;
      await db.recordPayoutAttempt(row.id, {
        status: 'success', providerBatchId: 'BATCH-CSR2', providerTransactionId: `TXN-CSR2-${type}`,
      });
    }
    expect((await db.finalizeSettlement(claimId)).success).toBe(true);

    const claim = (await db.getClaim(claimId))!;
    // A completed lifecycle is terminal: the widened reconciliation predicate
    // must never select it again, regardless of what the session says.
    expect(isPaymentReconciliationEligible({
      claimStatus: claim.status, paidAt: claim.paid_at,
      sessionStatus: 'confirmed', hasProviderInvoice: true,
    })).toBe(false);
    expect(paymentReconciliationRefusal({
      claimStatus: claim.status, paidAt: claim.paid_at,
      sessionStatus: 'confirmed', hasProviderInvoice: true,
    })).toBe('claim_already_paid');
  });
});


