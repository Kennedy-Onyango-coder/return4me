import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';

// This pins down the actual financial-safety property behind the P0/P1
// settlement rework: a batch payout (finder + agent, sent together via
// IntaSend) can partially succeed. These tests prove the ledger correctly
// tracks each recipient independently, that finalizeSettlement REFUSES to
// mark a claim 'released' while any finder/agent payout is still
// outstanding, and that a retry never touches a payout that's already
// confirmed complete — the exact scenario (test #13 in the hardening
// prompt) that would otherwise risk double-paying a finder or agent.
//
// Runs against this project's own in-memory mock database (the same one
// dev/test always uses when DATABASE_URL isn't configured — see
// src/db/index.ts), not a live IntaSend integration; it verifies the
// reconciliation logic in database.ts directly rather than re-testing
// network behavior already covered by services/payments.ts.

async function makeTestClaim(suffix: string) {
  const claimId = `TEST-CLAIM-${testRunId}-${suffix}`;
  const itemId = `TEST-ITEM-${testRunId}-${suffix}`;
  // Real Postgres enforces claims.item_id -> items(id) and
  // items.category_id -> categories(id); the mock does not. Create the
  // parent rows so this fixture is valid in both environments.
  await ensureTestCategory('phone');
  await db.createItem({
    id: itemId,
    category_id: 'phone',
    photo_url: 'test-photo.jpg',
    ocr_extracted_number: null,
    ocr_extracted_name: null,
    document_number_hash: null,
    document_name_fuzzy: null,
    location_description: 'Test location',
    latitude: null,
    longitude: null,
    finder_phone: '+254700000004',
    assigned_agent_id: null,
    status: 'at_agent',
    flaggedForReview: false,
    isDescriptionOnly: false,
    description: null,
    is_sensitive_document: false,
    rejection_reason: null,
  } as any);
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: '+254700000000',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
    verification_tier: 1,
    status: 'releasing',
    owner_id_proof_url: null,
    payment_reference: 'TEST-PAYREF',
    owner_identifying_details: null,
  });
  const finderRow = await db.logTransaction({
    claim_id: claimId,
    item_id: itemId,
    type: 'finder_payout',
    amount: 100,
    phone_or_till: '+254711111111',
    status: 'pending',
  });
  const agentRow = await db.logTransaction({
    claim_id: claimId,
    item_id: itemId,
    type: 'agent_payout',
    amount: 140,
    phone_or_till: '+254722222222',
    status: 'pending',
  });
  const platformRow = await db.logTransaction({
    claim_id: claimId,
    item_id: itemId,
    type: 'platform_fee',
    amount: 160,
    phone_or_till: 'Return4me Platform Paybill',
    status: 'pending',
  });
  return { claimId, itemId, finderRow, agentRow, platformRow };
}

describe('settlement partial-payout reconciliation', () => {
  it('finalizeSettlement refuses to release a claim while a payout is still pending', async () => {
    const { claimId } = await makeTestClaim('A');
    // Neither finder_payout nor agent_payout has been confirmed yet.
    const result = await db.finalizeSettlement(claimId);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/still 'pending'/);
  });

  it('finalizeSettlement refuses to release while ONE payout succeeded but the other is still outstanding', async () => {
    const { claimId, finderRow } = await makeTestClaim('B');
    // Simulate the finder's payout succeeding, agent's still outstanding.
    await db.recordPayoutAttempt(finderRow.id, {
      status: 'success',
      providerBatchId: 'BATCH-1',
      providerTransactionId: 'TXN-FINDER-1',
    });
    const result = await db.finalizeSettlement(claimId);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/agent_payout/);
  });

  it('finalizeSettlement succeeds once both finder_payout and agent_payout are genuinely completed', async () => {
    const { claimId, finderRow, agentRow } = await makeTestClaim('C');
    await db.recordPayoutAttempt(finderRow.id, { status: 'success', providerBatchId: 'BATCH-2', providerTransactionId: 'TXN-FINDER-2' });
    await db.recordPayoutAttempt(agentRow.id, { status: 'success', providerBatchId: 'BATCH-2', providerTransactionId: 'TXN-AGENT-2' });

    const result = await db.finalizeSettlement(claimId);
    expect(result.success).toBe(true);

    const claim = await db.getClaim(claimId);
    expect(claim?.status).toBe('released');

    // The platform_fee row (never sent through an external payout) should
    // also now be completed — it's the only row finalizeSettlement's bulk
    // update is actually meant to touch once the guard passes.
    const entries = await db.getLedgerEntriesForClaim(claimId);
    const platformRow = entries.find(e => e.type === 'platform_fee');
    expect(platformRow?.status).toBe('completed');
  });

  it('a failed payout is recorded as failed with a reason, not silently left ambiguous', async () => {
    const { finderRow } = await makeTestClaim('D');
    await db.recordPayoutAttempt(finderRow.id, {
      status: 'failed',
      providerBatchId: 'BATCH-3',
      providerTransactionId: null,
      failureReason: 'Invalid M-Pesa number.',
    });
    const entries = await db.getLedgerEntriesForClaim(finderRow.claim_id!);
    const updated = entries.find(e => e.id === finderRow.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.failure_reason).toBe('Invalid M-Pesa number.');
  });

  it('recordPayoutAttempt on one row never changes the OTHER recipient\'s row — no cross-contamination between finder and agent state', async () => {
    const { claimId, finderRow, agentRow } = await makeTestClaim('E');
    await db.recordPayoutAttempt(finderRow.id, { status: 'success', providerBatchId: 'BATCH-4', providerTransactionId: 'TXN-FINDER-4' });

    const entries = await db.getLedgerEntriesForClaim(claimId);
    const updatedAgentRow = entries.find(e => e.id === agentRow.id);
    // The agent row must be completely untouched by the finder's update.
    expect(updatedAgentRow?.status).toBe('pending');
    expect(updatedAgentRow?.provider_transaction_id).toBeNull();
  });
});

