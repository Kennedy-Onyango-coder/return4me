import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { testRunId } from './ensureTestCategory';

// =============================================================================
// BATCH 1 — THE ONE WRITE, AND THE SETTLEMENT GATE IT MUST NOT WEAKEN.
// =============================================================================
// confirmPayoutVerified() is the only way provider evidence may complete a
// payout leg. It is a compare-and-swap, not a read-then-write, so the guard
// holds even when two deliveries of the same event overlap.
//
// The final describe here is the requirement that matters most in production:
// verifying ONE leg must not release the settlement. finalizeSettlement() keeps
// its own "every finder/agent leg is genuinely completed?" guard, and it must
// still refuse right up until the LAST leg is provider-verified.
//
// Runs against the isolated in-memory database (no DATABASE_URL => MockPool), so
// no real Postgres is touched.
// =============================================================================

const FIXTURE_CLAIM = `TEST-CLAIM-B1-CAS-${testRunId}`;
let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${testRunId}-${seq}`;
}

/** A payout ledger row in exactly the state a test needs. */
async function makeLedgerRow(opts: {
  type?: 'finder_payout' | 'agent_payout' | 'platform_fee';
  status?: 'pending' | 'completed' | 'failed';
  payout_outcome?: string | null;
  provider_transaction_id?: string | null;
}): Promise<string> {
  const entry = await db.logTransaction({
    claim_id: FIXTURE_CLAIM,
    item_id: `TEST-ITEM-B1-CAS-${testRunId}`,
    type: opts.type ?? 'finder_payout',
    amount: 100,
    phone_or_till: '+254700000099',
    status: opts.status ?? 'pending',
    provider_transaction_id: opts.provider_transaction_id ?? null,
    payout_outcome: opts.payout_outcome ?? null,
  } as any);
  return entry.id;
}

async function readLedgerRow(claimId: string, id: string) {
  const rows = await db.getLedgerEntriesForClaim(claimId);
  return rows.find((r) => r.id === id) ?? null;
}

describe('BATCH 1 — confirmPayoutVerified completes ONLY a positively in-flight payout', () => {
  it('completes an in-flight leg and records the provider identity', async () => {
    for (const outcome of ['submitting', 'accepted', 'unknown']) {
      const id = await makeLedgerRow({ payout_outcome: outcome });
      const batch = nextId('TRK-B1');
      const txn = nextId('TX-B1');
      expect(await db.confirmPayoutVerified(id, { providerBatchId: batch, providerTransactionId: txn }), outcome).toBe(true);
      const row = await readLedgerRow(FIXTURE_CLAIM, id);
      expect(row?.status, outcome).toBe('completed');
      expect(row?.payout_outcome, outcome).toBe('completed');
      expect(row?.provider_batch_id, outcome).toBe(batch);
      expect(row?.provider_transaction_id, outcome).toBe(txn);
    }
  });

  it('NEVER completes a legacy row whose submission history is NULL', async () => {
    // The fail-closed case: a row written before payout_outcome existed. We
    // cannot prove it was ever submitted, so a provider "completed" status must
    // not complete it.
    const id = await makeLedgerRow({ payout_outcome: null, provider_transaction_id: 'TX-LEGACY-B1' });
    const won = await db.confirmPayoutVerified(id, {
      providerBatchId: 'TRK-LEGACY-B1',
      providerTransactionId: 'TX-LEGACY-B1',
    });
    expect(won).toBe(false);
    const row = await readLedgerRow(FIXTURE_CLAIM, id);
    expect(row?.status).toBe('pending');
    expect(row?.payout_outcome).toBeNull();
    expect(row?.provider_batch_id).toBeNull();
  });

  it('NEVER completes a row that was never submitted', async () => {
    const id = await makeLedgerRow({ payout_outcome: 'not_submitted' });
    expect(await db.confirmPayoutVerified(id, { providerBatchId: 'TRK-NS-B1', providerTransactionId: 'TX-NS-B1' })).toBe(false);
    const row = await readLedgerRow(FIXTURE_CLAIM, id);
    expect(row?.status).toBe('pending');
    expect(row?.payout_outcome).toBe('not_submitted');
  });

  it('NEVER completes a row the provider had already refused', async () => {
    const id = await makeLedgerRow({ payout_outcome: 'rejected' });
    expect(await db.confirmPayoutVerified(id, { providerBatchId: 'TRK-RJ-B1', providerTransactionId: 'TX-RJ-B1' })).toBe(false);
    const row = await readLedgerRow(FIXTURE_CLAIM, id);
    expect(row?.status).toBe('pending');
    expect(row?.payout_outcome).toBe('rejected');
  });

  it('NEVER completes a row whose status is already failed', async () => {
    const id = await makeLedgerRow({ status: 'failed', payout_outcome: 'accepted' });
    expect(await db.confirmPayoutVerified(id)).toBe(false);
    expect((await readLedgerRow(FIXTURE_CLAIM, id))?.status).toBe('failed');
  });

  it('is idempotent: the first caller wins and every later call is a no-op', async () => {
    const id = await makeLedgerRow({ payout_outcome: 'accepted' });
    const first = await db.confirmPayoutVerified(id, { providerBatchId: 'TRK-DUP-B1', providerTransactionId: 'TX-DUP-B1' });
    const second = await db.confirmPayoutVerified(id, { providerBatchId: 'TRK-DUP-B1', providerTransactionId: 'TX-DUP-B1' });
    const third = await db.confirmPayoutVerified(id);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(false);
    const row = await readLedgerRow(FIXTURE_CLAIM, id);
    expect(row?.status).toBe('completed');
    // The losing calls must not have clobbered the winning identity.
    expect(row?.provider_batch_id).toBe('TRK-DUP-B1');
    expect(row?.provider_transaction_id).toBe('TX-DUP-B1');
  });

  it('preserves the provider identity already on the row when the caller supplies none', async () => {
    const id = await makeLedgerRow({ payout_outcome: 'not_submitted' });
    await db.recordPayoutAttempt(id, {
      status: 'pending',
      providerBatchId: 'TRK-KEEP-B1',
      providerTransactionId: 'TX-KEEP-B1',
    });
    expect(await db.confirmPayoutVerified(id, {})).toBe(true);
    const row = await readLedgerRow(FIXTURE_CLAIM, id);
    expect(row?.status).toBe('completed');
    expect(row?.provider_batch_id).toBe('TRK-KEEP-B1');
    expect(row?.provider_transaction_id).toBe('TX-KEEP-B1');
  });

  it('refuses an unknown ledger id', async () => {
    expect(await db.confirmPayoutVerified(`TXN-DOES-NOT-EXIST-${testRunId}`)).toBe(false);
  });
});

describe('BATCH 1 — getPayoutLegsByProviderBatchId is scoped to one batch and to payout rows', () => {
  it('returns only the finder/agent legs carrying that batch id', async () => {
    const finderId = await makeLedgerRow({ type: 'finder_payout', payout_outcome: 'not_submitted' });
    const agentId = await makeLedgerRow({ type: 'agent_payout', payout_outcome: 'not_submitted' });
    const feeId = await makeLedgerRow({ type: 'platform_fee', payout_outcome: 'not_submitted' });
    const otherId = await makeLedgerRow({ type: 'finder_payout', payout_outcome: 'not_submitted' });
    const BATCH = nextId('TRK-B1-SCOPE');
    for (const id of [finderId, agentId, feeId]) {
      await db.recordPayoutAttempt(id, {
        status: 'pending',
        providerBatchId: BATCH,
        providerTransactionId: nextId('TX-B1-SCOPE'),
      });
    }
    await db.recordPayoutAttempt(otherId, {
      status: 'pending',
      providerBatchId: nextId('TRK-B1-OTHER'),
      providerTransactionId: nextId('TX-B1-OTHER'),
    });

    const legs = await db.getPayoutLegsByProviderBatchId(BATCH);
    const ids = legs.map((l) => l.id).sort();
    expect(ids).toEqual([finderId, agentId].sort());
    expect(ids).not.toContain(feeId);
    expect(ids).not.toContain(otherId);
    expect(legs.every((l) => l.provider_batch_id === BATCH)).toBe(true);
  });

  it('returns nothing for a blank or unknown batch id', async () => {
    expect(await db.getPayoutLegsByProviderBatchId('')).toEqual([]);
    expect(await db.getPayoutLegsByProviderBatchId('   ')).toEqual([]);
    expect(await db.getPayoutLegsByProviderBatchId(`TRK-B1-NOPE-${testRunId}`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE SETTLEMENT GATE — verifying one leg is NOT settling the claim.
// ---------------------------------------------------------------------------
const DISPUTE_WINDOW_MS = 0;

async function makeAgent(suffix: string) {
  const id = `TEST-AGENT-B1-SETTLE-${testRunId}-${suffix}`;
  await db.createAgent({
    id,
    business_name: 'Batch 1 Settlement Gate Hub',
    contact_phone: `+2547${testRunId}${suffix}`,
    location_address: 'Test location',
    latitude: null,
    longitude: null,
    mpesa_till_or_paybill: '123456',
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-b1-settle',
    needs_manual_geocoding: false,
  } as any);
  return id;
}

async function makeCategory(suffix: string) {
  const id = `test-cat-b1-settle-${testRunId}-${suffix}`;
  const existing = await db.getCategories();
  if (existing.some((c) => c.id === id)) return id;
  await db.createCategory({
    id,
    name_en: 'Batch 1 Settlement Category',
    name_sw: 'Kategoria ya Malipo',
    total_fee: 1000,
    finder_share: 250,
    agent_share: 350,
    platform_share: 400,
    is_sensitive_document: false,
  });
  return id;
}

/** A claim locked in 'releasing' with its two payout legs booked but not paid. */
async function makeReleasingClaim(suffix: string) {
  const categoryId = await makeCategory(suffix);
  const agentId = await makeAgent(suffix);
  const itemId = `TEST-ITEM-B1-SETTLE-${testRunId}-${suffix}`;
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
    finder_phone: '+254700000021',
    assigned_agent_id: agentId,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: false,
    rejection_reason: null,
    locked_total_fee: 1000,
    locked_finder_share: 250,
    locked_agent_share: 350,
    locked_platform_share: 400,
  } as any);

  const claimId = `TEST-CLAIM-B1-SETTLE-${testRunId}-${suffix}`;
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: '+254700000022',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'batch 1 fixture' },
    verification_tier: 1,
    status: 'escrow_held',
    owner_id_proof_url: null,
    payment_reference: `TEST-PAYREF-B1-SETTLE-${testRunId}-${suffix}`,
    owner_identifying_details: null,
  } as any);

  const settled = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
  expect(settled.success, 'fixture must reach pending_settlement').toBe(true);
  const approved = await db.approveSettlement(claimId, 'b1-admin', 'Batch 1 settlement-gate fixture approval');
  expect(approved.ok, 'fixture must record the durable approval').toBe(true);
  const locked = await db.attemptSettlementRelease(claimId);
  expect(locked, 'fixture must win the release CAS').toBe(true);
  return { claimId, itemId, agentId, categoryId };
}

describe('BATCH 1 — a settlement still requires EVERY payout leg to be provider-verified', () => {
  it('refuses to finalise until BOTH legs are confirmed, then succeeds', async () => {
    const { claimId } = await makeReleasingClaim('1');
    const BATCH = `TRK-B1-SETTLE-${testRunId}-1`;
    const rows = await db.getLedgerEntriesForClaim(claimId);
    const finder = rows.find((r) => r.type === 'finder_payout');
    const agent = rows.find((r) => r.type === 'agent_payout');
    expect(finder, 'fixture must book a finder payout').toBeTruthy();
    expect(agent, 'fixture must book an agent payout').toBeTruthy();

    // Both legs are submitted and ACCEPTED — exactly the state the submission
    // path leaves behind, where acceptance is not completion.
    for (const [row, suffix] of [[finder!, 'F'], [agent!, 'A']] as const) {
      expect(await db.markPayoutSubmissionStarted(row.id)).toBe(true);
      await db.recordPayoutAttempt(row.id, {
        status: 'pending',
        providerBatchId: BATCH,
        providerTransactionId: `TX-${suffix}-${testRunId}`,
      });
    }

    // The provider authoritatively confirms ONLY the finder's transfer.
    expect(await db.confirmPayoutVerified(finder!.id, {
      providerBatchId: BATCH,
      providerTransactionId: `TX-F-${testRunId}`,
    })).toBe(true);

    // ONE verified leg is NOT enough to settle.
    const blocked = await db.finalizeSettlement(claimId);
    expect(blocked.success).toBe(false);
    expect(blocked.message).toContain('not confirmed completed');
    expect((await db.getClaim(claimId))?.status).toBe('releasing');

    // The second leg is verified, and the SAME guard now passes.
    expect(await db.confirmPayoutVerified(agent!.id, {
      providerBatchId: BATCH,
      providerTransactionId: `TX-A-${testRunId}`,
    })).toBe(true);
    const finalized = await db.finalizeSettlement(claimId);
    expect(finalized.success).toBe(true);
    expect((await db.getClaim(claimId))?.status).toBe('released');
  });

  it('a leg with no recorded transaction id stays unresolved and keeps the settlement blocked', async () => {
    // The unmatched-legacy-row case AT the settlement boundary: a leg the
    // provider cannot be bound to is not completed, so the claim stays locked
    // for an operator instead of settling.
    const { claimId } = await makeReleasingClaim('2');
    const rows = await db.getLedgerEntriesForClaim(claimId);
    const finder = rows.find((r) => r.type === 'finder_payout')!;
    const agent = rows.find((r) => r.type === 'agent_payout')!;
    const BATCH = `TRK-B1-UNMATCHED-${testRunId}-2`;

    // The finder leg has a batch id but NO transaction id (the legacy shape).
    expect(await db.markPayoutSubmissionStarted(finder.id)).toBe(true);
    await db.recordPayoutAttempt(finder.id, {
      status: 'pending',
      providerBatchId: BATCH,
      providerTransactionId: null,
    });
    expect(await db.markPayoutSubmissionStarted(agent.id)).toBe(true);
    await db.recordPayoutAttempt(agent.id, {
      status: 'pending',
      providerBatchId: BATCH,
      providerTransactionId: `TX-A2-${testRunId}`,
    });
    expect(await db.confirmPayoutVerified(agent.id, {
      providerBatchId: BATCH,
      providerTransactionId: `TX-A2-${testRunId}`,
    })).toBe(true);

    const blocked = await db.finalizeSettlement(claimId);
    expect(blocked.success).toBe(false);
    expect((await db.getClaim(claimId))?.status).toBe('releasing');
    const after = await db.getLedgerEntriesForClaim(claimId);
    expect(after.find((r) => r.id === finder.id)?.status).toBe('pending');
    expect(after.find((r) => r.id === finder.id)?.payout_outcome).toBe('accepted');
  });
});
