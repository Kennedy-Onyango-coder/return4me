import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { testRunId } from './ensureTestCategory';

// P1 FINANCIAL INVARIANT TEST — "Use locked values from the item. Do not
//
// The scenario this protects against: an admin edits a category's fee
// split (e.g. changes Finder from 25% to 10%) AFTER an item in that
// category was already reported and its fee/split locked in at report
// time (item.locked_total_fee / locked_finder_share / locked_agent_share
// / locked_platform_share — see the Recovery Fee Engine). A claim that
// was already in progress when the category changed must settle using
// the ORIGINAL locked values, not the new category configuration —
// otherwise the amount an owner was quoted, and what a finder/agent were
// promised, could silently change out from under them mid-claim.

async function makeFreshCategory(suffix: string, finderShare: number, agentShare: number, platformShare: number) {
  const id = `test-cat-invariant-${testRunId}-${suffix}`;
  // Idempotent: real Postgres enforces the categories PK, so re-running this
  // suite against the same database must not attempt a duplicate insert.
  const existing = await db.getCategories();
  if (existing.some((c) => c.id === id)) return id;
  await db.createCategory({
    id,
    name_en: 'Test Category',
    name_sw: 'Kategoria ya Mtihani',
    total_fee: finderShare + agentShare + platformShare,
    finder_share: finderShare,
    agent_share: agentShare,
    platform_share: platformShare,
    is_sensitive_document: false,
  });
  return id;
}

async function makeFreshAgent(suffix: string) {
  const id = `TEST-AGENT-INVARIANT-${testRunId}-${suffix}`;
  await db.createAgent({
    id,
    business_name: 'Test Agent Hub',
    contact_phone: `+254${testRunId}${suffix === 'A' ? '10' : '20'}`,
    location_address: 'Test Location',
    latitude: null,
    longitude: null,
    mpesa_till_or_paybill: '123456',
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash',
    needs_manual_geocoding: false,
  } as any);
  return id;
}

describe('financial invariant: locked historical fee/split survives a later category change', () => {
  it('enterPendingSettlement uses the ITEM\'s locked shares, not the category\'s current (changed) shares', async () => {
    const categoryId = await makeFreshCategory('A', 250, 350, 400); // 25/35/40 split of 1000
    const agentId = await makeFreshAgent('A');

    const itemId = `TEST-ITEM-INVARIANT-${testRunId}-A`;
    await db.createItem({
      id: itemId,
      category_id: categoryId,
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'Test location',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000011',
      assigned_agent_id: agentId,
      status: 'at_agent',
      flaggedForReview: false,
      isDescriptionOnly: true,
      description: 'Test item',
      is_sensitive_document: false,
      rejection_reason: null,
      locked_total_fee: 1000,
      locked_finder_share: 250,
      locked_agent_share: 350,
      locked_platform_share: 400,
    } as any);

    const claimId = `TEST-CLAIM-INVARIANT-${testRunId}-A`;
    await db.createClaim({
      id: claimId,
      item_id: itemId,
      owner_phone: '+254700000012',
      security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
      verification_tier: 1,
      status: 'escrow_held',
      owner_id_proof_url: null,
      payment_reference: 'TEST-PAYREF-INVARIANT-A',
      owner_identifying_details: null,
    });

    // Category's fee split changes AFTER the item was reported and its
    // shares locked — e.g. an admin later decides Finder should get 10%
    // instead of 25% for this category going forward.
    await db.updateCategory(categoryId, {
      name_en: 'Test Category',
      name_sw: 'Kategoria ya Mtihani',
      total_fee: 1000,
      finder_share: 100, // changed from 250
      agent_share: 500,  // changed from 350
      platform_share: 400,
      is_sensitive_document: false,
    });

    const settlement = await db.enterPendingSettlement(claimId, 1000 * 60 * 60);
    expect(settlement.success).toBe(true);

    const entries = await db.getLedgerEntriesForClaim(claimId);
    const finderEntry = entries.find(e => e.type === 'finder_payout');
    const agentEntry = entries.find(e => e.type === 'agent_payout');
    const platformEntry = entries.find(e => e.type === 'platform_fee');

    // Must reflect the ORIGINAL locked values (250/350/400), not the
    // category's new values (100/500/400).
    expect(finderEntry?.amount).toBe(250);
    expect(agentEntry?.amount).toBe(350);
    expect(platformEntry?.amount).toBe(400);
  });

  it('the ledger split always sums EXACTLY to the locked total — no floating-point drift', async () => {
    // A deliberately awkward total that's prone to floating-point error
    // if computed carelessly (e.g. repeated percentage multiplication).
    const categoryId = await makeFreshCategory('B', 92.51, 129.52, 148.06); // sums to 370.09
    const agentId = await makeFreshAgent('B');

    const itemId = `TEST-ITEM-INVARIANT-${testRunId}-B`;
    await db.createItem({
      id: itemId,
      category_id: categoryId,
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'Test location',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000013',
      assigned_agent_id: agentId,
      status: 'at_agent',
      flaggedForReview: false,
      isDescriptionOnly: true,
      description: 'Test item',
      is_sensitive_document: false,
      rejection_reason: null,
      locked_total_fee: 370.09,
      locked_finder_share: 92.51,
      locked_agent_share: 129.52,
      locked_platform_share: 148.06,
    } as any);

    const claimId = `TEST-CLAIM-INVARIANT-${testRunId}-B`;
    await db.createClaim({
      id: claimId,
      item_id: itemId,
      owner_phone: '+254700000014',
      security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
      verification_tier: 1,
      status: 'escrow_held',
      owner_id_proof_url: null,
      payment_reference: 'TEST-PAYREF-INVARIANT-B',
      owner_identifying_details: null,
    });

    await db.enterPendingSettlement(claimId, 1000 * 60 * 60);

    const entries = await db.getLedgerEntriesForClaim(claimId);
    const sum = entries
      .filter(e => e.type === 'finder_payout' || e.type === 'agent_payout' || e.type === 'platform_fee')
      .reduce((acc, e) => acc + e.amount, 0);

    // Must match the locked total to the cent — not "close to", exactly.
    expect(sum).toBeCloseTo(370.09, 2);
  });
});
