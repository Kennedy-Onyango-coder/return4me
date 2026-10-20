import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// P0 REGRESSION TEST — see the comment in createDispute() (database.ts).
//
// The actual bug: createDispute() used to unconditionally set
// item.status = 'at_agent' regardless of the item's real physical custody
// state. If a dispute were ever opened on an item that had already been
// physically handed to its owner (status='claimed'), this would falsely
// revert the record to "physically at the agent hub" — corrupting custody
// history and potentially making the item look claimable again.
//
// These tests call db.createDispute() directly against items pre-set to
// each of the five lifecycle points named in the hardening brief, rather
// than going through the /api/claims/submit route (which today only ever
// calls createDispute() while item.status is already 'at_agent', due to
// the canCreateClaim() gate). Testing the primitive directly is the
// correct level for this: it proves the FUNCTION itself is safe
// regardless of what future call sites do, not just that today's one call
// site happens to avoid the bug by construction.

let counter = 0;
async function makeTestItem(status: 'at_agent' | 'claimed') {
  const id = `TEST-ITEM-CUSTODY-${testRunId}-${counter++}`;
  await ensureTestCategory('national-id');
  await db.createItem({
    id,
    category_id: 'national-id',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Test location',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000001',
    assigned_agent_id: null,
    status,
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: true,
    rejection_reason: null,
  } as any);
  return id;
}

async function makeTestClaimForItem(itemId: string, suffix: string) {
  const claimId = `TEST-CLAIM-CUSTODY-${testRunId}-${suffix}`;
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: `+2547000000${suffix}`,
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
    verification_tier: 1,
    // The claims table enforces at most one "active" claim per item
    // (uq_claims_one_active_per_item); these fixtures create two claims per
    // item, so both start in the excluded 'disputed' status against real
    // Postgres (createDispute marks them 'disputed' anyway).
    status: 'disputed',
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
  });
  return claimId;
}

describe('createDispute never corrupts physical custody state', () => {
  const scenarios: Array<{ name: string; itemStatus: 'at_agent' | 'claimed' }> = [
    { name: '1. dispute before physical handover (item still at_agent)', itemStatus: 'at_agent' },
    { name: '2. dispute during escrow (item still at_agent — escrow does not move physical custody)', itemStatus: 'at_agent' },
    { name: '3. dispute during pending settlement (item already claimed — handover already confirmed)', itemStatus: 'claimed' },
    { name: '4. dispute after physical handover (item already claimed)', itemStatus: 'claimed' },
    { name: '5. dispute after settlement (item already claimed)', itemStatus: 'claimed' },
  ];

  for (const { name, itemStatus } of scenarios) {
    it(`${name}: item.status is unchanged after createDispute()`, async () => {
      const itemId = await makeTestItem(itemStatus);
      const claim1 = await makeTestClaimForItem(itemId, `A${counter}`);
      const claim2 = await makeTestClaimForItem(itemId, `B${counter}`);

      await db.createDispute({
        id: `TEST-DSP-${testRunId}-${counter++}`,
        item_id: itemId,
        claimant_1_claim_id: claim1,
        claimant_2_claim_id: claim2,
        claimant_1_id_proof_url: 'test-proof-1',
        claimant_2_id_proof_url: 'test-proof-2',
        resolved_by: null,
        resolved_claim_id: null,
        resolved_at: null,
        admin_notes: null,
      });

      const item = await db.getItem(itemId);
      expect(item?.status).toBe(itemStatus);
    });
  }

  it('still marks both claims as disputed, even though item.status is untouched', async () => {
    const itemId = await makeTestItem('at_agent');
    const claim1 = await makeTestClaimForItem(itemId, `C${counter}`);
    const claim2 = await makeTestClaimForItem(itemId, `D${counter}`);

    await db.createDispute({
      id: `TEST-DSP-${testRunId}-${counter++}`,
      item_id: itemId,
      claimant_1_claim_id: claim1,
      claimant_2_claim_id: claim2,
      claimant_1_id_proof_url: 'test-proof-1',
      claimant_2_id_proof_url: 'test-proof-2',
      resolved_by: null,
      resolved_claim_id: null,
      resolved_at: null,
      admin_notes: null,
    });

    const c1 = await db.getClaim(claim1);
    const c2 = await db.getClaim(claim2);
    expect(c1?.status).toBe('disputed');
    expect(c2?.status).toBe('disputed');
  });
});

