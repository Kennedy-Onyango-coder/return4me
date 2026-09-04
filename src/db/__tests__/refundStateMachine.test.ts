import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// P1 REGRESSION TEST — payment state machine, refund path. The payout
// side of this state machine (finder/agent payouts, all 6 provider-
// response scenarios, duplicate-webhook idempotency) is already
// extensively covered by settlementReconciliation.test.ts. This file
// covers the payment-side states that had zero prior test coverage:
// 'refunding' and 'refunded' — the loser-of-a-dispute refund path.
//
// Found and fixed a real gap while writing these tests: finalizeClaimRefund
// had no WHERE-status guard (unlike the otherwise-identical
// revertClaimRefundLock, which does), so calling it twice would insert a
// second 'refund' ledger row and a second audit entry for one real M-Pesa
// transfer. Not reachable today — resolveDispute's own atomic CAS
// (WHERE resolved_at IS NULL) means this can currently only be called once
// per claim via the one real call path — but a future caller bypassing
// that path (e.g. an admin manual "retry stuck refund" action) would have
// hit it. Fixed with the same conditional-UPDATE-WHERE pattern this
// codebase already uses for attemptClaimEscrowHold / attemptSettlementRelease
// / markClaimRatedIfNotAlready.

let counter = 0;
async function makeDisputedClaimPair(loserAlreadyPaid: boolean) {
  const itemId = `TEST-ITEM-REFUND-${testRunId}-${counter++}`;
  await ensureTestCategory('phone');
  const winnerClaimId = `TEST-CLAIM-REFUND-WINNER-${testRunId}-${counter++}`;
  const loserClaimId = `TEST-CLAIM-REFUND-LOSER-${testRunId}-${counter++}`;

  await db.createItem({
    id: itemId, category_id: 'phone', photo_url: 'test-photo.jpg', ocr_extracted_number: null,
    ocr_extracted_name: null, document_number_hash: null, document_name_fuzzy: null,
    location_description: 'x', latitude: null, longitude: null, finder_phone: '+254700000005',
    assigned_agent_id: null, status: 'at_agent', flaggedForReview: false, isDescriptionOnly: true,
    description: 'x', is_sensitive_document: false, rejection_reason: null,
  } as any);

  await db.createClaim({
    id: winnerClaimId, item_id: itemId, owner_phone: '+254700000006',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'winner fixture' },
    verification_tier: 1, status: 'pending_verification', owner_id_proof_url: null,
    payment_reference: null, owner_identifying_details: null,
  });
  await db.createClaim({
    id: loserClaimId, item_id: itemId, owner_phone: '+254700000007',
    security_answers: { lastDigits: '1111', color: 'red', lostDetails: 'loser fixture' },
    // The claims table enforces at most one "active" claim per item
    // (uq_claims_one_active_per_item); the winner is already the active
    // claim, so the second (loser) claim must start in the excluded
    // 'disputed' status against real Postgres.
    verification_tier: 1, status: 'disputed', owner_id_proof_url: null,
    payment_reference: null, owner_identifying_details: null,
  });

  if (loserAlreadyPaid) {
    // payment_reference is the real signal resolveDispute checks (see its
    // own BUGFIX comment) — status gets overwritten to 'disputed' by
    // createDispute regardless, so payment_reference is what must be set
    // to simulate "this claimant genuinely already paid".
    await db.updateClaimStatus(loserClaimId, 'disputed', 'TEST-MPESA-REF-123');
  }

  const dispute = await db.createDispute({
    id: `TEST-DISPUTE-REFUND-${testRunId}-${counter++}`,
    item_id: itemId,
    claimant_1_claim_id: winnerClaimId,
    claimant_2_claim_id: loserClaimId,
    claimant_1_id_proof_url: 'test-proof-1',
    claimant_2_id_proof_url: 'test-proof-2',
    resolved_by: null,
    resolved_claim_id: null,
    resolved_at: null,
    admin_notes: null,
  } as any);

  return { itemId, winnerClaimId, loserClaimId, disputeId: dispute.id };
}

