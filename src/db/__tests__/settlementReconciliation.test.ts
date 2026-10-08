import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';
import { isPayoutSubmittable, isUnresolvedPayoutRow } from '../../config/payoutOutcomes';

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
    // E3A — booked by the same positive statement enterPendingSettlement makes:
    // nothing has been sent to a provider yet. Tests that need the OTHER
    // reading (an ambiguous legacy row with no recorded history) book a row
    // without this field on purpose.
    payout_outcome: 'not_submitted',
  });
  const agentRow = await db.logTransaction({
    claim_id: claimId,
    item_id: itemId,
    type: 'agent_payout',
    amount: 140,
    phone_or_till: '+254722222222',
    status: 'pending',
    payout_outcome: 'not_submitted',
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
    //
    // E3A adds the machine-readable half of that distinction:
    // payout_outcome records the provider outcome itself ('accepted' vs
    // 'unknown'), which is what stops BOTH states from being resubmitted.
    expect(finder?.status).toBe('pending');
    expect(finder?.payout_outcome).toBe('unknown');
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

// ===========================================================================
// E3A — PAYOUT SUBMISSION OUTCOME MODEL AND RETRY SAFETY
// ===========================================================================
// THE DEFECT THESE TESTS PIN
//
// recordPayoutAttempt() used to collapse three genuinely different provider
// facts into the single ledger status 'pending': "the provider accepted the
// batch but the individual transfer is not confirmed", "the request timed out
// so we cannot tell whether it executed", and "nothing has been submitted yet".
// The settlement executor then treated every 'pending' row as eligible for
// submission, so an accepted-or-uncertain payout was re-sent to the provider on
// the next sweep — a duplicate-transfer risk that the ledger could not even
// express, let alone prevent.
//
// The model is now explicit. `ledger.payout_outcome` records what happened at
// the provider boundary, and a row is submitted ONLY when it positively says
// 'not_submitted'. Every other value — including NULL, i.e. "no submission
// history recorded" — fails closed. See src/config/payoutOutcomes.ts.
// ===========================================================================
describe('E3A — payout submission outcome model', () => {
  it('records the provider outcome separately from the legacy ledger status', async () => {
    const { claimId, finderRow } = await makeTestClaim('E3A-MAP');

    await db.recordPayoutAttempt(finderRow.id, { status: 'pending', providerBatchId: 'BATCH-ACC', providerTransactionId: null });
    let row = (await db.getLedgerEntriesForClaim(claimId)).find(e => e.id === finderRow.id)!;
    // Accepted is NOT completed: the legacy status stays 'pending' (so every
    // existing consumer keeps its meaning) while the outcome records that the
    // provider did receive the request.
    expect(row.status).toBe('pending');
    expect(row.payout_outcome).toBe('accepted');

    await db.recordPayoutAttempt(finderRow.id, { status: 'unknown', providerBatchId: null, providerTransactionId: null });
    row = (await db.getLedgerEntriesForClaim(claimId)).find(e => e.id === finderRow.id)!;
    expect(row.status).toBe('pending');
    expect(row.payout_outcome).toBe('unknown');
    // EVIDENCE PRESERVATION: the batch reference captured from the earlier
    // accepted response is NOT overwritten with null by a later uncertain
    // result. It is the only handle an operator has for reconciling the
    // submission with the provider.
    expect(row.provider_batch_id).toBe('BATCH-ACC');

    await db.recordPayoutAttempt(finderRow.id, { status: 'failed', providerBatchId: null, providerTransactionId: null, failureReason: 'Provider refused the request.' });
    row = (await db.getLedgerEntriesForClaim(claimId)).find(e => e.id === finderRow.id)!;
    expect(row.status).toBe('failed');
    expect(row.payout_outcome).toBe('rejected');
    expect(row.provider_batch_id).toBe('BATCH-ACC');

    await db.recordPayoutAttempt(finderRow.id, { status: 'success', providerBatchId: 'BATCH-OK', providerTransactionId: 'TXN-OK' });
    row = (await db.getLedgerEntriesForClaim(claimId)).find(e => e.id === finderRow.id)!;
    expect(row.status).toBe('completed');
    expect(row.payout_outcome).toBe('completed');
    expect(row.provider_transaction_id).toBe('TXN-OK');
  });

  it('a row whose submission history is UNKNOWN is never treated as submittable', async () => {
    // Every row written before the outcome column existed reads NULL here, and
    // NULL is indistinguishable from "booked but never submitted". It must
    // therefore fail closed: losing a legitimate retry is preferable to
    // reissuing a transfer that may already have been executed. Booked without
    // an outcome, exactly as a pre-E3A row would be.
    const legacyClaimId = `TEST-CLAIM-E3A-LEGACY-${testRunId}`;
    const legacyItemId = `TEST-ITEM-E3A-LEGACY-${testRunId}`;
    await ensureTestCategory('phone');
    await db.createItem({
      id: legacyItemId,
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
      id: legacyClaimId,
      item_id: legacyItemId,
      owner_phone: '+254700000000',
      security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
      verification_tier: 1,
      status: 'releasing',
      owner_id_proof_url: null,
      payment_reference: 'TEST-PAYREF',
      owner_identifying_details: null,
    });
    const legacyRow = await db.logTransaction({
      claim_id: legacyClaimId,
      item_id: legacyItemId,
      type: 'finder_payout',
      amount: 100,
      phone_or_till: '+254711111111',
      status: 'pending',
    } as any);

    expect(legacyRow.payout_outcome ?? null).toBeNull();
    expect(isPayoutSubmittable(legacyRow)).toBe(false);
    expect(isUnresolvedPayoutRow(legacyRow)).toBe(true);
    // ...and the pre-submission marker refuses to claim it, so an ambiguous row
    // cannot be swept into a submission at all.
    expect(await db.markPayoutSubmissionStarted(legacyRow.id)).toBe(false);

    // A positively recorded never-submitted row IS submittable...
    const { finderRow } = await makeTestClaim('E3A-NEW');
    expect(isPayoutSubmittable(finderRow)).toBe(true);
    expect(await db.markPayoutSubmissionStarted(finderRow.id)).toBe(true);

    // ...and only that reading is. Every other outcome fails closed.
    for (const outcome of ['submitting', 'accepted', 'unknown', 'rejected', 'completed', null]) {
      expect(isPayoutSubmittable({ status: 'pending', payout_outcome: outcome as any }), String(outcome)).toBe(false);
    }
    // A completed payout is never unresolved work either.
    expect(isUnresolvedPayoutRow({ status: 'completed', payout_outcome: 'completed' })).toBe(false);
  });

  it('the pre-submission marker is a compare-and-swap: exactly one worker may claim a payout attempt', async () => {
    const { claimId, finderRow } = await makeTestClaim('E3A-MARK');

    const [first, second] = await Promise.all([
      db.markPayoutSubmissionStarted(finderRow.id),
      db.markPayoutSubmissionStarted(finderRow.id),
    ]);
    expect([first, second].filter(Boolean).length, 'exactly one caller may claim the attempt').toBe(1);

    const row = (await db.getLedgerEntriesForClaim(claimId)).find(e => e.id === finderRow.id)!;
    expect(row.payout_outcome).toBe('submitting');
    // A later sweep (or a repeated administrator release) also loses the CAS
    // and therefore cannot resend this row.
    expect(await db.markPayoutSubmissionStarted(finderRow.id)).toBe(false);
  });

  it('a process death after the marker leaves the row unresolved, never auto-resubmitted', async () => {
    const { claimId, finderRow, agentRow } = await makeTestClaim('E3A-CRASH');

    // Both rows are marked, then the process dies: the provider call was
    // either never issued or its result was never recorded. NOTHING is assumed
    // about what the provider did.
    expect(await db.markPayoutSubmissionStarted(finderRow.id)).toBe(true);
    expect(await db.markPayoutSubmissionStarted(agentRow.id)).toBe(true);

    const payouts = (await db.getLedgerEntriesForClaim(claimId))
      .filter(e => e.type === 'finder_payout' || e.type === 'agent_payout');
    expect(payouts.length).toBe(2);
    for (const payout of payouts) {
      expect(payout.payout_outcome).toBe('submitting');
      expect(isPayoutSubmittable(payout), `${payout.type} must not be resubmitted`).toBe(false);
      expect(isUnresolvedPayoutRow(payout)).toBe(true);
    }

    // ...and the unresolved work queue surfaces it for reconciliation instead
    // of forgetting it, so an interrupted submission can never become
    // invisible.
    const unresolvedIds = (await db.getUnresolvedPayouts()).map(r => r.id);
    expect(unresolvedIds).toContain(finderRow.id);
    expect(unresolvedIds).toContain(agentRow.id);
  });

  it('finder and agent rows keep independent outcomes inside one batch', async () => {
    const { claimId, finderRow, agentRow } = await makeTestClaim('E3A-INDEP');

    await db.recordPayoutAttempt(finderRow.id, { status: 'success', providerBatchId: 'BATCH-SPLIT', providerTransactionId: 'TXN-FINDER-SPLIT' });
    await db.recordPayoutAttempt(agentRow.id, { status: 'unknown', providerBatchId: 'BATCH-SPLIT', providerTransactionId: null });

    const entries = await db.getLedgerEntriesForClaim(claimId);
    const finder = entries.find(e => e.id === finderRow.id)!;
    const agent = entries.find(e => e.id === agentRow.id)!;
    expect([finder.status, finder.payout_outcome]).toEqual(['completed', 'completed']);
    expect([agent.status, agent.payout_outcome]).toEqual(['pending', 'unknown']);
    // The confirmed leg is never resent; the unresolved leg is never resent
    // either — it is reconciliation work, not retry work.
    expect(isPayoutSubmittable(finder)).toBe(false);
    expect(isPayoutSubmittable(agent)).toBe(false);
    expect(isUnresolvedPayoutRow(agent)).toBe(true);
  });

  it('the reconciliation queue lists unresolved payouts and never non-provider rows', async () => {
    const { claimId, finderRow, agentRow, platformRow } = await makeTestClaim('E3A-QUEUE');

    // A freshly booked, never-submitted row is NOT reconciliation work: it is
    // waiting for its first legitimate attempt.
    let unresolvedIds = (await db.getUnresolvedPayouts()).map(r => r.id);
    expect(unresolvedIds).not.toContain(finderRow.id);
    expect(unresolvedIds).not.toContain(agentRow.id);
    // The platform's own retained fee never touches a provider, so it can never
    // appear in this queue.
    expect(unresolvedIds).not.toContain(platformRow.id);

    // Once a submission has an unresolved outcome, the row IS queue work...
    await db.recordPayoutAttempt(finderRow.id, { status: 'pending', providerBatchId: 'BATCH-Q1', providerTransactionId: null });
    expect(await db.markPayoutSubmissionStarted(agentRow.id)).toBe(true);
    unresolvedIds = (await db.getUnresolvedPayouts()).map(r => r.id);
    expect(unresolvedIds).toContain(finderRow.id);
    expect(unresolvedIds).toContain(agentRow.id);
    expect(unresolvedIds).not.toContain(platformRow.id);

    // ...and a confirmed payout leaves it.
    await db.recordPayoutAttempt(finderRow.id, { status: 'success', providerBatchId: 'BATCH-Q1', providerTransactionId: 'TXN-Q1' });
    unresolvedIds = (await db.getUnresolvedPayouts()).map(r => r.id);
    expect(unresolvedIds).not.toContain(finderRow.id);
    expect(unresolvedIds).toContain(agentRow.id);
    expect((await db.getLedgerEntriesForClaim(claimId)).find(e => e.id === finderRow.id)?.status).toBe('completed');
  });

  it('finalizeSettlement refuses to complete a claim whose payout outcome is unresolved', async () => {
    const { claimId, finderRow, agentRow } = await makeTestClaim('E3A-FINALIZE');

    await db.markPayoutSubmissionStarted(finderRow.id);
    await db.recordPayoutAttempt(agentRow.id, { status: 'pending', providerBatchId: 'BATCH-A', providerTransactionId: null });

    const result = await db.finalizeSettlement(claimId);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not confirmed completed/);
    // The claim stays locked for review rather than being released on an
    // unconfirmed payout.
    expect((await db.getClaim(claimId))?.status).toBe('releasing');
  });
});