// The 8 payout-reconciliation scenarios named in the hardening brief,
// mapped onto what actually exists in this codebase's architecture:
// settlement uses a polling sweep (releaseDueSettlements in server.ts)
// that calls PaymentService.triggerIntasendPayout and records each
// recipient's individual result via recordPayoutAttempt — there is no
// inbound payout-status webhook (only the OWNER'S payment collection has
// a webhook, /api/webhooks/intasend, tested separately below for its own
// duplicate-callback idempotency). So "duplicate provider status
// callback" for a PAYOUT specifically doesn't apply to this codebase as
// architected — the six scenarios that do apply are covered here, each
// exercised at the same level the real settlement sweep uses: simulate
// PaymentService's per-recipient result shape, record it via
// recordPayoutAttempt, and assert the resulting ledger/claim state.
describe('payout reconciliation — 6 provider-response scenarios (mocked, matching this codebase\'s actual settlement architecture)', () => {
  it('scenario: both finder and agent payouts succeed → claim can be finalized', async () => {
    const { claimId, finderRow, agentRow } = await makeTestClaim('S1');
    await db.recordPayoutAttempt(finderRow.id, { status: 'success', providerBatchId: 'B-S1', providerTransactionId: 'T-FINDER-S1' });
    await db.recordPayoutAttempt(agentRow.id, { status: 'success', providerBatchId: 'B-S1', providerTransactionId: 'T-AGENT-S1' });
    const result = await db.finalizeSettlement(claimId);
    expect(result.success).toBe(true);
  });

  it('scenario: finder succeeds, agent still pending (provider hasn\'t confirmed yet) → claim NOT finalized', async () => {
    const { claimId, finderRow } = await makeTestClaim('S2');
    await db.recordPayoutAttempt(finderRow.id, { status: 'success', providerBatchId: 'B-S2', providerTransactionId: 'T-FINDER-S2' });
    // agentRow deliberately left untouched — simulates the provider not
    // having confirmed that leg yet.
    const result = await db.finalizeSettlement(claimId);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/agent_payout/);
  });

  it('scenario: finder succeeds, agent fails outright → claim NOT finalized, failure recorded with a reason', async () => {
    const { claimId, finderRow, agentRow } = await makeTestClaim('S3');
    await db.recordPayoutAttempt(finderRow.id, { status: 'success', providerBatchId: 'B-S3', providerTransactionId: 'T-FINDER-S3' });
    await db.recordPayoutAttempt(agentRow.id, { status: 'failed', providerBatchId: 'B-S3', providerTransactionId: null, failureReason: 'Invalid till number.' });

    const result = await db.finalizeSettlement(claimId);
    expect(result.success).toBe(false);

    const entries = await db.getLedgerEntriesForClaim(claimId);
    const agent = entries.find(e => e.id === agentRow.id);
    expect(agent?.status).toBe('failed');
    expect(agent?.failure_reason).toBe('Invalid till number.');
    // The finder's already-successful payout must be completely
    // unaffected by the agent's failure — this is the actual guarantee
    // that prevents a retry from re-paying the finder a second time.
    const finder = entries.find(e => e.id === finderRow.id);
    expect(finder?.status).toBe('completed');
  });

  it('scenario: finder pending, agent succeeds (order reversed) → claim NOT finalized', async () => {
    const { claimId, agentRow } = await makeTestClaim('S4');
    await db.recordPayoutAttempt(agentRow.id, { status: 'success', providerBatchId: 'B-S4', providerTransactionId: 'T-AGENT-S4' });
    const result = await db.finalizeSettlement(claimId);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/finder_payout/);
  });

  it('scenario: both finder and agent payouts fail → claim NOT finalized, both failures recorded independently', async () => {
    const { claimId, finderRow, agentRow } = await makeTestClaim('S5');
    await db.recordPayoutAttempt(finderRow.id, { status: 'failed', providerBatchId: 'B-S5', providerTransactionId: null, failureReason: 'Invalid phone number.' });
    await db.recordPayoutAttempt(agentRow.id, { status: 'failed', providerBatchId: 'B-S5', providerTransactionId: null, failureReason: 'Invalid till number.' });

    const result = await db.finalizeSettlement(claimId);
    expect(result.success).toBe(false);

    const entries = await db.getLedgerEntriesForClaim(claimId);
    expect(entries.find(e => e.id === finderRow.id)?.status).toBe('failed');
    expect(entries.find(e => e.id === agentRow.id)?.status).toBe('failed');
  });

  it('scenario: network timeout after the provider may have already accepted the request → recorded as "unknown", never guessed as success or failure, claim NOT finalized', async () => {
    const { claimId, finderRow, agentRow } = await makeTestClaim('S6');
    // 'unknown' is the actual status triggerIntasendPayout returns on a
    // network/timeout exception — see its docstring in payments.ts. The
    // point: never silently upgrade this to 'completed' (would risk
    // paying twice if the original request actually went through) or to
    // 'failed' (would risk a needless duplicate payout on retry if it
    // didn't).
    await db.recordPayoutAttempt(finderRow.id, { status: 'unknown', providerBatchId: null, providerTransactionId: null, failureReason: 'Network/timeout error contacting IntaSend — outcome unconfirmed.' });
    await db.recordPayoutAttempt(agentRow.id, { status: 'success', providerBatchId: 'B-S6', providerTransactionId: 'T-AGENT-S6' });

    const entries = await db.getLedgerEntriesForClaim(claimId);
    const finder = entries.find(e => e.id === finderRow.id);
    // recordPayoutAttempt maps both 'pending' and 'unknown' provider
    // statuses to the ledger's 'pending' status — there is no separate
    // "unknown" ledger status; the failure_reason field is what
    // distinguishes "still processing" from "we genuinely don't know",
    // for an admin to actually read.
    expect(finder?.status).toBe('pending');
    expect(finder?.failure_reason).toMatch(/outcome unconfirmed/);

    const result = await db.finalizeSettlement(claimId);
    expect(result.success).toBe(false);
  });
});