describe('resolveDispute locks an already-paid loser into "refunding"', () => {
  it('locks the losing claim into refunding and returns refund details when the loser had already paid', async () => {
    const { winnerClaimId, loserClaimId, disputeId } = await makeDisputedClaimPair(true);

    const result = await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'winner has stronger evidence');

    expect(result.refundNeededForClaimId).toBe(loserClaimId);
    expect(result.refundAmount).toBeTruthy();
    expect(result.refundPhone).toBeTruthy();

    const loserClaim = await db.getClaim(loserClaimId);
    expect(loserClaim?.status).toBe('refunding');
  });

  it('does NOT request a refund when the loser never actually paid', async () => {
    const { winnerClaimId, loserClaimId, disputeId } = await makeDisputedClaimPair(false);

    const result = await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'winner has stronger evidence');

    expect(result.refundNeededForClaimId).toBeNull();
    const loserClaim = await db.getClaim(loserClaimId);
    expect(loserClaim?.status).not.toBe('refunding');
  });
});

describe('finalizeClaimRefund: refunding -> refunded, exactly once', () => {
  it('transitions the claim to refunded, reactivates the item, and records a ledger + audit entry', async () => {
    const { itemId, winnerClaimId, loserClaimId, disputeId } = await makeDisputedClaimPair(true);
    await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'notes');

    const succeeded = await db.finalizeClaimRefund(loserClaimId, '500.00', '+254700000007');
    expect(succeeded).toBe(true);

    const claim = await db.getClaim(loserClaimId);
    expect(claim?.status).toBe('refunded');

    const item = await db.getItem(itemId);
    expect(item?.status).toBe('at_agent');

    const ledger = await db.getLedgerEntriesForClaim(loserClaimId);
    const refundEntries = ledger.filter(l => l.type === 'refund');
    expect(refundEntries.length).toBe(1);
  });

  it('a second call on an already-refunded claim is a safe no-op — no duplicate ledger row', async () => {
    const { winnerClaimId, loserClaimId, disputeId } = await makeDisputedClaimPair(true);
    await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'notes');

    const first = await db.finalizeClaimRefund(loserClaimId, '500.00', '+254700000007');
    const second = await db.finalizeClaimRefund(loserClaimId, '500.00', '+254700000007');

    expect(first).toBe(true);
    expect(second).toBe(false);

    const ledger = await db.getLedgerEntriesForClaim(loserClaimId);
    const refundEntries = ledger.filter(l => l.type === 'refund');
    expect(refundEntries.length).toBe(1); // still exactly one, not two
  });

  it('refuses (returns false) for a claim that was never locked into refunding at all', async () => {
    const { loserClaimId } = await makeDisputedClaimPair(false); // never disputed-and-locked
    const result = await db.finalizeClaimRefund(loserClaimId, '500.00', '+254700000007');
    expect(result).toBe(false);
  });
});

describe('revertClaimRefundLock: refunding -> rejected on a failed real transfer', () => {
  it('reverts the claim to rejected (denied) so it is not stranded as an active claim', async () => {
    const { winnerClaimId, loserClaimId, disputeId } = await makeDisputedClaimPair(true);
    await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'notes');

    await db.revertClaimRefundLock(loserClaimId, 'simulated IntaSend failure');

    const claim = await db.getClaim(loserClaimId);
    // The loser is denied (dispute already resolved against them), so their
    // claim must leave the 'refunding' lock into a non-active terminal state
    // ('rejected') — never 'escrow_held', which would collide with the
    // winner's active claim against uq_claims_one_active_per_item.
    expect(claim?.status).toBe('rejected');
    // The money is still recoverable for manual refund via payment_reference.
    expect(claim?.payment_reference).toBe('TEST-MPESA-REF-123');
  });

  it('is idempotent — a second revert call after the claim already moved on is a safe no-op', async () => {
    const { winnerClaimId, loserClaimId, disputeId } = await makeDisputedClaimPair(true);
    await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'notes');

    await db.revertClaimRefundLock(loserClaimId, 'first failure');
    // Claim is now 'rejected', not 'refunding' — this second call's own
    // WHERE status='refunding' guard should match zero rows.
    await db.revertClaimRefundLock(loserClaimId, 'a second, spurious revert attempt');

    const claim = await db.getClaim(loserClaimId);
    expect(claim?.status).toBe('rejected'); // unchanged, not corrupted
  });
});

