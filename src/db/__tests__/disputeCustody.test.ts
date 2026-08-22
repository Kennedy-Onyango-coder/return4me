import { describe, it, expect } from 'vitest';
import { db } from '../database';

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
  const id = `TEST-ITEM-CUSTODY-${counter++}`;
  await db.createItem({
    id,
    category_id: 'national-id',
    photo_url: null,
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
  const claimId = `TEST-CLAIM-CUSTODY-${suffix}`;
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: `+2547000000${suffix}`,
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
    verification_tier: 1,
    status: 'pending_verification',
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
        id: `TEST-DSP-${counter++}`,
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
      id: `TEST-DSP-${counter++}`,
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
