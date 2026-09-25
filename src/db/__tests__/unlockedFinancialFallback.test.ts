import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { testRunId } from './ensureTestCategory';

// ===========================================================================
// PHASE 16.1 — S4 INVARIANT TESTS (BEHAVIOURAL, DB LAYER)
// ===========================================================================
// These tests PIN CURRENT BEHAVIOUR ONLY. They choose no product contract and
// change no implementation:
//
//   S4-A  locked financial values remain authoritative
//   S4-D  an unlocked item falls back to its CURRENT category's fee
//   S4-E  an unlocked item's payout split falls back to its CURRENT category's
//         shares
//   S4-F  an unlocked item's refund calculation falls back to its CURRENT
//         category's fee
//   S4-H  an item whose verified_category_id DIFFERS from category_id still
//         uses category_id for the financial fallback — this is the tripwire
//         that stops the open F-4 question ("should the fallback become
//         verified_category_id ?? category_id?") from being answered by
//         accident.
//
// WHY THE FIXTURE CATEGORY IDS ARE SUFFIXED RATHER THAN 'smartphone'/'laptop':
// this repository's established convention (see ensureTestCategory.ts) is that
// fixtures must not depend on the 46-category baseline seed existing, changing
// or carrying particular pricing. The two categories below stand in for the
// forensic audit's 'smartphone' (the REPORTED category) and 'laptop' (the
// VERIFIED category) and carry deliberately DIFFERENT pricing so every
// assertion can tell them apart.
//
// All of these are pure DB-layer calls against the in-memory mock used by CI —
// no Postgres, no network, no provider credentials.
// ===========================================================================

/** Unique-per-run category with explicit pricing (idempotent for a real DB). */
async function makeCategory(suffix: string, totalFee: number, finder: number, agent: number, platform: number) {
  const id = `test-cat-s4-${suffix}-${testRunId}`;
  const existing = await db.getCategories();
  if (existing.some((c) => c.id === id)) return id;
  await db.createCategory({
    id,
    name_en: `S4 ${suffix}`,
    name_sw: `S4 ${suffix}`,
    total_fee: totalFee,
    finder_share: finder,
    agent_share: agent,
    platform_share: platform,
    is_sensitive_document: false,
  });
  return id;
}

async function makeAgent(suffix: string) {
  const id = `TEST-AGENT-S4-${testRunId}-${suffix}`;
  await db.createAgent({
    id,
    business_name: 'S4 Test Agent Hub',
    contact_phone: `+254${testRunId}${suffix === 'A' ? '31' : '32'}`,
    location_address: 'Test Location',
    latitude: null,
    longitude: null,
    mpesa_till_or_paybill: '123456',
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-s4',
    needs_manual_geocoding: false,
  } as any);
  return id;
}

/** Shared item fixture; the caller decides whether locked_* are present. */
async function makeItem(opts: {
  id: string;
  categoryId: string;
  agentId: string | null;
  locked?: { total: number; finder: number; agent: number; platform: number } | null;
}) {
  await db.createItem({
    id: opts.id,
    category_id: opts.categoryId,
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Test location',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000021',
    assigned_agent_id: opts.agentId,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: true,
    description: 'Test item',
    is_sensitive_document: false,
    rejection_reason: null,
    ...(opts.locked
      ? {
          locked_total_fee: opts.locked.total,
          locked_finder_share: opts.locked.finder,
          locked_agent_share: opts.locked.agent,
          locked_platform_share: opts.locked.platform,
        }
      : {}),
  } as any);
}

async function makeClaim(id: string, itemId: string, status: string, paymentReference: string | null = null) {
  await db.createClaim({
    id,
    item_id: itemId,
    owner_phone: '+254700000022',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
    verification_tier: 1,
    status: status as any,
    owner_id_proof_url: null,
    payment_reference: paymentReference,
    owner_identifying_details: null,
  });
}

