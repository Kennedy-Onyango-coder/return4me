import { describe, it, expect } from 'vitest';
import { db, ADMIN_CLAIMS_MAX_LIMIT } from '../database';
import { toAdminSafeClaimListView, toAdminSafeClaimDetailView } from '../../services/adminSafeViews';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// =============================================================================
// PHASE 6D — CLAIMS ADMINISTRATION READ/DATA LAYER
// =============================================================================
// Covers: list/detail DTO field allowlists, payment truth from paid_at only,
// dispute snapshot (historical vs current), bounded+deterministic pagination,
// filters, read-only guarantee, and privacy (no secrets, no raw rows).
//
// DB-level against the in-memory sandbox. It proves the LOGIC, the DTO
// boundaries and the guards. It does NOT prove PostgreSQL ORDER BY/LIMIT/
// OFFSET behaviour: the sandbox ignores them, which is exactly why the data
// layer re-applies the same ordering/window defensively. See the report.

let counter = 0;

async function makeItem(suffix: string, categoryId = 'phone') {
  const itemId = `TEST-ITEM-6D-${suffix}-${testRunId}-${counter++}`;
  await ensureTestCategory(categoryId);
  await db.createItem({
    id: itemId, category_id: categoryId, photo_url: 'test-photo.jpg', ocr_extracted_number: null,
    ocr_extracted_name: null, document_number_hash: null, document_name_fuzzy: 'Fuzzy Name',
    location_description: 'Test location', latitude: null, longitude: null,
    finder_phone: '+254700000031', assigned_agent_id: null, status: 'at_agent',
    flaggedForReview: false, isDescriptionOnly: false, description: 'desc',
    is_sensitive_document: false, rejection_reason: null, locked_total_fee: '500',
  } as any);
  return itemId;
}

async function makeClaim(itemId: string, suffix: string, status: string, opts: { phone?: string } = {}) {
  const claimId = `TEST-CLAIM-6D-${suffix}-${testRunId}-${counter++}`;
  await db.createClaim({
    id: claimId, item_id: itemId,
    owner_phone: opts.phone ?? `+2547000${String(counter).padStart(5, '0')}`,
    security_answers: { lastDigits: '1234', color: 'black', lostDetails: 'SECRET-ANSWER' },
    verification_tier: 2, status: status as any,
    owner_id_proof_url: 'SECRET-ID-PROOF-KEY', payment_reference: null,
    owner_identifying_details: 'SECRET-IDENTIFYING-DETAIL',
  } as any);
  return claimId;
}

/** A paid claim: taken through the REAL authoritative CAS. */
async function makePaidClaim(itemId: string, suffix: string) {
  const claimId = await makeClaim(itemId, suffix, 'pending_payment');
  expect(await db.attemptClaimEscrowHold(claimId, `MPESA-${suffix}-${testRunId}`)).toBe(true);
  return claimId;
}

/** Serialised DTO text, for "must never contain" assertions. */
function json(dto: any): string {
  return JSON.stringify(dto);
}