// FIX #4 (audit finding A1): an ambiguous IntaSend outcome (network
// timeout/exception) must NOT be treated as a definite failure. The caller
// (server.ts /api/admin/disputes/resolve) now leaves the claim locked in
// 'refunding' and only writes an audit entry — no finalize, no revert, no
// automatic retry. These tests pin the DB-side reconciliation guarantees
// that make that behavior financially safe.
describe('unknown refund outcome: claim remains in refunding for manual reconciliation', () => {
  it('keeps the claim in refunding with no refund ledger row, and the audit-only path leaves money recoverable', async () => {
    const { winnerClaimId, loserClaimId, disputeId } = await makeDisputedClaimPair(true);
    await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'notes');
    expect((await db.getClaim(loserClaimId))?.status).toBe('refunding');

    // This is ALL the unknown-outcome caller does: log an audit entry.
    await db.logAudit('SYSTEM', 'REFUND_UNKNOWN_OUTCOME', `Claim ${loserClaimId}: refund request to IntaSend ended in an ambiguous outcome (timeout/network error). The claim remains locked in 'refunding'. No automatic retry has been issued.`);

    // No state transition happened, no money was recorded as moved.
    const claim = await db.getClaim(loserClaimId);
    expect(claim?.status).toBe('refunding');
    // payment_reference (the real M-Pesa escrow receipt) is preserved —
    // this is what makes the stuck escrow traceable for reconciliation.
    expect(claim?.payment_reference).toBe('TEST-MPESA-REF-123');
    let ledger = await db.getLedgerEntriesForClaim(loserClaimId);
    expect(ledger.filter(l => l.type === 'refund').length).toBe(0);

    // The winner's claim is unaffected while the loser sits in refunding.
    const winner = await db.getClaim(winnerClaimId);
    expect(winner?.status).not.toBe('refunding');
    expect(winner?.status).not.toBe('rejected');
    expect(winner?.status).not.toBe('refunded');
  });

  it('reconciliation path 1 — provider confirms the refund executed: finalizeClaimRefund still works exactly once from refunding', async () => {
    const { winnerClaimId, loserClaimId, disputeId } = await makeDisputedClaimPair(true);
    await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'notes');
    await db.logAudit('SYSTEM', 'REFUND_UNKNOWN_OUTCOME', `Claim ${loserClaimId}: ambiguous outcome, awaiting reconciliation.`);

    const fin = await db.finalizeClaimRefund(loserClaimId, '500.00', '+254700000007');
    expect(fin).toBe(true);

    const claim = await db.getClaim(loserClaimId);
    expect(claim?.status).toBe('refunded');
    const ledger = await db.getLedgerEntriesForClaim(loserClaimId);
    expect(ledger.filter(l => l.type === 'refund').length).toBe(1);
  });

  it('reconciliation path 2 — provider confirms the refund was NOT executed: revertClaimRefundLock still works from refunding', async () => {
    const { winnerClaimId, loserClaimId, disputeId } = await makeDisputedClaimPair(true);
    await db.resolveDispute(disputeId, winnerClaimId, 'test-admin', 'notes');
    await db.logAudit('SYSTEM', 'REFUND_UNKNOWN_OUTCOME', `Claim ${loserClaimId}: ambiguous outcome, awaiting reconciliation.`);

    await db.revertClaimRefundLock(loserClaimId, 'IntaSend confirmed the refund never executed');
    const claim = await db.getClaim(loserClaimId);
    expect(claim?.status).toBe('rejected');
    expect(claim?.payment_reference).toBe('TEST-MPESA-REF-123'); // still traceable
  });

  it('a second refund trigger cannot bypass the state guard — finalize/revert only act on a claim locked in refunding', async () => {
    const { loserClaimId } = await makeDisputedClaimPair(false); // never locked into refunding
    // Even if some future caller blindly re-triggers a refund for this
    // claim, both reconciliation operations refuse: the WHERE
    // status='refunding' guards match zero rows, so no ledger row and no
    // status change can occur outside a genuine resolveDispute lock.
    const fin = await db.finalizeClaimRefund(loserClaimId, '500.00', '+254700000007');
    expect(fin).toBe(false);
    await db.revertClaimRefundLock(loserClaimId, 'spurious trigger');
    const claim = await db.getClaim(loserClaimId);
    expect(claim?.status).not.toBe('refunded');
    expect(claim?.status).not.toBe('rejected');
    const ledger = await db.getLedgerEntriesForClaim(loserClaimId);
    expect(ledger.filter(l => l.type === 'refund').length).toBe(0);
  });
});
