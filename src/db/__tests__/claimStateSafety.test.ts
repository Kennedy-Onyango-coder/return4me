import { describe, it, expect } from 'vitest';
import { db, ClaimStateConflictError } from '../database';
import {
  isAllowedClaimTransition,
  TERMINAL_CLAIM_STATUSES,
  CLAIM_SLOT_EXCLUDED_STATUSES,
} from '../../config/claimStatuses';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// =============================================================================
// PHASE 6C — CLAIM DOMAIN / PAYMENT / STATE SAFETY
// =============================================================================
// Regression coverage for SC-4/SC-6 (payment truth), SC-1/SC-2 (lifecycle guard
// + central transition contract), SC-3 (dispute snapshot), SC-5 (refund/item
// invariant) and SC-7 (canonical slot predicate).
//
// These run against the same in-memory sandbox the rest of this suite uses.
// They prove the LOGIC and the guards; they do NOT prove real PostgreSQL
// concurrency or partial-index behaviour (see the Phase 6C report).

let counter = 0;

async function makeItem(suffix: string) {
  const itemId = `TEST-ITEM-6C-${suffix}-${testRunId}-${counter++}`;
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
  const claimId = `TEST-CLAIM-6C-${suffix}-${testRunId}-${counter++}`;
  await db.createClaim({
    id: claimId, item_id: itemId, owner_phone: `+2547000${String(counter).padStart(5, '0')}`,
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'fixture' },
    verification_tier: 1, status: status as any, owner_id_proof_url: null,
    payment_reference: null, owner_identifying_details: null,
  } as any);
  return claimId;
}

// ---------------------------------------------------------------------------
// SC-4 / SC-6 — PAYMENT TRUTH
// ---------------------------------------------------------------------------
describe('SC-4/SC-6: paid_at is the ONE authoritative payment truth', () => {
  it('a claim can never be CREATED already-paid', async () => {
    const itemId = await makeItem('CREATE');
    const claimId = `TEST-CLAIM-6C-CREATEPAID-${testRunId}`;
    await db.createClaim({
      id: claimId, item_id: itemId, owner_phone: '+254700000021',
      security_answers: { lastDigits: '0000' }, verification_tier: 1,
      status: 'escrow_held', owner_id_proof_url: null,
      payment_reference: 'FORGED-REF', owner_identifying_details: null,
    } as any);
    const claim = await db.getClaim(claimId);
    expect(claim!.paid_at ?? null).toBeNull();
  });

  it('payment INITIATION does not set paid_at (the legacy /pay misuse)', async () => {
    const itemId = await makeItem('INIT');
    const claimId = await makeClaim(itemId, 'INIT', 'pending_payment');
    // Exactly what /pay used to do: write the provider checkout request id into
    // payment_reference while the claim is still unpaid.
    await db.updateClaimStatus(claimId, 'pending_payment', 'CHECKOUT-REQUEST-ID-123');
    const claim = await db.getClaim(claimId);
    expect(claim!.payment_reference).toBe('CHECKOUT-REQUEST-ID-123');
    expect(claim!.paid_at ?? null).toBeNull(); // NOT paid
  });

  it('a non-payment message in payment_reference is not payment truth', async () => {
    const itemId = await makeItem('MSG');
    const claimId = await makeClaim(itemId, 'MSG', 'disputed');
    await db.updateClaimStatus(claimId, 'disputed', 'System Auto-Rejected: another claimant paid first.');
    const claim = await db.getClaim(claimId);
    expect(claim!.payment_reference).toContain('System Auto-Rejected');
    expect(claim!.paid_at ?? null).toBeNull();
  });

  it('authoritative confirmation sets paid_at exactly once', async () => {
    const itemId = await makeItem('ESCROW');
    const claimId = await makeClaim(itemId, 'ESCROW', 'pending_payment');

    expect(await db.attemptClaimEscrowHold(claimId, 'MPESA-RECEIPT-1')).toBe(true);
    const paid = await db.getClaim(claimId);
    expect(paid!.status).toBe('escrow_held');
    expect(paid!.paid_at).toBeTruthy();

    // Duplicate webhook / repeat call: the CAS only matches pending_payment.
    expect(await db.attemptClaimEscrowHold(claimId, 'MPESA-RECEIPT-DUPLICATE')).toBe(false);
    expect((await db.getClaim(claimId))!.paid_at).toBe(paid!.paid_at);
  });

  it('a claim that is NOT pending_payment cannot be confirmed paid', async () => {
    const itemId = await makeItem('WRONGSTATE');
    const claimId = await makeClaim(itemId, 'WRONGSTATE', 'pending_verification');
    expect(await db.attemptClaimEscrowHold(claimId, 'MPESA-RECEIPT-X')).toBe(false);
    const claim = await db.getClaim(claimId);
    expect(claim!.paid_at ?? null).toBeNull();
    expect(claim!.status).toBe('pending_verification');
  });
});


