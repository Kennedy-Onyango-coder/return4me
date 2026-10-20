import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { db as drizzle } from '../index';
import { ledger as ledgerTable } from '../schema';
import { testRunId } from './ensureTestCategory';

// =============================================================================
// BATCH 3 — THE APPROVAL RECORDS WHAT IT AUTHORIZED.
// =============================================================================
// These assertions run against the real data layer (the in-memory double when
// DATABASE_URL is absent, PostgreSQL when it is present), so they cover the
// actual write path rather than a simulation of it:
//   * the approval persists the payout TOTAL and the exact ledger ROWS;
//   * an ineligible claim still reports its real reason (the snapshot is captured
//     only after the approval CAS wins, so it cannot mask the eligibility code);
//   * a repeat approval loses the CAS and does not rewrite the snapshot.
//
// The unreadable-snapshot rollback is unit-tested in
// config/__tests__/settlementAuthorizationSnapshot.test.ts (the rule) and pinned
// at the data layer by the source-contract assertion in
// src/__tests__/settlementAuthorizationEnforcement.test.ts (the throw inside the
// transaction). It cannot be produced through this suite's public API: a claim
// only reaches pending_settlement by booking its payout rows.
// =============================================================================

const SUFFIX = `B3-${testRunId}`;

async function makeClaim(suffix: string) {
  const categoryId = `test-cat-b3-${SUFFIX}-${suffix}`;
  const existing = await db.getCategories();
  if (!existing.some((c) => c.id === categoryId)) {
    await db.createCategory({
      id: categoryId,
      name_en: 'Batch 3 Test Category',
      name_sw: 'Kategoria ya Mtihani',
      total_fee: 1000,
      finder_share: 250,
      agent_share: 350,
      platform_share: 400,
      is_sensitive_document: false,
    });
  }

  const agentId = `TEST-AGENT-B3-${SUFFIX}-${suffix}`;
  await db.createAgent({
    id: agentId,
    business_name: 'Batch 3 Test Hub',
    contact_phone: `+2547${testRunId}${suffix.length}`,
    location_address: 'Test Location',
    latitude: null,
    longitude: null,
    mpesa_till_or_paybill: '712345678',
    payout_method_type: 'Personal M-Pesa',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash',
    needs_manual_geocoding: false,
  } as any);

  const itemId = `TEST-ITEM-B3-${SUFFIX}-${suffix}`;
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
    finder_phone: '254700000011',
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

  const claimId = `TEST-CLAIM-B3-${SUFFIX}-${suffix}`;
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: '254700000012',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
    verification_tier: 1,
    status: 'escrow_held',
    owner_id_proof_url: null,
    payment_reference: `TEST-PAYREF-B3-${suffix}`,
    owner_identifying_details: null,
  } as any);

  return { claimId };
}

describe('settlement approval records WHAT it authorized', () => {
  it('persists the approved total and the exact payout rows', async () => {
    const { claimId } = await makeClaim('A');
    expect((await db.enterPendingSettlement(claimId, -60_000)).success).toBe(true);

    const payoutRows = (await db.getLedgerEntriesForClaim(claimId)).filter(
      (row) => row.type === 'finder_payout' || row.type === 'agent_payout',
    );
    expect(payoutRows).toHaveLength(2);
    const expectedTotalMinor = payoutRows.reduce(
      (sum, row) => sum + Math.round(row.amount * 100),
      0,
    );
    const expectedIds = payoutRows
      .map((row) => `${row.type === 'agent_payout' ? 'agent' : 'finder'}:${row.id}`)
      .sort();

    const approval = await db.approveSettlement(claimId, 'B3 fixture admin', 'approve for snapshot test');
    expect(approval.ok, approval.code).toBe(true);

    const claim = await db.getClaim(claimId);
    expect(claim!.settlement_authorized_total).toBe((expectedTotalMinor / 100).toFixed(2));
    const storedIds = String(claim!.settlement_authorized_ledger_ids).split(',').sort();
    expect(storedIds).toEqual(expectedIds);
    // Nothing about the ledger changed: approval never pays anything.
    expect(
      (await db.getLedgerEntriesForClaim(claimId)).map((row) => row.status),
    ).toEqual(expect.arrayContaining(['pending']));
  });

  it('does not let the snapshot mask the real reason an ineligible claim is refused', async () => {
    const { claimId } = await makeClaim('B');
    // Still escrow_held, so no payout rows exist and the settle_at window was
    // never set. The approval must report THAT, not an unreadable-snapshot code.
    const approval = await db.approveSettlement(claimId, 'B3 fixture admin', 'too early');
    expect(approval.ok).toBe(false);
    expect(approval.code).toBe('not_pending_settlement');
    expect((await db.getClaim(claimId))!.settlement_authorized_total ?? null).toBeNull();
  });

  it('a repeat approval loses the CAS and never rewrites who/when/what', async () => {
    const { claimId } = await makeClaim('C');
    expect((await db.enterPendingSettlement(claimId, -60_000)).success).toBe(true);
    expect((await db.approveSettlement(claimId, 'B3 first admin', 'first')).ok).toBe(true);
    const first = await db.getClaim(claimId);

    const second = await db.approveSettlement(claimId, 'B3 second admin', 'second');
    expect(second.ok).toBe(false);
    expect(second.code).toBe('already_approved');

    const after = await db.getClaim(claimId);
    expect(after!.settlement_approved_by).toBe('B3 first admin');
    expect(after!.settlement_approved_at).toBe(first!.settlement_approved_at);
    expect(after!.settlement_authorized_total).toBe(first!.settlement_authorized_total);
    expect(after!.settlement_authorized_ledger_ids).toBe(first!.settlement_authorized_ledger_ids);
  });

  // M5 — THE DUPLICATED-BOOKING APPROVAL GAP.
  //
  // The audit found that distinct rows for the SAME role were read as two
  // legitimate obligations, so a claim carrying four payout legs (two finder,
  // two agent) could be approved for a DOUBLED total. The 409 text already said
  // duplication was refused; only duplicate IDS were.
  //
  // The handover guard now prevents the double booking from being created at
  // all, so this fixture writes the second row directly — it models HISTORICAL
  // data (a claim double-booked before the guard existed), which is exactly the
  // state an approval must still refuse.
  //
  // Note on the assertion: the approval CAS is rolled back together with the
  // snapshot throw in PostgreSQL. The in-memory double strips BEGIN/ROLLBACK, so
  // it cannot witness that rollback; the refusal itself is what is asserted.
  it('M5: refuses to approve a claim whose ledger duplicates a payout role', async () => {
    const { claimId } = await makeClaim('DUP');
    expect((await db.enterPendingSettlement(claimId, -60_000)).success).toBe(true);

    const finderLeg = (await db.getLedgerEntriesForClaim(claimId)).find(
      (row) => row.type === 'finder_payout',
    )!;
    expect(finderLeg).toBeTruthy();
    await drizzle.insert(ledgerTable).values({
      id: `TXN-B3-DUP-${SUFFIX}`,
      claim_id: claimId,
      item_id: finderLeg.item_id,
      type: 'finder_payout',
      amount: finderLeg.amount,
      phone_or_till: finderLeg.phone_or_till,
      status: 'pending',
      payout_outcome: 'not_submitted',
    } as any);

    expect(
      (await db.getLedgerEntriesForClaim(claimId)).filter((row) => row.type === 'finder_payout'),
    ).toHaveLength(2);

    const approval = await db.approveSettlement(claimId, 'B3 fixture admin', 'duplicate role fixture');
    expect(approval.ok).toBe(false);
    expect(approval.code).toBe('payout_ledger_unreadable');
  });
});
