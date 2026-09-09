import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// REGRESSION TEST — audit finding C1 (payment-expiry sweep vs webhook race).
//
// The expiry sweep (expireStaleClaims) previously expired a claim with an
// UNCONDITIONAL status write (db.updateClaimStatus -> UPDATE ... WHERE id=?)
// with no guard on the claim's current status. A webhook that confirmed the
// payment (CAS: pending_payment -> escrow_held) could commit between the
// sweep's snapshot read and its write, and the sweep would then clobber the
// paid claim back to 'payment_window_expired' — a real, received payment shown
// as expired, a spurious payment strike, and a double-charge risk.
//
// The fix is db.expirePendingPaymentClaim: an atomic compare-and-swap guarded
// on status='pending_payment'. A deterministic interleaving is impossible in a
// single-threaded in-memory mock, so these tests verify the guard itself in
// both orderings — which is exactly the property that prevents the race:
//   * webhook-wins-first: expiry must NOT clobber a claim already escrow_held
//   * expiry-wins-first:  expiry transitions only pending_payment and is
//     idempotent (a later expiry is a no-op; a later webhook CAS would no-op)

describe('payment expiry is race-safe against a concurrent payment webhook (C1)', () => {
  const itemA = `TEST-ITEM-EXPIRY-A-${testRunId}`;
  const itemB = `TEST-ITEM-EXPIRY-B-${testRunId}`;
  const claimA = `TEST-CLAIM-EXPIRY-A-${testRunId}`;
  const claimB = `TEST-CLAIM-EXPIRY-B-${testRunId}`;

  beforeAll(async () => {
    await ensureTestCategory('phone');
    // One item + one pending_payment claim each (the DB unique index allows
    // only one active claim per item on real Postgres).
    for (const [itemId, claimId] of [[itemA, claimA], [itemB, claimB]]) {
      await db.createItem({
        id: itemId,
        category_id: 'phone',
        photo_url: 'test-photo.jpg',
        ocr_extracted_number: null,
        ocr_extracted_name: null,
        document_number_hash: null,
        document_name_fuzzy: null,
        location_description: 'Test location',
        latitude: null,
        longitude: null,
        finder_phone: '+254700000007',
        assigned_agent_id: null,
        status: 'at_agent',
        flaggedForReview: false,
        isDescriptionOnly: false,
        description: null,
        is_sensitive_document: false,
        rejection_reason: null,
      } as any);
      await db.createClaim({
        id: claimId,
        item_id: itemId,
        owner_phone: '+254700000008',
        security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
        verification_tier: 1,
        status: 'pending_payment',
        owner_id_proof_url: null,
        payment_reference: null,
        owner_identifying_details: null,
      });
    }
  });

  it('webhook-wins-first: a claim already confirmed paid (escrow_held) can never be expired by the sweep', async () => {
    // Simulate the webhook's compare-and-swap committing BEFORE the sweep writes:
    // the claim moves pending_payment -> escrow_held (money received).
    await db.updateClaimStatus(claimA, 'escrow_held');
    const paid = await db.getClaim(claimA);
    expect(paid?.status).toBe('escrow_held');

    // The sweep now tries to expire it. Because the CAS guard requires
    // status='pending_payment', it must NOT match, must NOT clobber escrow_held,
    // and must NOT report that it expired anything.
    const expired = await db.expirePendingPaymentClaim(claimA);
    expect(expired).toBe(false);
    const after = await db.getClaim(claimA);
    expect(after?.status).toBe('escrow_held');
  });

  it('expiry-wins-first: expiry transitions only a pending_payment claim and is idempotent (no double expiry, no double strike)', async () => {
    // Still pending_payment -> the sweep legitimately wins the race.
    const first = await db.expirePendingPaymentClaim(claimB);
    expect(first).toBe(true);
    const expiredClaim = await db.getClaim(claimB);
    expect(expiredClaim?.status).toBe('payment_window_expired');

    // A second expiry attempt is a no-op (returns false) so a retry/double run
    // of the sweep can never record the strike twice.
    const second = await db.expirePendingPaymentClaim(claimB);
    expect(second).toBe(false);
    expect((await db.getClaim(claimB))?.status).toBe('payment_window_expired');
  });
});