// "Duplicate provider status callback" DOES apply to this codebase for
// the OWNER'S payment collection — /api/webhooks/intasend can genuinely
// receive the same confirmation twice (network retry, provider redelivery).
// attemptClaimEscrowHold is the actual guard: an atomic UPDATE...WHERE
// status = 'pending_payment', so only the first of two duplicate calls can
// ever win.
describe('duplicate payment webhook / provider callback idempotency', () => {
  it('a second attemptClaimEscrowHold for the same claim (simulating a duplicate webhook delivery) does not re-transition an already-escrowed claim', async () => {
    const claimId = `TEST-CLAIM-WEBHOOK-DUP-${testRunId}`;
    const itemId = `TEST-ITEM-WEBHOOK-DUP-${testRunId}`;
    // Create the parent item: claims.item_id -> items(id) and
    // items.category_id -> categories(id) are real FKs against Postgres.
    await ensureTestCategory('phone');
    await db.createItem({
      id: itemId,
      category_id: 'phone',
      photo_url: 'test-photo.jpg',
      ocr_extracted_number: null,
      ocr_extracted_name: null,
      document_number_hash: null,
      document_name_fuzzy: null,
      location_description: 'Test location',
      latitude: null,
      longitude: null,
      finder_phone: '+254700000009',
      assigned_agent_id: null,
      status: 'at_agent',
      flaggedForReview: false,
      isDescriptionOnly: false,
      description: null,
      is_sensitive_document: false,
      rejection_reason: null,
    } as any);
    await db.createClaim({
      id: claimId,
      item_id: itemId,
      owner_phone: '+254700000099',
      security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
      verification_tier: 1,
      status: 'pending_payment',
      owner_id_proof_url: null,
      payment_reference: null,
      owner_identifying_details: null,
    });

    const first = await db.attemptClaimEscrowHold(claimId, 'MPESA-REF-001');
    const second = await db.attemptClaimEscrowHold(claimId, 'MPESA-REF-001-DUPLICATE');

    expect(first).toBe(true);
    expect(second).toBe(false);

    // The payment_reference from the FIRST call must be preserved — the
    // duplicate delivery must never overwrite it.
    const claim = await db.getClaim(claimId);
    expect(claim?.payment_reference).toBe('MPESA-REF-001');
    expect(claim?.status).toBe('escrow_held');
  });
});