// ---------------------------------------------------------------------------
// S4-A — locked financial values remain authoritative
// ---------------------------------------------------------------------------
describe('S4-A: locked financial values remain authoritative', () => {
  it('the locked TOTAL fee wins over the category total fee (refund derivation)', async () => {
    // Category is priced at 500; the item was locked at 1000. This is the same
    // locked-else-category precedence the payment path uses, exercised through
    // the refund derivation (the one DB-layer seam that reads locked_total_fee
    // WITH a category fallback).
    const categoryId = await makeCategory('ALOCK', 500, 125, 175, 200);
    const itemId = `TEST-ITEM-S4-ALOCK-${testRunId}`;
    const claimId = `TEST-CLAIM-S4-ALOCK-${testRunId}`;
    await makeItem({
      id: itemId,
      categoryId,
      agentId: null,
      locked: { total: 1000, finder: 250, agent: 350, platform: 400 },
    });
    await makeClaim(claimId, itemId, 'refunding', 'MPX-S4-ALOCK');

    const entry = (await db.getRefundReconciliationClaims()).find((c) => c.claimId === claimId);
    expect(entry, 'the refunding claim must be discoverable').toBeDefined();
    // 1000 (locked) — NOT 500 (the category's total_fee).
    expect(parseFloat(entry!.refundAmount)).toBe(1000);
  });

  it('the locked SHARES win over the category shares (settlement split)', async () => {
    const categoryId = await makeCategory('ASHARE', 1000, 250, 350, 400);
    const agentId = await makeAgent('A');
    const itemId = `TEST-ITEM-S4-ASHARE-${testRunId}`;
    const claimId = `TEST-CLAIM-S4-ASHARE-${testRunId}`;
    await makeItem({
      id: itemId,
      categoryId,
      agentId,
      locked: { total: 1000, finder: 250, agent: 350, platform: 400 },
    });
    await makeClaim(claimId, itemId, 'escrow_held');

    // The category is re-priced AFTER the item was reported and locked.
    await db.updateCategory(categoryId, {
      name_en: 'S4 ASHARE',
      name_sw: 'S4 ASHARE',
      total_fee: 1000,
      finder_share: 100, // changed from 250
      agent_share: 500,  // changed from 350
      platform_share: 400,
      is_sensitive_document: false,
    });

    const settlement = await db.enterPendingSettlement(claimId, 60 * 60 * 1000);
    expect(settlement.success).toBe(true);

    const entries = await db.getLedgerEntriesForClaim(claimId);
    expect(entries.find((e) => e.type === 'finder_payout')?.amount).toBe(250);
    expect(entries.find((e) => e.type === 'agent_payout')?.amount).toBe(350);
    expect(entries.find((e) => e.type === 'platform_fee')?.amount).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// S4-D / S4-F — unlocked FEE fallback (refund derivation)
// ---------------------------------------------------------------------------
describe("S4-D / S4-F: an unlocked item falls back to its CURRENT category fee", () => {
  it("locked_total_fee NULL -> the reported category's current total_fee is used", async () => {
    const categoryId = await makeCategory('DLOCK', 500, 125, 175, 200);
    const itemId = `TEST-ITEM-S4-DLOCK-${testRunId}`;
    const claimId = `TEST-CLAIM-S4-DLOCK-${testRunId}`;
    // No locked_* at all -> the legacy/unlocked path.
    await makeItem({ id: itemId, categoryId, agentId: null });
    await makeClaim(claimId, itemId, 'refunding', 'MPX-S4-DLOCK');

    const stored = await db.getItem(itemId);
    expect(stored?.locked_total_fee, 'fixture must be genuinely unlocked').toBeNull();

    const entry = (await db.getRefundReconciliationClaims()).find((c) => c.claimId === claimId);
    expect(entry).toBeDefined();
    // Falls back to the category's 500.
    expect(parseFloat(entry!.refundAmount)).toBe(500);
  });

  it('the fallback follows a later category re-price (current configuration, not report-time)', async () => {
    const categoryId = await makeCategory('DPRICE', 500, 125, 175, 200);
    const itemId = `TEST-ITEM-S4-DPRICE-${testRunId}`;
    const claimId = `TEST-CLAIM-S4-DPRICE-${testRunId}`;
    await makeItem({ id: itemId, categoryId, agentId: null });
    await makeClaim(claimId, itemId, 'refunding', 'MPX-S4-DPRICE');

    await db.updateCategory(categoryId, {
      name_en: 'S4 DPRICE',
      name_sw: 'S4 DPRICE',
      total_fee: 700,
      finder_share: 175,
      agent_share: 245,
      platform_share: 280,
      is_sensitive_document: false,
    });

    const entry = (await db.getRefundReconciliationClaims()).find((c) => c.claimId === claimId);
    expect(entry).toBeDefined();
    // The CURRENT category fee (700) — this is what "fallback to
    // item.category_id" means today for an unlocked item.
    expect(parseFloat(entry!.refundAmount)).toBe(700);
  });
});

// ---------------------------------------------------------------------------
// S4-E — unlocked SHARES fallback (settlement split)
// ---------------------------------------------------------------------------
describe("S4-E: an unlocked item's payout split falls back to its CURRENT category shares", () => {
  it("locked shares NULL -> the reported category's current shares are booked", async () => {
    const categoryId = await makeCategory('ESHARE', 500, 125, 175, 200);
    const agentId = await makeAgent('E');
    const itemId = `TEST-ITEM-S4-ESHARE-${testRunId}`;
    const claimId = `TEST-CLAIM-S4-ESHARE-${testRunId}`;
    await makeItem({ id: itemId, categoryId, agentId });
    await makeClaim(claimId, itemId, 'escrow_held');

    const stored = await db.getItem(itemId);
    expect(stored?.locked_finder_share).toBeNull();
    expect(stored?.locked_agent_share).toBeNull();
    expect(stored?.locked_platform_share).toBeNull();

    const settlement = await db.enterPendingSettlement(claimId, 60 * 60 * 1000);
    expect(settlement.success).toBe(true);

    const entries = await db.getLedgerEntriesForClaim(claimId);
    expect(entries.find((e) => e.type === 'finder_payout')?.amount).toBe(125);
    expect(entries.find((e) => e.type === 'agent_payout')?.amount).toBe(175);
    expect(entries.find((e) => e.type === 'platform_fee')?.amount).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// S4-H — verified category must NOT silently become the financial fallback
// ---------------------------------------------------------------------------
describe('S4-H: unlocked financial fallback stays on category_id, even when verified_category_id differs', () => {
  it('settlement shares come from the REPORTED category, never the verified one', async () => {
    const reportedId = await makeCategory('HREPORT', 500, 125, 175, 200); // stands in for 'smartphone'
    const verifiedId = await makeCategory('HVERIFY', 800, 500, 150, 150); // stands in for 'laptop'
    const agentId = await makeAgent('H');
    const itemId = `TEST-ITEM-S4-H-${testRunId}`;
    const claimId = `TEST-CLAIM-S4-H-${testRunId}`;

    await makeItem({ id: itemId, categoryId: reportedId, agentId });

    // The Agent verifies the item into a DIFFERENT, more expensive category.
    // This is the real production write path for verified_category_id.
    const verification = await db.recordItemVerification(
      itemId,
      agentId,
      { category_id: verifiedId, name: null, document_number: null, description: 'Test item', found_area: 'Test location' },
      'Wrong category reported',
      null,
      true,
    );
    expect(verification.success).toBe(true);

    const stored = await db.getItem(itemId);
    expect(stored?.category_id, 'the reported category must be preserved').toBe(reportedId);
    expect(stored?.verified_category_id, 'the verified category must be recorded').toBe(verifiedId);
    expect(stored?.locked_total_fee, 'still the legacy/unlocked path').toBeNull();

    await makeClaim(claimId, itemId, 'escrow_held');
    const settlement = await db.enterPendingSettlement(claimId, 60 * 60 * 1000);
    expect(settlement.success).toBe(true);

    const entries = await db.getLedgerEntriesForClaim(claimId);
    // REPORTED category (125/175/200) — NOT the verified category (500/150/150).
    expect(entries.find((e) => e.type === 'finder_payout')?.amount).toBe(125);
    expect(entries.find((e) => e.type === 'agent_payout')?.amount).toBe(175);
    expect(entries.find((e) => e.type === 'platform_fee')?.amount).toBe(200);
  });

  it('the refund derivation also stays on the REPORTED category, never the verified one', async () => {
    const reportedId = await makeCategory('H2REPORT', 500, 125, 175, 200);
    const verifiedId = await makeCategory('H2VERIFY', 800, 500, 150, 150);
    const agentId = await makeAgent('H');
    const itemId = `TEST-ITEM-S4-H2-${testRunId}`;
    const claimId = `TEST-CLAIM-S4-H2-${testRunId}`;

    await makeItem({ id: itemId, categoryId: reportedId, agentId: null });
    const verification = await db.recordItemVerification(
      itemId,
      agentId,
      { category_id: verifiedId, name: null, document_number: null, description: 'Test item', found_area: 'Test location' },
      'Wrong category reported',
      null,
      true,
    );
    expect(verification.success).toBe(true);
    await makeClaim(claimId, itemId, 'refunding', 'MPX-S4-H2');

    const entry = (await db.getRefundReconciliationClaims()).find((c) => c.claimId === claimId);
    expect(entry).toBeDefined();
    // 500 (reported) — NOT 800 (verified).
    expect(parseFloat(entry!.refundAmount)).toBe(500);
  });
});




