import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { testRunId } from './ensureTestCategory';

// =============================================================================
// HANDOVER CUSTODY GUARD — ONE PHYSICAL HANDOVER, ONE BOOKING
// =============================================================================
// THE DEFECT THIS PINS
//
//   `POST /api/agents/confirm-handover` used to accept a claim purely on
//   `claims.status === 'escrow_held'` and never asked whether the ITEM was still
//   in the hub's custody. `resolveDispute()` re-promotes a paid winner to
//   'escrow_held' from `paid_at` / the SC-3 snapshot only — it does not know
//   that the item was already handed over. Combined with the admin review-state
//   endpoints (`flag-stolen` / `clear-hold`), which can put a `claimed` item back
//   to 'at_agent', the same claim could be handed over a SECOND time and book a
//   second set of finder/agent/platform ledger rows for one physical handover.
//
// THE TWO GUARDS EXERCISED HERE (both inside enterPendingSettlement — the one
// transaction that books the money — not in the route):
//
//   1. HUB CUSTODY — the item must be 'at_agent' when the handover is booked,
//      enforced by a conditional UPDATE on items.status, plus a fail-fast read
//      for a precise message.
//   2. ONE HANDOVER PER CLAIM — the three settlement legs are booked once, ever.
//      Their presence means a previous occupancy already booked this claim, so a
//      second occupancy is refused even when custody was reset to 'at_agent'.
//
// Guard 2 is what makes the audited chain safe end-to-end: guard 1 alone cannot
// distinguish "never handed over" from "handed over, then had custody reset",
// because in both states items.status genuinely reads 'at_agent'.
//
// These are LOGIC/guard tests against the same in-memory sandbox the rest of the
// suite uses. They do not claim to prove PostgreSQL partial-index behaviour.
// =============================================================================

const DISPUTE_WINDOW_MS = 60 * 60 * 1000;