// ---------------------------------------------------------------------------
// SC-2 / SC-1 — CANONICAL TRANSITION TABLE + CENTRAL CONTRACT
// ---------------------------------------------------------------------------
describe('SC-2: canonical transition table', () => {
  it('permits only the documented forward edges', () => {
    expect(isAllowedClaimTransition('pending_verification', 'awaiting_agent_confirmation')).toBe(true);
    expect(isAllowedClaimTransition('awaiting_agent_confirmation', 'pending_payment')).toBe(true);
    expect(isAllowedClaimTransition('pending_payment', 'escrow_held')).toBe(true);
    expect(isAllowedClaimTransition('escrow_held', 'pending_settlement')).toBe(true);
    expect(isAllowedClaimTransition('pending_settlement', 'releasing')).toBe(true);
    expect(isAllowedClaimTransition('releasing', 'released')).toBe(true);
    expect(isAllowedClaimTransition('releasing', 'pending_settlement')).toBe(true);
    expect(isAllowedClaimTransition('disputed', 'refunding')).toBe(true);
    expect(isAllowedClaimTransition('refunding', 'refunded')).toBe(true);
  });

  it('refuses every backward / undocumented edge', () => {
    expect(isAllowedClaimTransition('escrow_held', 'pending_verification')).toBe(false);
    expect(isAllowedClaimTransition('pending_payment', 'pending_verification')).toBe(false);
    expect(isAllowedClaimTransition('awaiting_agent_confirmation', 'pending_verification')).toBe(false);
    expect(isAllowedClaimTransition('pending_settlement', 'escrow_held')).toBe(false);
    expect(isAllowedClaimTransition('released', 'pending_verification')).toBe(false);
  });

  it('terminal states have NO outgoing edges at all', () => {
    for (const terminal of TERMINAL_CLAIM_STATUSES) {
      expect(isAllowedClaimTransition(terminal, 'pending_verification')).toBe(false);
      expect(isAllowedClaimTransition(terminal, 'escrow_held')).toBe(false);
      expect(isAllowedClaimTransition(terminal, 'disputed')).toBe(false);
      expect(isAllowedClaimTransition(terminal, terminal)).toBe(false);
    }
  });

  it('SC-1: a completed claim can never be pushed back to awaiting_agent_confirmation', async () => {
    const itemId = await makeItem('REGRESS');
    const claimId = await makeClaim(itemId, 'REGRESS', 'pending_payment');
    await db.attemptClaimEscrowHold(claimId, 'MPESA-RECEIPT-REGRESS'); // -> escrow_held

    const attempted = await db.transitionClaimStatus({
      claimId,
      expected: ['pending_verification'],       // what the old route assumed
      to: 'awaiting_agent_confirmation',
      actor: 'CLAIMANT',
      action: 'CLAIM_OTP_VERIFIED',
      details: 'should never be applied',
    });
    expect(attempted.ok).toBe(false);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
  });

  it('enforces the declared expected state and reports STATE_CONFLICT', async () => {
    const itemId = await makeItem('CAS');
    const claimId = await makeClaim(itemId, 'CAS', 'awaiting_agent_confirmation');

    const wrongExpectation = await db.transitionClaimStatus({
      claimId,
      expected: ['pending_verification'],       // claim is actually awaiting_agent_confirmation
      to: 'awaiting_agent_confirmation',
      actor: 'TEST',
      action: 'TEST',
      details: 'test',
    });
    expect(wrongExpectation.ok).toBe(false);
    if (!wrongExpectation.ok) expect(wrongExpectation.code).toBe('STATE_CONFLICT');

    const right = await db.transitionClaimStatus({
      claimId,
      expected: ['awaiting_agent_confirmation'],
      to: 'pending_payment',
      actor: 'TEST',
      action: 'TEST_TRANSITION',
      details: 'test',
    });
    expect(right.ok).toBe(true);
    expect((await db.getClaim(claimId))!.status).toBe('pending_payment');
  });

  it('is an idempotent no-op when already in the target state', async () => {
    const itemId = await makeItem('NOOP');
    const claimId = await makeClaim(itemId, 'NOOP', 'pending_payment');
    const noop = await db.transitionClaimStatus({
      claimId, expected: ['pending_payment'], to: 'pending_payment',
      actor: 'TEST', action: 'TEST_NOOP', details: 'test',
    });
    expect(noop.ok).toBe(true);
    if (noop.ok) expect(noop.alreadyInState).toBe(true);
  });

  it('refuses an illegal edge even when the expected state matches', async () => {
    const itemId = await makeItem('ILLEGAL');
    const claimId = await makeClaim(itemId, 'ILLEGAL', 'escrow_held');
    const bad = await db.transitionClaimStatus({
      claimId, expected: ['escrow_held'], to: 'pending_verification',
      actor: 'TEST', action: 'TEST_ILLEGAL', details: 'test',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('INVALID_TRANSITION');
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
  });
});

// ---------------------------------------------------------------------------
// SC-3 / SC-8 — DISPUTE SNAPSHOT + DISPUTE PAYMENT SEMANTICS
// ---------------------------------------------------------------------------
describe('SC-3/dispute semantics: snapshot + paid_at-driven outcomes', () => {
  async function makeDisputePair(loserPaid: boolean, suffix: string) {
    const itemId = await makeItem(suffix);
    const loserClaimId = await makeClaim(itemId, `${suffix}-LOSER`, 'pending_payment');
    if (loserPaid) {
      expect(await db.attemptClaimEscrowHold(loserClaimId, `MPESA-${suffix}`)).toBe(true);
    }
    const winnerClaimId = await makeClaim(itemId, `${suffix}-WINNER`, 'disputed');
    const disputeId = `TEST-DSP-6C-${suffix}-${testRunId}`;
    const dispute = await db.createDispute({
      id: disputeId, item_id: itemId,
      claimant_1_claim_id: winnerClaimId, claimant_2_claim_id: loserClaimId,
      claimant_1_id_proof_url: 'p1', claimant_2_id_proof_url: 'p2',
      resolved_by: null, resolved_claim_id: null, resolved_at: null, admin_notes: null,
    } as any);
    return { itemId, winnerClaimId, loserClaimId, disputeId: dispute.id, dispute };
  }

  it('captures each claimant status and payment truth BEFORE the disputed overwrite', async () => {
    const { dispute, winnerClaimId, loserClaimId } = await makeDisputePair(true, 'SNAP');
    expect(dispute.claimant_1_claim_id).toBe(winnerClaimId);      // claimant_1 = original
    expect(dispute.claimant_2_claim_id).toBe(loserClaimId);       // claimant_2 = contesting
    expect(dispute.claimant_2_status_at_dispute).toBe('escrow_held');
    expect(dispute.claimant_2_paid_at_dispute).toBeTruthy();
    expect(dispute.claimant_1_paid_at_dispute ?? null).toBeNull();
    expect((await db.getClaim(loserClaimId))!.status).toBe('disputed');
  });

  it('an UNPAID loser is rejected and creates NO refund obligation', async () => {
    const { disputeId, winnerClaimId, loserClaimId } = await makeDisputePair(false, 'UNPAID');
    const result = await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'notes');
    expect(result.refundNeededForClaimId).toBeNull();
    expect(result.refundAmount).toBeNull();
    expect((await db.getClaim(loserClaimId))!.status).toBe('rejected');
    expect((await db.getClaim(winnerClaimId))!.status).toBe('pending_verification');
  });

  it('a PAID loser is locked into refunding with the refund details returned', async () => {
    const { disputeId, winnerClaimId, loserClaimId } = await makeDisputePair(true, 'PAID');
    const result = await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'notes');
    expect(result.refundNeededForClaimId).toBe(loserClaimId);
    expect(result.refundAmount).toBeTruthy();
    expect((await db.getClaim(loserClaimId))!.status).toBe('refunding');
  });

  it('a PAID claimant_1 that LOSES is refunded (opposite winner direction)', async () => {
    const itemId = await makeItem('WINB');
    const paidOriginal = await makeClaim(itemId, 'WINB-ORIG', 'pending_payment');
    expect(await db.attemptClaimEscrowHold(paidOriginal, 'MPESA-WINB')).toBe(true);
    const contesting = await makeClaim(itemId, 'WINB-CONTEST', 'disputed');
    const disputeId = `TEST-DSP-6C-WINB-${testRunId}`;
    await db.createDispute({
      id: disputeId, item_id: itemId,
      claimant_1_claim_id: paidOriginal, claimant_2_claim_id: contesting,
      claimant_1_id_proof_url: 'p1', claimant_2_id_proof_url: 'p2',
      resolved_by: null, resolved_claim_id: null, resolved_at: null, admin_notes: null,
    } as any);

    // Award the CONTESTING claim (claimant_2). The paid original becomes the loser.
    const result = await db.resolveDispute(disputeId, contesting, 'test-admin', 'notes');
    expect(result.refundNeededForClaimId).toBe(paidOriginal);
    expect((await db.getClaim(contesting))!.status).toBe('pending_verification');
    expect((await db.getClaim(paidOriginal))!.status).toBe('refunding');
  });

  it('a second resolution cannot mutate again or write a second audit row', async () => {
    const { disputeId, winnerClaimId, loserClaimId } = await makeDisputePair(true, 'TWICE');
    await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'first');

    const before = (await db.getAuditLogs())
      .filter(l => l.action === 'RESOLVE_DISPUTE' && l.details.includes(disputeId)).length;

    let threw = false;
    try {
      await db.resolveDispute(disputeId, loserClaimId, 'other-admin', 'second');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const after = (await db.getAuditLogs())
      .filter(l => l.action === 'RESOLVE_DISPUTE' && l.details.includes(disputeId)).length;
    expect(after).toBe(before);
    expect((await db.getDispute(disputeId))!.resolved_claim_id).toBe(winnerClaimId);
    expect((await db.getClaim(loserClaimId))!.status).toBe('refunding');
  });

  it('exposes a TYPED state-conflict error so the HTTP layer can answer 409 (D-B2)', () => {
    const err = new ClaimStateConflictError('lost the race');
    expect(err.conflictCode).toBe('STATE_CONFLICT');
    expect(err instanceof ClaimStateConflictError).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// SC-5 — REFUND / ITEM INVARIANT
// ---------------------------------------------------------------------------
describe('SC-5: an item is not reopened while another claim still controls it', () => {
  async function makePaidLoserDispute(suffix: string) {
    const itemId = await makeItem(suffix);
    const loserClaimId = await makeClaim(itemId, `${suffix}-LOSER`, 'pending_payment');
    expect(await db.attemptClaimEscrowHold(loserClaimId, `MPESA-${suffix}`)).toBe(true);
    const winnerClaimId = await makeClaim(itemId, `${suffix}-WINNER`, 'disputed');
    const disputeId = `TEST-DSP-6C-${suffix}-${testRunId}`;
    await db.createDispute({
      id: disputeId, item_id: itemId,
      claimant_1_claim_id: winnerClaimId, claimant_2_claim_id: loserClaimId,
      claimant_1_id_proof_url: 'p1', claimant_2_id_proof_url: 'p2',
      resolved_by: null, resolved_claim_id: null, resolved_at: null, admin_notes: null,
    } as any);
    await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'notes');
    return { itemId, winnerClaimId, loserClaimId };
  }

  it('refunds the loser without disturbing the still-live winning claim', async () => {
    const { loserClaimId, winnerClaimId } = await makePaidLoserDispute('SC5');
    expect(await db.finalizeClaimRefund(loserClaimId, '500.00', '+254700000099')).toBe(true);
    expect((await db.getClaim(loserClaimId))!.status).toBe('refunded');
    // The winner is pending_verification — still a live claim on the item.
    expect((await db.getClaim(winnerClaimId))!.status).toBe('pending_verification');
  });

  it('never unfreezes a suspected-stolen item on refund finalization', async () => {
    const { itemId, loserClaimId } = await makePaidLoserDispute('SC5B');
    await db.updateItemStatus(itemId, 'suspected_stolen');
    expect(await db.finalizeClaimRefund(loserClaimId, '500.00', '+254700000099')).toBe(true);
    expect((await db.getItem(itemId))!.status).toBe('suspected_stolen');
  });

  it('never unfreezes an item already handed over (claimed)', async () => {
    const { itemId, loserClaimId } = await makePaidLoserDispute('SC5C');
    await db.updateItemStatus(itemId, 'claimed');
    expect(await db.finalizeClaimRefund(loserClaimId, '500.00', '+254700000099')).toBe(true);
    expect((await db.getItem(itemId))!.status).toBe('claimed');
  });
});

// ---------------------------------------------------------------------------
// SC-7 — CANONICAL SLOT PREDICATE
// ---------------------------------------------------------------------------
describe('SC-7: the slot-excluded set is a single canonical export', () => {
  it('excludes exactly the statuses that must be able to coexist on one item', () => {
    expect([...CLAIM_SLOT_EXCLUDED_STATUSES].sort()).toEqual(
      ['disputed', 'payment_window_expired', 'refunding', 'refunded', 'rejected'].sort(),
    );
    // These two are why the set differs from INACTIVE_CLAIM_STATUSES: a dispute
    // puts two claims on one item, and a refunding loser coexists with the
    // winner. If either occupied the slot, filing a dispute would violate the
    // partial unique index.
    expect(CLAIM_SLOT_EXCLUDED_STATUSES).toContain('disputed');
    expect(CLAIM_SLOT_EXCLUDED_STATUSES).toContain('refunding');
  });
});