// ---------------------------------------------------------------------------
// A/B/M/L — DTO shape, no raw rows, no secrets
// ---------------------------------------------------------------------------
describe('6D: list DTO is an explicit allowlist (no raw claim row, no secrets)', () => {
  it('exposes exactly the intended top-level fields', async () => {
    const itemId = await makeItem('SHAPE');
    const claimId = await makeClaim(itemId, 'SHAPE', 'pending_verification');
    const { rows } = await db.listAdminClaims({ filters: { claimId } });
    expect(rows).toHaveLength(1);
    const dto = toAdminSafeClaimListView(rows[0]);

    expect(Object.keys(dto).sort()).toEqual([
      'agent', 'agent_confirmed_at', 'claimant_phone', 'created_at', 'dispute',
      'financial_state', 'has_paid', 'id', 'is_active', 'item', 'paid_at',
      'payment_state', 'status', 'updated_at', 'verification_tier',
    ].sort());
  });

  it('never contains raw claim columns, secrets, or storage keys', async () => {
    const itemId = await makeItem('NOSECRETS');
    const claimId = await makeClaim(itemId, 'NOSECRETS', 'pending_verification');
    const { rows } = await db.listAdminClaims({ filters: { claimId } });
    const text = json(toAdminSafeClaimListView(rows[0]));

    for (const forbidden of [
      'security_answers', 'SECRET-ANSWER', 'owner_id_proof_url', 'SECRET-ID-PROOF-KEY',
      'owner_identifying_details', 'SECRET-IDENTIFYING-DETAIL', 'owner_email',
      'payment_reference', 'code_hash', 'token_hash', 'otp', 'national_id',
    ]) {
      expect(text, `list DTO leaked: ${forbidden}`).not.toContain(forbidden);
    }
    // And the raw phone number is never present as-is.
    const phone = rows[0].owner_phone;
    expect(text).not.toContain(phone);
    expect(toAdminSafeClaimListView(rows[0]).claimant_phone).toContain('***');
  });

  it('detail DTO omits the same secrets and exposes only presence booleans', async () => {
    const itemId = await makeItem('DETAILSAFE');
    const claimId = await makeClaim(itemId, 'DETAILSAFE', 'pending_verification');
    const row = await db.getAdminClaimDetail(claimId);
    const dto = toAdminSafeClaimDetailView(row);
    const text = json(dto);

    for (const forbidden of [
      'security_answers', 'SECRET-ANSWER', 'SECRET-ID-PROOF-KEY', 'SECRET-IDENTIFYING-DETAIL',
      'owner_id_proof_url', 'owner_identifying_details', 'payment_reference', 'code_hash', 'token_hash',
    ]) {
      expect(text, `detail DTO leaked: ${forbidden}`).not.toContain(forbidden);
    }
    expect(dto.verification.identifying_detail_present).toBe(true); // value present, value NOT exposed
    expect(dto.verification.id_proof_present).toBe(true);
    expect(dto.verification.handover_photo_present).toBe(false);
  });

  it('returns null (never a fabricated object) for an unknown claim', async () => {
    expect(await db.getAdminClaimDetail(`NO-SUCH-CLAIM-${testRunId}`)).toBeNull();
    expect(toAdminSafeClaimDetailView(null)).toBeNull();
    expect(toAdminSafeClaimListView(null)).toBeNull();
  });

// ---------------------------------------------------------------------------
// C/D/E/F — PAYMENT TRUTH
// ---------------------------------------------------------------------------
describe('6D: has_paid is derived from paid_at and nothing else', () => {
  it('paid_at null => has_paid false', async () => {
    const itemId = await makeItem('PT-NULL');
    const claimId = await makeClaim(itemId, 'PT-NULL', 'pending_verification');
    const { rows } = await db.listAdminClaims({ filters: { claimId } });
    const dto = toAdminSafeClaimListView(rows[0]);
    expect(dto.paid_at).toBeNull();
    expect(dto.has_paid).toBe(false);
    expect(dto.payment_state).toBe('unpaid');
  });

  it('paid_at set => has_paid true', async () => {
    const itemId = await makeItem('PT-SET');
    const claimId = await makePaidClaim(itemId, 'PT-SET');
    const { rows } = await db.listAdminClaims({ filters: { claimId } });
    const dto = toAdminSafeClaimListView(rows[0]);
    expect(dto.paid_at).toBeTruthy();
    expect(dto.has_paid).toBe(true);
    expect(dto.payment_state).toBe('paid');
    expect(dto.financial_state).toBe('escrow_held');
  });

  it('payment_reference set while paid_at null => has_paid FALSE (SC-4/SC-6)', async () => {
    const itemId = await makeItem('PT-REFONLY');
    const claimId = await makeClaim(itemId, 'PT-REFONLY', 'pending_payment');
    // Exactly the legacy /pay misuse: a provider reference with no payment.
    await db.updateClaimStatus(claimId, 'pending_payment', 'CHECKOUT-ID-ABC');
    const { rows } = await db.listAdminClaims({ filters: { claimId } });
    expect(rows[0].paid_at).toBeNull();
    const dto = toAdminSafeClaimListView(rows[0]);
    expect(dto.has_paid).toBe(false);
    expect(dto.payment_state).toBe('unpaid');
  });

  it('payment_reference null while paid_at set => has_paid TRUE', async () => {
    const itemId = await makeItem('PT-NOREF');
    const claimId = await makeClaim(itemId, 'PT-NOREF', 'pending_payment');
    // No provider reference at all, but the guarded CAS confirms the payment.
    expect(await db.attemptClaimEscrowHold(claimId, '')).toBe(true);
    const row = await db.getAdminClaimDetail(claimId);
    expect(row!.paid_at).toBeTruthy();
    expect(toAdminSafeClaimDetailView(row).has_paid).toBe(true);
  });

  it('both set => has_paid true, and has_paid/paid_at can never disagree', async () => {
    const itemId = await makeItem('PT-BOTH');
    const claimId = await makePaidClaim(itemId, 'PT-BOTH');
    const { rows } = await db.listAdminClaims({ filters: { claimId } });
    const dto = toAdminSafeClaimListView(rows[0]);
    expect(dto.has_paid).toBe(true);
    expect(dto.paid_at).not.toBeNull();
    // The invariant, asserted directly.
    expect(dto.has_paid).toBe(dto.paid_at !== null);
  });
});


// ---------------------------------------------------------------------------
// G/H/P — DISPUTE SNAPSHOT (historical) vs CURRENT state
// ---------------------------------------------------------------------------
describe('6D: dispute context keeps historical snapshot and current state separate', () => {
  async function makeDisputeFixture(suffix: string) {
    const itemId = await makeItem(suffix);
    const paidOriginal = await makePaidClaim(itemId, `${suffix}-ORIG`);
    const contesting = await makeClaim(itemId, `${suffix}-CONT`, 'disputed');
    const disputeId = `TEST-DSP-6D-${suffix}-${testRunId}`;
    await db.createDispute({
      id: disputeId, item_id: itemId,
      claimant_1_claim_id: paidOriginal, claimant_2_claim_id: contesting,
      claimant_1_id_proof_url: 'p1', claimant_2_id_proof_url: 'p2',
      resolved_by: null, resolved_claim_id: null, resolved_at: null, admin_notes: null,
    } as any);
    return { itemId, paidOriginal, contesting, disputeId };
  }

  it('list: dispute state/role come from the participants, not array position', async () => {
    const { paidOriginal, disputeId } = await makeDisputeFixture('DSPLIST');
    const { rows } = await db.listAdminClaims({ filters: { claimId: paidOriginal } });
    const dto = toAdminSafeClaimListView(rows[0]);
    expect(dto.dispute.state).toBe('open');
    expect(dto.dispute.id).toBe(disputeId);
    expect(dto.dispute.role).toBe('original'); // claimant_1
  });

  it('detail: status_at_dispute is the SNAPSHOT, not the current (disputed) status', async () => {
    const { paidOriginal } = await makeDisputeFixture('DSPSNAP');
    const dto = toAdminSafeClaimDetailView(await db.getAdminClaimDetail(paidOriginal));
    // Current status was overwritten to 'disputed' by createDispute...
    expect(dto.dispute.this_claim.current_status).toBe('disputed');
    // ...but the historical snapshot still records what it actually was.
    expect(dto.dispute.this_claim.status_at_dispute).toBe('escrow_held');
    expect(dto.dispute.this_claim.paid_at_dispute).toBeTruthy();
    expect(dto.dispute.this_claim.current_paid_at).toBeTruthy();
    expect(dto.dispute.snapshot_incomplete).toBe(false);
  });

  it('detail: the opposing claimant is identified with the opposite role', async () => {
    const { paidOriginal, contesting } = await makeDisputeFixture('DSPOTHER');
    const dto = toAdminSafeClaimDetailView(await db.getAdminClaimDetail(paidOriginal));
    expect(dto.dispute.other_claim.claim_id).toBe(contesting);
    expect(dto.dispute.other_claim.role).toBe('contesting');
    expect(dto.dispute.other_claim.paid_at_dispute ?? null).toBeNull();
  });

  it('snapshot_incomplete reflects real columns (false when the snapshot exists)', async () => {
    const { paidOriginal } = await makeDisputeFixture('DSPFLAG');
    const dto = toAdminSafeClaimDetailView(await db.getAdminClaimDetail(paidOriginal));
    expect(dto.dispute.snapshot_incomplete).toBe(false);
  });

  it('a claim with no dispute reports state "none" (never a fabricated dispute)', async () => {
    const itemId = await makeItem('NOSDISPUTE');
    const claimId = await makeClaim(itemId, 'NOSDISPUTE', 'pending_verification');
    const dto = toAdminSafeClaimDetailView(await db.getAdminClaimDetail(claimId));
    expect(dto.dispute).toBeNull();
    expect(toAdminSafeClaimListView((await db.listAdminClaims({ filters: { claimId } })).rows[0]).dispute)
      .toEqual({ state: 'none', id: null, role: null, snapshot_incomplete: false });
  });
});


// ---------------------------------------------------------------------------
// I — PAGINATION
// ---------------------------------------------------------------------------
describe('6D: bounded, deterministic pagination', () => {
  it('honours the page size, reports hasMore, and is deterministic', async () => {
    const itemIds: string[] = [];
    for (let i = 0; i < 5; i++) itemIds.push(await makeItem(`PAGE-${i}`));
    const claimIds: string[] = [];
    for (let i = 0; i < 5; i++) claimIds.push(await makeClaim(itemIds[i], `PAGE-${i}`, 'pending_verification'));

    // One row per item; the per-item filter keeps the global table out of it.
    let seen: string[] = [];
    for (const id of itemIds) {
      const page = await db.listAdminClaims({ filters: { itemId: id }, limit: 1 });
      expect(page.rows.length).toBeLessThanOrEqual(1);
      expect(page.hasMore).toBe(false);
      seen = seen.concat(page.rows.map((r) => r.id));
    }
    expect(seen.sort()).toEqual(claimIds.sort());

    // Determinism: two identical calls return an identical id order.
    const a = await db.listAdminClaims({ filters: { itemId: itemIds[0] }, limit: 10 });
    const b = await db.listAdminClaims({ filters: { itemId: itemIds[0] }, limit: 10 });
    expect(a.rows.map((r) => r.id)).toEqual(b.rows.map((r) => r.id));
  });

  it('caps the page size at ADMIN_CLAIMS_MAX_LIMIT', async () => {
    const { rows } = await db.listAdminClaims({ limit: 100000 });
    expect(rows.length).toBeLessThanOrEqual(ADMIN_CLAIMS_MAX_LIMIT);
  });

  it('offset advances the window and a past-the-end offset yields no rows', async () => {
    const itemId = await makeItem('OFFSET');
    const claimId = await makeClaim(itemId, 'OFFSET-1', 'pending_verification');

    const first = await db.listAdminClaims({ filters: { itemId }, offset: 0, limit: 5 });
    expect(first.rows.map((r) => r.id)).toEqual([claimId]);

    const past = await db.listAdminClaims({ filters: { itemId }, offset: 5, limit: 5 });
    expect(past.rows).toEqual([]);
    expect(past.hasMore).toBe(false);
  });

  it('returns an empty page (not an error) when nothing matches', async () => {
    const page = await db.listAdminClaims({ filters: { claimId: `NOPE-${testRunId}` } });
    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// J — FILTERS
// ---------------------------------------------------------------------------
describe('6D: server-side filters', () => {
  it('filters by hasPaid using paid_at only', async () => {
    const paidItem = await makeItem('F-PAID');
    const paidClaim = await makePaidClaim(paidItem, 'F-PAID');
    const unpaidItem = await makeItem('F-UNPAID');
    const unpaidClaim = await makeClaim(unpaidItem, 'F-UNPAID', 'pending_payment');
    // Give the unpaid one a provider reference — it must NOT count as paid.
    await db.updateClaimStatus(unpaidClaim, 'pending_payment', 'REF-ONLY');

    const paid = await db.listAdminClaims({ filters: { itemId: paidItem, hasPaid: true } });
    expect(paid.rows.map((r) => r.id)).toEqual([paidClaim]);

    const unpaid = await db.listAdminClaims({ filters: { itemId: unpaidItem, hasPaid: false } });
    expect(unpaid.rows.map((r) => r.id)).toEqual([unpaidClaim]);

    // ...and the reference-only claim is NOT returned by the paid filter.
    const crossCheck = await db.listAdminClaims({ filters: { itemId: unpaidItem, hasPaid: true } });
    expect(crossCheck.rows).toEqual([]);
  });

  it('filters by status', async () => {
    const itemId = await makeItem('F-STATUS');
    const claimId = await makeClaim(itemId, 'F-STATUS', 'rejected');
    const hit = await db.listAdminClaims({ filters: { itemId, statuses: ['rejected'] } });
    expect(hit.rows.map((r) => r.id)).toContain(claimId);
    const miss = await db.listAdminClaims({ filters: { itemId, statuses: ['released'] } });
    expect(miss.rows).toEqual([]);
  });

  it('filters by exact claim id, item id and claimant phone', async () => {
    const itemId = await makeItem('F-IDS');
    const phone = `+2547${String(testRunId).slice(0, 6)}00`;
    const claimId = await makeClaim(itemId, 'F-IDS', 'pending_verification', { phone });

    expect((await db.listAdminClaims({ filters: { itemId } })).rows.map((r) => r.id)).toContain(claimId);
    expect((await db.listAdminClaims({ filters: { claimId } })).rows.map((r) => r.id)).toEqual([claimId]);
    expect((await db.listAdminClaims({ filters: { claimantPhone: phone } })).rows.map((r) => r.id)).toContain(claimId);
    expect((await db.listAdminClaims({ filters: { claimantPhone: '+254799999999' } })).rows
      .map((r) => r.id)).not.toContain(claimId);
  });

  it('filters by disputeState open / none', async () => {
    const itemId = await makeItem('F-DSP');
    const a = await makeClaim(itemId, 'F-DSP-A', 'disputed');
    const b = await makeClaim(itemId, 'F-DSP-B', 'disputed');
    await db.createDispute({
      id: `TEST-DSP-6D-FILTER-${testRunId}`, item_id: itemId,
      claimant_1_claim_id: a, claimant_2_claim_id: b,
      claimant_1_id_proof_url: 'p1', claimant_2_id_proof_url: 'p2',
      resolved_by: null, resolved_claim_id: null, resolved_at: null, admin_notes: null,
    } as any);

    const open = await db.listAdminClaims({ filters: { itemId, disputeState: 'open' } });
    expect(open.rows.map((r) => r.id).sort()).toEqual([a, b].sort());

    const none = await db.listAdminClaims({ filters: { itemId, disputeState: 'none' } });
    expect(none.rows).toEqual([]);

    const cleanItem = await makeItem('F-DSP-CLEAN');
    const clean = await makeClaim(cleanItem, 'F-DSP-CLEAN', 'pending_verification');
    const noneForClean = await db.listAdminClaims({ filters: { itemId: cleanItem, disputeState: 'none' } });
    expect(noneForClean.rows.map((r) => r.id)).toEqual([clean]);
  });

  it('applies a created-date filter (impossible range => no rows)', async () => {
    const itemId = await makeItem('F-DATE');
    await makeClaim(itemId, 'F-DATE', 'pending_verification');
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const none = await db.listAdminClaims({ filters: { itemId, createdFrom: future } });
    expect(none.rows).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// N — READS MUST NOT MUTATE
// ---------------------------------------------------------------------------
describe('6D: the read layer never mutates claim state', () => {
  it('list + detail leave status, paid_at and timestamps untouched', async () => {
    const itemId = await makeItem('READONLY');
    const claimId = await makePaidClaim(itemId, 'READONLY');

    const before = await db.getClaim(claimId);
    await db.listAdminClaims({ limit: 100 });
    await db.getAdminClaimDetail(claimId);
    await db.listAdminClaims({ filters: { claimId, disputeState: 'none', hasPaid: true } });
    const after = await db.getClaim(claimId);

    expect(after!.status).toBe(before!.status);
    expect(after!.paid_at).toBe(before!.paid_at);
    expect(after!.updated_at).toBe(before!.updated_at);
    expect(after!.payment_reference).toBe(before!.payment_reference);
  });

  it('reading a pending_payment claim does not expire it or consume any OTP', async () => {
    const itemId = await makeItem('READONLY2');
    const claimId = await makeClaim(itemId, 'READONLY2', 'pending_payment');
    // A live OTP challenge exists...
    await db.setClaimOtp(claimId, 'hash-abc', new Date(Date.now() + 60_000));

    await db.listAdminClaims({ filters: { itemId } });
    await db.getAdminClaimDetail(claimId);

    // ...and is still there afterwards, and the claim has not expired.
    expect(await db.getClaimOtp(claimId)).toBeDefined();
    expect((await db.getClaim(claimId))!.status).toBe('pending_payment');
  });
});


// ---------------------------------------------------------------------------
// O/P/Q/R — STATE REPRESENTATION
// ---------------------------------------------------------------------------
describe('6D: lifecycle states are represented correctly', () => {
  it('terminal claims report is_active false; live claims true', async () => {
    const cases: Array<[string, boolean]> = [
      ['released', false], ['refunded', false], ['rejected', false],
      ['payment_window_expired', false], ['pending_verification', true],
      ['awaiting_agent_confirmation', true], ['pending_payment', true],
    ];
    for (const [status, expectedActive] of cases) {
      const itemId = await makeItem(`ST-${status}`);
      const claimId = await makeClaim(itemId, `ST-${status}`, status);
      const dto = toAdminSafeClaimListView((await db.listAdminClaims({ filters: { claimId } })).rows[0]);
      expect(dto.is_active, `status ${status}`).toBe(expectedActive);
    }
  });

  it('refunding / refunded states are represented without fabricating a money amount', async () => {
    const itemId = await makeItem('ST-REFUND');
    const claimId = await makeClaim(itemId, 'ST-REFUND', 'refunding');
    const dto = toAdminSafeClaimListView((await db.listAdminClaims({ filters: { claimId } })).rows[0]);
    expect(dto.financial_state).toBe('refunding');
    // No monetary field is fabricated anywhere in the DTO.
    expect(json(dto)).not.toMatch(/amount|balance|kes/i);

    const itemId2 = await makeItem('ST-REFUNDED');
    const claimId2 = await makeClaim(itemId2, 'ST-REFUNDED', 'refunded');
    expect(toAdminSafeClaimListView((await db.listAdminClaims({ filters: { claimId: claimId2 } })).rows[0])
      .financial_state).toBe('refunded');
  });

  it('item status is reported as data only — the DTO cannot imply a reopening', async () => {
    const itemId = await makeItem('ST-ITEM');
    const claimId = await makeClaim(itemId, 'ST-ITEM', 'pending_verification');
    await db.updateItemStatus(itemId, 'claimed');

    const dto = toAdminSafeClaimDetailView(await db.getAdminClaimDetail(claimId));
    expect(dto.item.status).toBe('claimed');
    // The read DTO exposes item status but no field that could be mistaken for
    // an instruction to change it.
    expect(Object.keys(dto.item).sort()).toEqual([
      'category_id', 'category_name_en', 'description', 'flagged_for_review',
      'id', 'is_sensitive_document', 'location_description', 'status',
    ].sort());
  });

  it('a disputed claim and its sibling claim are both visible on the detail read', async () => {
    const itemId = await makeItem('ST-DISPUTED');
    const a = await makeClaim(itemId, 'ST-DISPUTED-A', 'disputed');
    const b = await makeClaim(itemId, 'ST-DISPUTED-B', 'disputed');
    const dto = toAdminSafeClaimDetailView(await db.getAdminClaimDetail(a));
    expect(dto.status).toBe('disputed');
    expect(dto.sibling_claims.map((s: any) => s.id)).toContain(b);
  });
});

// ---------------------------------------------------------------------------
// S — EXISTING PRIVACY GUARANTEES STILL INTACT
// ---------------------------------------------------------------------------
describe('6D: existing adminSafeViews guarantees are not weakened', () => {
  it('the dispute DTO still excludes payment_reference and derives has_paid_escrow from paid_at', async () => {
    const { toAdminSafeDisputeView } = await import('../../services/adminSafeViews');
    const view = toAdminSafeDisputeView(
      {
        id: 'DSP-1', item_id: 'ITM-1', created_at: null,
        claimant_1_claim_id: 'C1', claimant_2_claim_id: 'C2',
        resolved_by: null, resolved_claim_id: null, resolved_at: null, admin_notes: 'INTERNAL',
      },
      new Map([
        ['C1', { id: 'C1', status: 'disputed', owner_phone: '+254700000001', paid_at: null, payment_reference: 'REF-ONLY' }],
        ['C2', { id: 'C2', status: 'disputed', owner_phone: '+254700000002', paid_at: '2026-01-01T00:00:00.000Z', payment_reference: null }],
      ]) as any,
    );
    expect(view.claimants[0].has_paid_escrow).toBe(false); // reference without paid_at
    expect(view.claimants[1].has_paid_escrow).toBe(true);  // paid_at without a reference
    expect(JSON.stringify(view)).not.toContain('payment_reference');
    expect(JSON.stringify(view)).not.toContain('INTERNAL');
  });
});

});