const AGENT_ID = `TEST-AGENT-HANDOVER-GUARD-${testRunId}`;
const CATEGORY_ID = `test-cat-handover-guard-${testRunId}`;
const FINDER_PHONE = '+254700000123';

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${testRunId}-${String(++counter).padStart(3, '0')}`;
const ownerPhone = (offset: number) => `+2547${testRunId}${String(offset % 100).padStart(2, '0')}`;

/** One agent + one category per file run, created idempotently. */
let fixtures: Promise<void> | null = null;
function ensureFixtures(): Promise<void> {
  if (!fixtures) {
    fixtures = (async () => {
      const categories = await db.getCategories();
      if (!categories.some((c) => c.id === CATEGORY_ID)) {
        await db.createCategory({
          id: CATEGORY_ID,
          name_en: 'Handover guard',
          name_sw: 'Ulinzi wa makabidhiano',
          total_fee: 1000,
          finder_share: 250,
          agent_share: 350,
          platform_share: 400,
          is_sensitive_document: false,
        });
      }
      const agents = await db.getAgents();
      if (!agents.some((a) => a.id === AGENT_ID)) {
        await db.createAgent({
          id: AGENT_ID,
          business_name: 'Handover Guard Hub',
          contact_phone: `+2547${testRunId}99`,
          location_address: 'Test location',
          latitude: null,
          longitude: null,
          mpesa_till_or_paybill: '123456',
          payout_method_type: 'Till Number',
          status: 'active',
          refundable_deposit: 0,
          national_id_hash: 'test-hash',
          needs_manual_geocoding: false,
        } as any);
      }
    })();
  }
  return fixtures;
}

/**
 * An item in the hub's custody plus a claim for it, ready to hand over.
 * `itemStatus` / `claimStatus` exist so a test can start from an abnormal state;
 * everything else mirrors a real pre-handover claim.
 */
async function makeHandoverFixture(opts: { itemStatus?: string; claimStatus?: string } = {}) {
  await ensureFixtures();
  const seq = ++counter;
  const itemId = nextId('TEST-ITEM-HG');
  await db.createItem({
    id: itemId,
    category_id: CATEGORY_ID,
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Test location',
    latitude: null,
    longitude: null,
    finder_phone: FINDER_PHONE,
    assigned_agent_id: AGENT_ID,
    status: opts.itemStatus ?? 'at_agent',
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

  const claimId = nextId('TEST-CLAIM-HG');
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: ownerPhone(seq),
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'fixture' },
    verification_tier: 1,
    status: opts.claimStatus ?? 'escrow_held',
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
  } as any);

  return { itemId, claimId };
}

/**
 * The same fixture, but with the claim genuinely PAID through the real
 * escrow-hold CAS (`attemptClaimEscrowHold` writes `paid_at`, the one
 * authoritative payment fact that resolveDispute() reads).
 */
async function makePaidHandoverFixture() {
  const { itemId, claimId } = await makeHandoverFixture({ claimStatus: 'pending_payment' });
  expect(await db.attemptClaimEscrowHold(claimId, nextId('MPESA-HG'))).toBe(true);
  expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
  expect((await db.getClaim(claimId))!.paid_at).toBeTruthy();
  return { itemId, claimId };
}

/**
 * A second, unpaid claimant on the same item, in the status a real contesting
 * claim is created in (the public claim route writes 'disputed' directly).
 */
async function makeContestingClaim(itemId: string) {
  const seq = ++counter;
  const claimId = nextId('TEST-CLAIM-HG-RIVAL');
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: ownerPhone(seq),
    security_answers: { lastDigits: '1111', color: 'blue', lostDetails: 'rival fixture' },
    verification_tier: 1,
    status: 'disputed',
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
  } as any);
  return claimId;
}

const settlementLegs = async (claimId: string) =>
  (await db.getLedgerEntriesForClaim(claimId)).filter((entry: any) =>
    ['finder_payout', 'agent_payout', 'platform_fee'].includes(entry.type),
  );

describe('M1/M8 — a legitimate first handover still works exactly as before', () => {
  it('books exactly one finder, one agent and one platform leg, and marks the item claimed', async () => {
    const { itemId, claimId } = await makePaidHandoverFixture();

    const result = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
    expect(result.success, result.message).toBe(true);
    expect(result.code).toBeUndefined();
    expect(result.settleAt).toBeInstanceOf(Date);

    const claim = await db.getClaim(claimId);
    expect(claim!.status).toBe('pending_settlement');
    expect(claim!.settle_at).toBeTruthy();
    // The custody fact is reported by the ITEM, not by the claim.
    expect((await db.getItem(itemId))!.status).toBe('claimed');

    const legs = await settlementLegs(claimId);
    expect(legs).toHaveLength(3);
    expect(legs.filter((l: any) => l.type === 'finder_payout')).toHaveLength(1);
    expect(legs.filter((l: any) => l.type === 'agent_payout')).toHaveLength(1);
    expect(legs.filter((l: any) => l.type === 'platform_fee')).toHaveLength(1);
    // The split still comes from the item's locked values (250/350/400 of 1000).
    expect(Number(legs.find((l: any) => l.type === 'finder_payout')!.amount)).toBe(250);
    expect(Number(legs.find((l: any) => l.type === 'agent_payout')!.amount)).toBe(350);
    expect(Number(legs.find((l: any) => l.type === 'platform_fee')!.amount)).toBe(400);
  });

  it('M8: concurrent first handovers — one wins, the loser books nothing and reports the CAS code', async () => {
    const { itemId, claimId } = await makePaidHandoverFixture();

    const [a, b] = await Promise.all([
      db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS),
      db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS),
    ]);

    const winners = [a, b].filter((r) => r.success);
    const losers = [a, b].filter((r) => !r.success);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].code).toBe('settlement_race_lost');

    expect(await settlementLegs(claimId)).toHaveLength(3);
    expect((await db.getItem(itemId))!.status).toBe('claimed');
    expect((await db.getClaim(claimId))!.status).toBe('pending_settlement');
  });
});

describe("M3/M4 — a handover is refused unless the item is in this hub's custody", () => {
  it('refuses a claimed item and leaves the claim, the item and the ledger untouched', async () => {
    const { itemId, claimId } = await makeHandoverFixture({ itemStatus: 'claimed' });

    const result = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
    expect(result.success).toBe(false);
    expect(result.code).toBe('item_not_in_custody');
    expect(result.message).toContain('custody');

    // Nothing moved: no claim transition, no ledger row, no new custody fact.
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
    expect(await settlementLegs(claimId)).toHaveLength(0);
    expect((await db.getItem(itemId))!.status).toBe('claimed');
  });

  for (const itemStatus of ['legal_hold', 'suspected_stolen', 'expired', 'rejected', 'awaiting_dropoff']) {
    it(`refuses an item in the incompatible custody state '${itemStatus}'`, async () => {
      const { itemId, claimId } = await makeHandoverFixture({ itemStatus });

      const result = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
      expect(result.success).toBe(false);
      expect(result.code).toBe('item_not_in_custody');
      expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
      expect(await settlementLegs(claimId)).toHaveLength(0);
      expect((await db.getItem(itemId))!.status).toBe(itemStatus);
    });
  }
});

describe('M1/M2/M7 — a dispute after a completed handover cannot resurrect a second booking', () => {
  it('the full audited chain: hold → clear-hold → dispute → resolve → second handover is refused', async () => {
    const { itemId, claimId } = await makePaidHandoverFixture();

    // ---- S1: the legitimate handover --------------------------------------
    expect((await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS)).success).toBe(true);
    expect(await settlementLegs(claimId)).toHaveLength(3);
    const settleAtAfterFirstHandover = (await db.getClaim(claimId))!.settle_at;

    // ---- S2/S3: an admin flags the already-claimed item, then clears it ---
    // (Those two endpoints have no custody precondition; they are what puts
    //  custody back to 'at_agent' and make the item look claimable again.)
    await db.updateItemStatus(itemId, 'legal_hold');
    await db.updateItemStatus(itemId, 'at_agent');
    expect((await db.getItem(itemId))!.status).toBe('at_agent');

    // ---- S4: a competing claimant, then the dispute -----------------------
    const rivalClaimId = await makeContestingClaim(itemId);
    const disputeId = nextId('TEST-DSP-HG');
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
    expect((await db.getClaim(claimId))!.status).toBe('disputed');

    // ---- S5: the original (paid) claimant wins ----------------------------
    const resolution = await db.resolveDispute(disputeId, claimId, 'test-admin', 'audited chain fixture');
    expect(resolution.refundNeededForClaimId).toBeNull();
    expect((await db.getClaim(rivalClaimId))!.status).toBe('rejected');
    // The claim is re-promoted to the pre-handover status...
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
    // ...and the item is back at 'at_agent', i.e. exactly the state the second
    // handover needs. This is the state the custody check alone cannot detect.
    expect((await db.getItem(itemId))!.status).toBe('at_agent');

    // ---- S6: the second handover must be refused --------------------------
    const second = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
    expect(second.success).toBe(false);
    expect(second.code).toBe('claim_already_handed_over');

    // ---- S7: nothing was re-booked and nothing was re-moved ---------------
    expect(await settlementLegs(claimId)).toHaveLength(3);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
    expect((await db.getClaim(claimId))!.settle_at).toEqual(settleAtAfterFirstHandover);
    expect((await db.getItem(itemId))!.status).toBe('at_agent');
  });

  it('refuses a second booking for an already-handed-over claim even at at_agent custody', async () => {
    const { itemId, claimId } = await makePaidHandoverFixture();
    expect((await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS)).success).toBe(true);

    // Force the two facts the audit's S5 produces: item at_agent, claim
    // escrow_held. (resolveDispute() produces exactly this pair; forced directly
    // here so the test pins the guard rather than the dispute implementation.)
    await db.updateItemStatus(itemId, 'at_agent');
    await db.updateClaimStatus(claimId, 'escrow_held');

    const second = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
    expect(second.success).toBe(false);
    expect(second.code).toBe('claim_already_handed_over');
    expect(await settlementLegs(claimId)).toHaveLength(3);
  });

  it('M8: concurrent attempts after the re-promotion book nothing (three legs, not six)', async () => {
    const { itemId, claimId } = await makePaidHandoverFixture();
    expect((await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS)).success).toBe(true);
    await db.updateItemStatus(itemId, 'at_agent');
    await db.updateClaimStatus(claimId, 'escrow_held');

    const attempts = await Promise.all([
      db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS),
      db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS),
      db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS),
    ]);

    expect(attempts.every((r) => r.success === false)).toBe(true);
    expect(attempts.every((r) => r.code === 'claim_already_handed_over')).toBe(true);
    expect(await settlementLegs(claimId)).toHaveLength(3);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
  });
});
