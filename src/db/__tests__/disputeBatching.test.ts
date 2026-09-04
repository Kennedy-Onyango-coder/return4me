import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// Regression test for a real N+1 query pattern: the public search route
// (GET /api/items/search) used to call canCreateClaim() once per result
// item inside a Promise.all, and canCreateClaim() internally called
// db.getDisputesByItem() — one dispute query per item, every single search
// request. db.getDisputesByItemIds() batches this into one query for the
// whole candidate set, grouped by item_id. This test proves the grouping
// itself is correct: items with a dispute get exactly their own disputes
// back, items without one get an empty/absent entry, and nothing leaks
// across items.

let counter = 0;
async function makeTestItem() {
  const id = `TEST-ITEM-DISPUTEBATCH-${testRunId}-${counter++}`;
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
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: true,
    rejection_reason: null,
  } as any);
  return id;
}

async function makeTestClaimForItem(itemId: string, suffix: string) {
  const claimId = `TEST-CLAIM-DISPUTEBATCH-${testRunId}-${suffix}`;
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

describe('getDisputesByItemIds batches dispute lookups correctly', () => {
  it('returns each item its own disputes, grouped, from a single batched query', async () => {
    const itemWithDispute = await makeTestItem();
    const itemWithoutDispute = await makeTestItem();
    const claimA = await makeTestClaimForItem(itemWithDispute, `A${counter}`);
    const claimB = await makeTestClaimForItem(itemWithDispute, `B${counter}`);

    await db.createDispute({
      id: `TEST-DISPUTE-${testRunId}-${counter++}`,
      item_id: itemWithDispute,
      claimant_1_claim_id: claimA,
      claimant_2_claim_id: claimB,
      claimant_1_id_proof_url: 'test-proof-1',
      claimant_2_id_proof_url: 'test-proof-2',
      resolved_by: null,
      resolved_claim_id: null,
      resolved_at: null,
      admin_notes: null,
    } as any);

    const result = await db.getDisputesByItemIds([itemWithDispute, itemWithoutDispute]);

    expect(result.get(itemWithDispute)?.length).toBe(1);
    expect(result.get(itemWithDispute)?.[0].item_id).toBe(itemWithDispute);
    expect(result.get(itemWithoutDispute) ?? []).toEqual([]);
  });

  it('returns an empty map without querying when given an empty item-id list', async () => {
    const result = await db.getDisputesByItemIds([]);
    expect(result.size).toBe(0);
  });

  it('matches what getDisputesByItem would return for the same item (batched vs single-item parity)', async () => {
    const itemId = await makeTestItem();
    const claimA = await makeTestClaimForItem(itemId, `C${counter}`);
    const claimB = await makeTestClaimForItem(itemId, `D${counter}`);
    await db.createDispute({
      id: `TEST-DISPUTE-${testRunId}-${counter++}`,
      item_id: itemId,
      claimant_1_claim_id: claimA,
      claimant_2_claim_id: claimB,
      claimant_1_id_proof_url: 'test-proof-1',
      claimant_2_id_proof_url: 'test-proof-2',
      resolved_by: null,
      resolved_claim_id: null,
      resolved_at: null,
      admin_notes: null,
    } as any);

    const single = await db.getDisputesByItem(itemId);
    const batched = await db.getDisputesByItemIds([itemId]);

    expect(batched.get(itemId)?.map(d => d.id).sort()).toEqual(single.map(d => d.id).sort());
  });
});
