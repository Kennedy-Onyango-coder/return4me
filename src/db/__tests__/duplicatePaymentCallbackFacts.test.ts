import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// =============================================================================
// GATE C / STAGE C1 - THE DUPLICATE-CALLBACK FACTS.
//
// The canonical confirmation path now distinguishes three decisions, and the
// duplicate/refused distinction is decided from ONE freshly-read fact:
// `claims.paid_at`. `already_reconciled` is returned when a lost compare-and-swap
// finds `paid_at` already set (an earlier delivery settled the collection);
// `claim_not_payable` is returned when it does not.
//
// This file proves the DATABASE FACTS that classification rests on, against the
// same in-memory sandbox the rest of this suite uses:
//
//   * the first delivery wins the CAS and stamps `paid_at` (so a later delivery
//     can recognise itself as a duplicate);
//   * a repeated callback loses the CAS, writes NOTHING a second time - no second
//     escrow hold, no second session confirmation, no second payment session -
//     and `paid_at` is byte-identical afterwards;
//   * a claim that cannot be paid keeps `paid_at` NULL, so a refusal is never
//     mistaken for a duplicate;
//   * the invoice-bound session's single confirmation is consumed exactly once.
//
// No provider call, no money. The route-level acknowledgement is pinned in
// src/__tests__/webhookCollectionAcknowledgementC1.test.ts.
// =============================================================================

let counter = 0;

async function makeItem(suffix: string) {
  const itemId = `TEST-ITEM-C1-${suffix}-${testRunId}-${counter++}`;
  await ensureTestCategory('phone');
  await db.createItem({
    id: itemId, category_id: 'phone', photo_url: 'test-photo.jpg', ocr_extracted_number: null,
    ocr_extracted_name: null, document_number_hash: null, document_name_fuzzy: null,
    location_description: 'x', latitude: null, longitude: null, finder_phone: '+254700000012',
    assigned_agent_id: null, status: 'at_agent', flaggedForReview: false, isDescriptionOnly: true,
    description: 'x', is_sensitive_document: false, rejection_reason: null, locked_total_fee: '500',
  } as any);
  return itemId;
}

async function makeClaim(itemId: string, suffix: string, status: string) {
  const claimId = `TEST-CLAIM-C1-${suffix}-${testRunId}-${counter++}`;
  await db.createClaim({
    id: claimId, item_id: itemId, owner_phone: `+2547002${String(counter).padStart(5, '0')}`,
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'fixture' },
    verification_tier: 1, status: status as any, owner_id_proof_url: null,
    payment_reference: null, owner_identifying_details: null,
  } as any);
  return claimId;
}

/** The real initiation path: created -> reserved -> invoice bound -> pending. */
async function makeInvoicedSession(claimId: string, amount: number) {
  const sessionId = `TEST-PS-C1-${testRunId}-${counter++}`;
  const invoiceId = `INV-C1-${testRunId}-${counter}`;
  await db.createPaymentSession({
    id: sessionId, claimId, amount, payerPhone: '+254700000002',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  expect(await db.reservePaymentSession(sessionId, claimId)).toBe(true);
  expect(await db.finalizePaymentSessionInitiated(sessionId, invoiceId, 'MPESA-REF')).toBe(true);
  return { sessionId, invoiceId };
}

describe('C1 - what a duplicate delivery finds, and what it must not change', () => {
  it('the first delivery stamps paid_at, which is how a duplicate recognises itself', async () => {
    const itemId = await makeItem('FIRST');
    const claimId = await makeClaim(itemId, 'FIRST', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);

    const claim: any = await db.getClaim(claimId);
    expect(claim.status).toBe('escrow_held');
    // THE fact the C1 duplicate classification reads.
    expect(claim.paid_at ?? null).not.toBeNull();
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
  });

  it('a repeated callback loses the CAS and changes nothing at all', async () => {
    const itemId = await makeItem('DUP');
    const claimId = await makeClaim(itemId, 'DUP', 'pending_payment');
    const { sessionId, invoiceId } = await makeInvoicedSession(claimId, 500);

    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(true);
    const afterFirst: any = await db.getClaim(claimId);
    const sessionsAfterFirst = await db.listPaymentSessionsForClaim(claimId);

    // The duplicate delivery: the provider redelivers the SAME callback.
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(false);

    const afterSecond: any = await db.getClaim(claimId);
    expect(afterSecond.status).toBe('escrow_held');
    // paid_at is IDENTICAL (not re-stamped): no second collection was booked.
    expect(String(afterSecond.paid_at)).toBe(String(afterFirst.paid_at));
    // No second escrow hold, no second payment session row.
    expect((await db.listPaymentSessionsForClaim(claimId)).length).toBe(sessionsAfterFirst.length);
    // The session's single confirmation was already consumed and stays consumed.
    expect((await db.getPaymentSessionById(sessionId))!.status).toBe('confirmed');
    expect(await db.attemptPaymentSessionConfirm(sessionId)).toBe(false);
    // ...so the duplicate still reads as `already_reconciled`, never as a
    // `claim_not_payable` refusal.
    expect(afterSecond.paid_at ?? null).not.toBeNull();
  });

  it('a claim that cannot be paid keeps paid_at NULL, so a refusal is never read as a duplicate', async () => {
    const itemId = await makeItem('REFUSED');
    const claimId = await makeClaim(itemId, 'REFUSED', 'rejected');
    const { invoiceId } = await makeInvoicedSession(claimId, 500);

    // The CAS cannot win from 'rejected' with no recovery flag: the canonical
    // path reports `claim_not_payable` (409), not success and not a duplicate.
    expect(await db.attemptClaimEscrowHold(claimId, invoiceId)).toBe(false);

    const claim: any = await db.getClaim(claimId);
    expect(claim.status).toBe('rejected');
    expect(claim.paid_at ?? null).toBeNull();
  });

  it('an invoice bound to ANOTHER claim can never hold this one (cross-claim isolation)', async () => {
    const itemId = await makeItem('CROSS');
    const victimClaimId = await makeClaim(itemId, 'CROSS-VICTIM', 'pending_payment');
    const otherClaimId = await makeClaim(itemId, 'CROSS-OTHER', 'pending_payment');
    const { invoiceId } = await makeInvoicedSession(otherClaimId, 500);

    // The invoice belongs to `otherClaimId`; using it for the victim claim must
    // be refused with nothing written on either side.
    expect(await db.attemptClaimEscrowHold(victimClaimId, invoiceId)).toBe(false);

    const victim: any = await db.getClaim(victimClaimId);
    expect(victim.status).toBe('pending_payment');
    expect(victim.paid_at ?? null).toBeNull();
    const other: any = await db.getClaim(otherClaimId);
    expect(other.status).toBe('pending_payment');
    expect(other.paid_at ?? null).toBeNull();
  });
});