// =============================================================================
// M6 — A DURABLE SETTLEMENT APPROVAL DOES NOT SURVIVE A DISPUTE
// =============================================================================
// An approval records WHO signed off, WHEN, the total they saw and the exact
// payout rows they saw it against. It authorises ONE payout at ONE handover.
// Before this change createDispute() moved a 'pending_settlement' participant to
// 'disputed' and left all four columns behind, so a claim that later re-entered
// pending_settlement was still "approved" — attemptSettlementRelease() only
// checks that an approval EXISTS — and, because the approval CAS requires
// `settlement_approved_at IS NULL`, the stale approval could never be corrected
// either.
//
// These tests use the REAL lifecycle (escrow-hold CAS → enterPendingSettlement →
// approveSettlement) rather than writing the columns by hand, so they pin the
// actual invalidation boundary rather than a fixture.
// =============================================================================
describe('M6 — createDispute invalidates the settlement approval it ends', () => {
  let agentSeq = 0;

  async function makeAgent() {
    const id = `TEST-AGENT-DSP-APPROVAL-${testRunId}-${++agentSeq}`;
    await db.createAgent({
      id,
      business_name: 'Dispute Approval Hub',
      contact_phone: `+2546${testRunId}${String(agentSeq).padStart(2, '0')}`,
      location_address: 'Test location',
      latitude: null,
      longitude: null,
      mpesa_till_or_paybill: '654321',
      payout_method_type: 'Till Number',
      status: 'active',
      refundable_deposit: 0,
      national_id_hash: 'test-hash',
      needs_manual_geocoding: false,
    } as any);
    return id;
  }

  /**
   * A claim that reaches the state the defect needs: paid, handed over
   * (pending_settlement) and durably approved. `settle_at` is in the past so the
   * real approval CAS accepts the sign-off.
   */
  async function makeApprovedHandoverClaim(suffix: string) {
    const agentId = await makeAgent();
    await ensureTestCategory('national-id');
    const itemId = `TEST-ITEM-DSP-APPROVAL-${testRunId}-${suffix}`;
    await db.createItem({
      id: itemId,
      category_id: 'national-id',
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'Test location',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000321',
      assigned_agent_id: agentId,
      status: 'at_agent',
      flaggedForReview: false,
      isDescriptionOnly: true,
      description: 'Test item',
      is_sensitive_document: true,
      rejection_reason: null,
      locked_total_fee: 1000,
      locked_finder_share: 250,
      locked_agent_share: 350,
      locked_platform_share: 400,
    } as any);

    const claimId = `TEST-CLAIM-DSP-APPROVAL-${testRunId}-${suffix}`;
    await db.createClaim({
      id: claimId,
      item_id: itemId,
      owner_phone: `+25477${testRunId}${String(agentSeq).padStart(2, '0')}`,
      security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'fixture' },
      verification_tier: 1,
      status: 'pending_payment',
      owner_id_proof_url: null,
      payment_reference: null,
      owner_identifying_details: null,
    } as any);

    expect(await db.attemptClaimEscrowHold(claimId, `MPESA-DSP-${testRunId}-${suffix}`)).toBe(true);
    // Negative window => settle_at in the past => the approval CAS accepts it.
    expect((await db.enterPendingSettlement(claimId, -60_000)).success).toBe(true);
    const approval = await db.approveSettlement(claimId, 'test-admin', 'approval-invalidation fixture');
    expect(approval.ok, approval.code).toBe(true);

    const approved = await db.getClaim(claimId);
    expect(approved!.status).toBe('pending_settlement');
    expect(approved!.settlement_approved_at).toBeTruthy();
    expect(approved!.settlement_approved_by).toBe('test-admin');
    expect(approved!.settlement_authorized_total).toBe('600.00');
    expect(approved!.settlement_authorized_ledger_ids).toBeTruthy();

    return { itemId, claimId, agentId };
  }

  async function fileDispute(itemId: string, claimId: string, suffix: string) {
    const rivalClaimId = await makeTestClaimForItem(itemId, String(counter++));
    const disputeId = `TEST-DSP-APPROVAL-${testRunId}-${suffix}`;
    await db.createDispute({
      id: disputeId,
      item_id: itemId,
      claimant_1_claim_id: claimId,
      claimant_2_claim_id: rivalClaimId,
      claimant_1_id_proof_url: 'p1',
      claimant_2_id_proof_url: 'p2',
      resolved_by: null,
      resolved_claim_id: null,
      resolved_at: null,
      admin_notes: null,
    } as any);
    return { disputeId, rivalClaimId };
  }

  it('clears all four approval columns on the participant leaving pending_settlement', async () => {
    const { claimId } = await makeApprovedHandoverClaim('CLEAR');
    await fileDispute((await db.getClaim(claimId))!.item_id!, claimId, 'CLEAR');

    const after = await db.getClaim(claimId);
    expect(after!.status).toBe('disputed');
    // The stale authorisation is gone...
    expect(after!.settlement_approved_at).toBeNull();
    expect(after!.settlement_approved_by).toBeNull();
    expect(after!.settlement_authorized_total).toBeNull();
    expect(after!.settlement_authorized_ledger_ids).toBeNull();
  });

  it('keeps the approval in the audit trail (evidence is not erased)', async () => {
    const { claimId } = await makeApprovedHandoverClaim('AUDIT');
    await fileDispute((await db.getClaim(claimId))!.item_id!, claimId, 'AUDIT');

    const approvalRows = (await db.getAuditLogs()).filter(
      (row) => row.action === 'CLAIM_SETTLEMENT_APPROVED' && row.details.includes(claimId),
    );
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0].details).toContain('approval-invalidation fixture');
  });

  it('leaves a participant that was NOT in pending_settlement untouched', async () => {
    const { itemId, claimId } = await makeApprovedHandoverClaim('OTHER');
    const { rivalClaimId } = await fileDispute(itemId, claimId, 'OTHER');

    const rival = await db.getClaim(rivalClaimId);
    expect(rival!.status).toBe('disputed');
    // Only the leaving-pending_settlement participant is invalidated.
    expect(rival!.settlement_approved_at).toBeNull();
    expect((await db.getItem(itemId))!.status).toBe('claimed');
  });

  it('does not clear the approval of a participant in releasing (same, unchanged booking)', async () => {
    const { claimId } = await makeApprovedHandoverClaim('RELEASING');
    expect(await db.attemptSettlementRelease(claimId)).toBe(true);
    expect((await db.getClaim(claimId))!.status).toBe('releasing');

    await fileDispute((await db.getClaim(claimId))!.item_id!, claimId, 'RELEASING');

    const after = await db.getClaim(claimId);
    expect(after!.status).toBe('disputed');
    expect(after!.settlement_approved_at).toBeTruthy();
    expect(after!.settlement_approved_by).toBe('test-admin');
    expect(after!.settlement_authorized_total).toBe('600.00');
  });

  it('after the dispute the claim has no authorisation and no route back to a releasable state', async () => {
    const { itemId, claimId } = await makeApprovedHandoverClaim('REUSE');
    const { disputeId } = await fileDispute(itemId, claimId, 'REUSE');

    // The paid claimant wins, so resolveDispute() re-promotes it...
    await db.resolveDispute(disputeId, claimId, 'test-admin', 'approval reuse fixture');
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');

    // ...but with no approval, and no way to re-enter settlement:
    expect((await db.getClaim(claimId))!.settlement_approved_at).toBeNull();
    expect(await db.attemptSettlementRelease(claimId)).toBe(false);
    const rebook = await db.enterPendingSettlement(claimId, 60_000);
    expect(rebook.success).toBe(false);
    // This fixture never resets custody, so the item is still 'claimed' and the
    // custody guard refuses first. (When an admin has reset custody to
    // 'at_agent', handoverCustodyGuard.test.ts proves the one-handover-per-claim
    // guard refuses instead.) Either way no second booking is possible.
    expect(rebook.code).toBe('item_not_in_custody');
    expect(
      (await db.getLedgerEntriesForClaim(claimId)).filter((entry: any) =>
        ['finder_payout', 'agent_payout', 'platform_fee'].includes(entry.type),
      ),
    ).toHaveLength(3);
  });
});
