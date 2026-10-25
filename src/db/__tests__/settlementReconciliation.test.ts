import { describe, it, expect } from 'vitest';
import { db } from '../database';
import { ensureTestCategory, testRunId } from './ensureTestCategory';
import { isPayoutSubmittable, isUnresolvedPayoutRow } from '../../config/payoutOutcomes';
import { resolveSimulatedAttemptReference } from '../../config/devPaymentSimulation';
// D-2B-B-E — the tests below also drive the in-memory executor directly (the
// `db` export from ../index is the Drizzle handle the application uses), so the
// SQL NULL semantics of `eq(col, null)` / `isNull` / `isNotNull` / `notInArray`
// can be asserted against the same harness the application code runs on.
import { db as drizzleDb } from '../index';
import { claims as claimsTable, ledger as ledgerTable } from '../schema';
import { eq, and, isNull, isNotNull, notInArray } from 'drizzle-orm';



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
// settlement payouts are submitted by executeClaimSettlement in server.ts,
// reached only from the administrator-initiated routes (settlement/initiate and
// the legacy release-settlement that delegates to it); the periodic sweep
// (releaseDueSettlements) is reporting-only and calls no provider. Each
// recipient's result is recorded via recordPayoutAttempt — there is no
// inbound payout-status webhook (only the OWNER'S payment collection has
// a webhook, /api/webhooks/intasend, tested separately below for its own
// duplicate-callback idempotency). So "duplicate provider status
// callback" for a PAYOUT specifically doesn't apply to this codebase as
// architected — the six scenarios that do apply are covered here, each
// exercised at the same level the real payout executor uses: simulate
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

// ===========================================================================
// D-2A — RECEIPT-LEDGER INTEGRITY (`payment_received` rows)
// ===========================================================================
// THE DEFECT THIS SECTION PINS.
//
// A `payment_received` row is booked (status 'pending') by each collection
// ATTEMPT the provider accepted — at that instant a prompt has been SENT and
// nothing has been collected. finalizeSettlement's bulk
// `status='pending' -> 'completed'` UPDATE matched EVERY pending row of the
// claim, so an abandoned or expired M-Pesa prompt — or the losing attempt of a
// retry — was recorded as collected revenue the moment its claim reached
// settlement.
//
// THE INVARIANT.
//
// A receipt row may reach 'completed' ONLY from the authoritative confirmation
// of the attempt it belongs to (db.attemptClaimEscrowHold — the same atomic
// statement that moves the claim to `escrow_held`), matched on that attempt's
// own provider reference. Settlement is structurally unable to complete one.
//
// The four states stay distinct, exactly as they must:
//   * attempt initiated                    -> row 'pending', with its reference
//   * collection authoritatively confirmed -> that row 'completed', no other row
//   * attempt failed / expired             -> row stays 'pending' (UNRESOLVED:
//                                             the provider could have collected
//                                             it, so a timeout is NOT proof of
//                                             failure)
//   * outcome unknown                      -> row stays 'pending' (UNRESOLVED)
//
// Runs against the same in-memory mock database as the rest of this suite (see
// the header above), and proves the application-level rule implemented in
// database.ts. It is not a PostgreSQL/MVCC concurrency proof: the guarantees
// needing real MVCC are the ones the existing attemptClaimEscrowHold /
// attemptSettlementRelease suites already cover.
// ===========================================================================

const RECEIPT_AMOUNT = 400;

/** A claim awaiting payment, with the item/category parents real FKs require. */
async function makePayableClaim(suffix: string) {
  const claimId = `TEST-CLAIM-RCPT-${testRunId}-${suffix}`;
  const itemId = `TEST-ITEM-RCPT-${testRunId}-${suffix}`;
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
    status: 'pending_payment',
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
  });
  return { claimId, itemId };
}

/**
 * One collection ATTEMPT's receipt row, exactly as services/payments.ts books it
 * when the provider accepts the STK request: unresolved, and stamped with that
 * attempt's own provider invoice id.
 */
async function bookAttempt(claimId: string, itemId: string | null, invoiceRef: string) {
  return db.logTransaction({
    claim_id: claimId,
    item_id: itemId,
    type: 'payment_received',
    amount: RECEIPT_AMOUNT,
    phone_or_till: '+254700000000',
    status: 'pending',
    provider_transaction_id: invoiceRef,
  });
}

const receiptRowsFor = async (claimId: string) =>
  (await db.getLedgerEntriesForClaim(claimId)).filter((e) => e.type === 'payment_received');

/** A live (non-terminal) STK session for a claim, as the initiate route creates. */
async function makeSession(claimId: string, suffix: string) {
  const sessionId = `PS-D2A-${testRunId}-${suffix}`;
  const created = await db.createPaymentSession({
    id: sessionId,
    claimId,
    amount: RECEIPT_AMOUNT,
    payerPhone: '+254700000000',
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect(created).toBe(true);
  return sessionId;
}

describe('D-2A — receipt-ledger integrity', () => {
  it('books a receipt row UNRESOLVED, carrying its own attempt reference', async () => {
    const { claimId, itemId } = await makePayableClaim('BOOKED');
    const row = await bookAttempt(claimId, itemId, 'INV-BOOKED');

    expect(row.status).toBe('pending');
    const stored = (await receiptRowsFor(claimId)).find((e) => e.id === row.id)!;
    expect(stored.status).toBe('pending');
    // The correlation key survives the write. Without it the row could never be
    // resolved by the confirmation it belongs to, and completing it would have
    // to be guessed at — which is exactly what went wrong.
    expect(stored.provider_transaction_id).toBe('INV-BOOKED');
    // A receipt row is not a payout row: it must never become eligible for a
    // provider submission.
    expect(stored.payout_outcome).toBeNull();
  });

  it('one confirmed collection completes ONLY that attempt row', async () => {
    const { claimId, itemId } = await makePayableClaim('CONFIRM');
    const row = await bookAttempt(claimId, itemId, 'INV-CONFIRM');

    expect(await db.attemptClaimEscrowHold(claimId, 'INV-CONFIRM')).toBe(true);
    expect((await db.getClaim(claimId))!.status).toBe('escrow_held');
    expect((await receiptRowsFor(claimId)).find((e) => e.id === row.id)!.status).toBe('completed');
  });

  it('multiple abandoned attempts then one collected attempt: only the collected one completes', async () => {
    const { claimId, itemId } = await makePayableClaim('RETRY');
    // Two prompts the provider accepted and the customer never approved. Their
    // outcome is genuinely unknown, so nothing writes them to 'failed'.
    const abandonedA = await bookAttempt(claimId, itemId, 'INV-ATTEMPT-A');
    const abandonedB = await bookAttempt(claimId, itemId, 'INV-ATTEMPT-B');
    // The third attempt is the one that is actually collected.
    const collected = await bookAttempt(claimId, itemId, 'INV-ATTEMPT-C');

    expect(await db.attemptClaimEscrowHold(claimId, 'INV-ATTEMPT-C')).toBe(true);

    const rows = await receiptRowsFor(claimId);
    expect(rows.find((e) => e.id === collected.id)!.status).toBe('completed');
    expect(rows.find((e) => e.id === abandonedA.id)!.status).toBe('pending');
    expect(rows.find((e) => e.id === abandonedB.id)!.status).toBe('pending');

    // A late or repeated delivery naming an abandoned attempt can neither win the
    // claim CAS nor touch that attempt's own row.
    expect(await db.attemptClaimEscrowHold(claimId, 'INV-ATTEMPT-A')).toBe(false);
    expect((await receiptRowsFor(claimId)).find((e) => e.id === abandonedA.id)!.status).toBe('pending');
  });

  it('an expired attempt keeps its row unresolved; a later retry is what completes', async () => {
    const { claimId, itemId } = await makePayableClaim('EXPIRED-THEN-RETRY');
    const expired = await bookAttempt(claimId, itemId, 'INV-EXPIRED');
    // The attempt's own short STK window elapses — an authoritative server-side
    // expiry of the PROMPT, not a verdict about the money.
    const sessionId = await makeSession(claimId, 'EXPIRED');
    expect(await db.expirePaymentSession(sessionId)).toBe(true);

    expect((await receiptRowsFor(claimId)).find((e) => e.id === expired.id)!.status).toBe('pending');

    const retry = await bookAttempt(claimId, itemId, 'INV-RETRY');
    expect(await db.attemptClaimEscrowHold(claimId, 'INV-RETRY')).toBe(true);

    const rows = await receiptRowsFor(claimId);
    expect(rows.find((e) => e.id === retry.id)!.status).toBe('completed');
    expect(rows.find((e) => e.id === expired.id)!.status).toBe('pending');
  });

  it('duplicate failure/expiry callbacks are idempotent and never touch a receipt row', async () => {
    const { claimId, itemId } = await makePayableClaim('DUP-FAIL');
    const row = await bookAttempt(claimId, itemId, 'INV-DUP-FAIL');
    const sessionId = await makeSession(claimId, 'DUPFAIL');
    expect(await db.reservePaymentSession(sessionId, claimId)).toBe(true);
    expect(await db.finalizePaymentSessionInitiated(sessionId, 'INV-DUP-FAIL', 'REF-DUP-FAIL')).toBe(true);

    // The provider reports a failure — twice (a redelivery).
    expect(await db.markPaymentSessionFailed(sessionId, 'provider declined')).toBe(true);
    expect(await db.markPaymentSessionFailed(sessionId, 'provider declined')).toBe(false);
    expect(await db.expirePaymentSession(sessionId)).toBe(false);

    const stored = (await receiptRowsFor(claimId)).find((e) => e.id === row.id)!;
    expect(stored.status).toBe('pending');
    expect(stored.failure_reason ?? null).toBeNull();

    // A session in no confirmable state cannot move the claim, so it can never
    // promote the row either.
    expect(await db.attemptClaimEscrowHold(claimId, 'INV-DUP-FAIL')).toBe(false);
    expect((await db.getClaim(claimId))!.status).toBe('pending_payment');
    expect((await receiptRowsFor(claimId)).find((e) => e.id === row.id)!.status).toBe('pending');
  });

  it('a duplicate successful confirmation is a no-op that cannot double-complete', async () => {
    const { claimId, itemId } = await makePayableClaim('DUP-CONFIRM');
    const row = await bookAttempt(claimId, itemId, 'INV-DUP-CONFIRM');

    expect(await db.attemptClaimEscrowHold(claimId, 'INV-DUP-CONFIRM')).toBe(true);
    const afterFirst = await receiptRowsFor(claimId);
    expect(afterFirst.find((e) => e.id === row.id)!.status).toBe('completed');

    // Replay: the claim CAS can no longer match, so nothing at all is written.
    expect(await db.attemptClaimEscrowHold(claimId, 'INV-DUP-CONFIRM')).toBe(false);
    // Compared field-by-field on the facts that carry meaning, not by deep row
    // equality: `created_at` is not part of what a replay may change, and in the
    // in-memory sandbox it is re-derived per read, so including it would make
    // this assertion a clock race rather than a rule.
    const afterReplay = await receiptRowsFor(claimId);
    const facts = (rows: typeof afterReplay) =>
      rows.map((r) => [r.id, r.status, r.payout_outcome, r.provider_transaction_id, r.amount]);
    expect(facts(afterReplay)).toEqual(facts(afterFirst));
  });

  it('an unknown provider outcome stays unresolved — never completed, never failed', async () => {
    const { claimId, itemId } = await makePayableClaim('UNKNOWN');
    const row = await bookAttempt(claimId, itemId, 'INV-UNKNOWN');

    // No authoritative confirmation ever arrives and no provider verdict exists:
    // the money may or may not have moved.
    const stored = (await receiptRowsFor(claimId)).find((e) => e.id === row.id)!;
    expect(stored.status).toBe('pending');
    expect(stored.status).not.toBe('completed');
    expect(stored.status).not.toBe('failed');
  });

  it('settlement completes its own rows but can never promote an unrelated pending receipt row', async () => {
    const { claimId, itemId, finderRow, agentRow } = await makeTestClaim('D2A-SWEEP');
    // An attempt that was never authoritatively confirmed. Under the old blanket
    // `status='pending' -> 'completed'` sweep, THIS row became "collected
    // revenue" the moment its claim settled. That is the defect.
    const abandoned = await bookAttempt(claimId, itemId, 'INV-NEVER-CONFIRMED');

    await db.recordPayoutAttempt(finderRow.id, { status: 'success', providerBatchId: 'D2A-BATCH', providerTransactionId: 'D2A-TXN-FINDER' });
    await db.recordPayoutAttempt(agentRow.id, { status: 'success', providerBatchId: 'D2A-BATCH', providerTransactionId: 'D2A-TXN-AGENT' });

    const result = await db.finalizeSettlement(claimId);
    // An unresolved receipt row is not an outstanding payout and must not block
    // settlement.
    expect(result.success).toBe(true);
    expect((await db.getClaim(claimId))!.status).toBe('released');

    const entries = await db.getLedgerEntriesForClaim(claimId);
    // The settlement's own retained-fee row is completed...
    expect(entries.find((e) => e.type === 'platform_fee')!.status).toBe('completed');
    // ...the provider-confirmed payout rows keep their authoritative outcomes,
    // exactly as the existing protections require...
    expect(entries.find((e) => e.id === finderRow.id)!.status).toBe('completed');
    expect(entries.find((e) => e.id === agentRow.id)!.status).toBe('completed');
    // ...and the abandoned attempt's receipt row is NOT completed, with its
    // reference intact. This is the guarantee the batch exists to provide.
    const abandonedAfter = entries.find((e) => e.id === abandoned.id)!;
    expect(abandonedAfter.status, 'settlement must never launder an unconfirmed attempt into revenue').toBe('pending');
    expect(abandonedAfter.provider_transaction_id).toBe('INV-NEVER-CONFIRMED');

    // Re-running settlement is idempotent and still cannot promote it.
    expect((await db.finalizeSettlement(claimId)).success).toBe(false);
    expect((await db.getLedgerEntriesForClaim(claimId)).find((e) => e.id === abandoned.id)!.status).toBe('pending');
  });

  // D-2A-H. The dev-only simulator used to confirm a claim under a fabricated
  // `TEST-SIMULATED-<now>` reference, which matched no attempt and no session:
  // the claim moved while its real receipt row stayed pending forever. This is
  // the composition the endpoint now performs — resolve the claim's newest
  // confirmable attempt, then confirm exactly that attempt's reference.
  it('a simulated confirmation completes the selected attempt and nothing else', async () => {
    const { claimId, itemId } = await makePayableClaim('SIM-SELECT');

    // The attempt the customer abandoned: the prompt was accepted, then its own
    // short window elapsed. Simulating a LATER attempt must never resolve it.
    const superseded = await bookAttempt(claimId, itemId, 'INV-SIM-OLDSESSION');
    const oldSession = await makeSession(claimId, 'A-OLDSESSION');
    expect(await db.reservePaymentSession(oldSession, claimId)).toBe(true);
    expect(await db.finalizePaymentSessionInitiated(oldSession, 'INV-SIM-OLDSESSION', 'MPX-OLD')).toBe(true);
    expect(await db.expirePaymentSession(oldSession)).toBe(true);

    // The attempt actually being simulated: the newest confirmable session,
    // carrying the same provider invoice its own receipt row was stamped with.
    // The fixtures' ids are ordered so "newest" stays deterministic even when
    // both rows were created inside the same millisecond.
    const current = await bookAttempt(claimId, itemId, 'INV-SIM-NEWSESSION');
    const newSession = await makeSession(claimId, 'B-NEWSESSION');
    expect(await db.reservePaymentSession(newSession, claimId)).toBe(true);
    expect(await db.finalizePaymentSessionInitiated(newSession, 'INV-SIM-NEWSESSION', 'MPX-NEW')).toBe(true);

    /** Exactly what the simulator resolves before it confirms anything. */
    const simulate = async () => {
      const claim = await db.getClaim(claimId);
      return resolveSimulatedAttemptReference(await db.listPaymentSessionsForClaim(claimId), {
        claimId,
        claimStatus: claim!.status,
        paidAt: claim!.paid_at,
      });
    };

    const attempt = await simulate();
    expect(attempt, 'a confirmable attempt exists, so the simulation may run').not.toBeNull();
    expect(attempt!.invoiceId).toBe('INV-SIM-NEWSESSION');
    expect(attempt!.sessionId).toBe(newSession);
    expect(attempt!.amount).toBe(RECEIPT_AMOUNT);

    // The canonical confirmation the simulator then calls, with that attempt's
    // own reference and its authoritative amount.
    expect(await db.attemptClaimEscrowHold(claimId, attempt!.invoiceId)).toBe(true);

    const afterConfirm = await receiptRowsFor(claimId);
    expect(afterConfirm.find((e) => e.id === current.id)!.status).toBe('completed');
    expect(afterConfirm.find((e) => e.id === superseded.id)!.status).toBe('pending');
    expect(afterConfirm.find((e) => e.id === superseded.id)!.provider_transaction_id).toBe('INV-SIM-OLDSESSION');
    // The claim carries the attempt's REAL provider reference — never a
    // fabricated one — and only the simulated attempt's own session moved.
    expect((await db.getClaim(claimId))!.payment_reference).toBe('INV-SIM-NEWSESSION');
    expect((await db.getPaymentSessionById(newSession))!.status).toBe('confirmed');
    expect((await db.getPaymentSessionById(oldSession))!.status).toBe('expired');

    // Repeating the simulation cannot double-complete or double-book: no
    // confirmable attempt is selectable any more...
    expect(await simulate()).toBeNull();
    // ...and presenting the same reference again cannot win the atomic CAS.
    expect(await db.attemptClaimEscrowHold(claimId, 'INV-SIM-NEWSESSION')).toBe(false);

    const afterReplay = await receiptRowsFor(claimId);
    const facts = (rows: typeof afterReplay) =>
      rows.map((r) => [r.id, r.status, r.payout_outcome, r.provider_transaction_id, r.amount]);
    expect(facts(afterReplay)).toEqual(facts(afterConfirm));
  });
});
// ===========================================================================
// D-2B-B-E — DURABLE SETTLEMENT APPROVAL: the manual payout gate
// ===========================================================================
// Approving is the ONLY thing that can make a due, in-window claim releasable.
// The approval is ONE conditional UPDATE (status + `settlement_approved_at IS
// NULL` + an elapsed settle_at) whose success audit row - carrying the required
// reason - commits in the SAME transaction; the release CAS then refuses any
// claim without it, and there is no force/override parameter left to bypass
// either.
//
// NOT PROVEN HERE, STATED PLAINLY: the write-time behaviour of a real
// PostgreSQL server. These tests run against the in-memory executor (see the
// file header), which now implements SQL three-valued NULL semantics for
// eq/isNull/isNotNull/IN/NOT IN, but it is still a test double. No run against a
// live PostgreSQL instance was performed for this change, so "concurrent
// approvals" below is a real assertion about this data flow, not an MVCC proof.
// ===========================================================================

/** A claim booked into 'pending_settlement' with a real settle_at window. */
async function makeReviewableClaim(suffix: string, settleOffsetMs: number) {
  const claimId = `TEST-REVIEW-${testRunId}-${suffix}`;
  const itemId = `TEST-REVIEW-ITEM-${testRunId}-${suffix}`;
  // enterPendingSettlement() resolves the item's assigned agent and refuses
  // the booking with "Agent not found." when there is none, so a claim that is
  // meant to reach the review window must have a REAL agent identity behind
  // it. One agent per suffix keeps each test's data isolated: no test can pass
  // by borrowing an agent another test happened to create.
  const agentId = `TEST-REVIEW-AGENT-${testRunId}-${suffix}`;
  if (!(await db.getAgent(agentId))) {
    await db.createAgent({
      id: agentId,
      business_name: `Review Fixture Hub ${suffix}`,
      contact_phone: '+254700000005',
      location_address: 'Test location',
      latitude: null,
      longitude: null,
      mpesa_till_or_paybill: '000000',
      payout_method_type: 'Till Number',
      status: 'active',
      refundable_deposit: 0,
      national_id_hash: 'test-hash-review',
      needs_manual_geocoding: false,
    });
  }
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
    assigned_agent_id: agentId,
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
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'review fixture' },
    verification_tier: 1,
    status: 'pending_payment',
    owner_id_proof_url: null,
    payment_reference: null,
    owner_identifying_details: null,
  });
  // The claim reaches escrow through the sanctioned confirmation CAS, in the
  // canonical order: createClaim() deliberately refuses to take `paid_at` from
  // its caller (a claim can never be CREATED already-paid), and
  // attemptClaimEscrowHold() — the single guarded writer of `paid_at` — admits
  // only a 'pending_payment' source. Booking 'escrow_held' directly in the
  // helper would leave `paid_at` NULL: a claim that looks collected but carries
  // no confirmed payment, which is exactly the state the assertions below must
  // not accept. The deterministic reference is this fixture's own invoice id.
  expect(
    await db.attemptClaimEscrowHold(claimId, `TEST-REVIEW-PAYREF-${suffix}`),
  ).toBe(true);
  expect((await db.getClaim(claimId))!.status).toBe('escrow_held');

  const booked = await db.enterPendingSettlement(claimId, settleOffsetMs);
  expect(booked.success, booked.message).toBe(true);

  // The in-memory executor applies no column DEFAULTs, so the three payout rows
  // enterPendingSettlement() has just booked carry no `created_at`, and
  // parseLedgerEntry() then substitutes a FRESH `new Date()` on every read —
  // which makes any deep-equality snapshot of those rows unequal to itself.
  // Real PostgreSQL fills the column from `DEFAULT now()` at INSERT (schema.ts:
  // ledger.created_at), so give the rows the timestamp they would already have
  // had, BEFORE the snapshot below is taken. This is fixture setup through the
  // same table the application reads (the same technique the `settle_at`
  // clearing in the "no window" case uses), not a production workaround: no
  // production path changes, and the snapshot comparison keeps every field,
  // `created_at` included.
  await drizzleDb
    .update(ledgerTable)
    .set({ created_at: new Date() } as any)
    .where(eq(ledgerTable.claim_id, claimId));

  return { claimId, itemId };
}

const approvalAuditsFor = async (claimId: string) =>
  (await db.getAuditLogs()).filter(
    (a) => a.action === 'CLAIM_SETTLEMENT_APPROVED' && String(a.details).includes(claimId),
  );

describe('D-2B-B-E — durable, CAS-guarded settlement approval', () => {
  it('records the administrator identity, the timestamp and the reason atomically, and never moves the claim', async () => {
    const { claimId } = await makeReviewableClaim('OK', -1000);
    const ledgerBefore = await db.getLedgerEntriesForClaim(claimId);

    const result = await db.approveSettlement(claimId, 'admin-jane', 'Owner and finder both confirmed the handover; no dispute filed.');
    expect(result.ok).toBe(true);
    expect(result.code).toBe('approved');
    expect(result.claim?.settlement_approved_by).toBe('admin-jane');
    expect(result.claim?.settlement_approved_at).toBeTruthy();

    const claim = (await db.getClaim(claimId))!;
    expect(claim.settlement_approved_by).toBe('admin-jane');
    expect(Number.isNaN(Date.parse(String(claim.settlement_approved_at)))).toBe(false);
    // Approval is neither a status change nor a financial event.
    expect(claim.status).toBe('pending_settlement');
    expect(await db.getLedgerEntriesForClaim(claimId)).toEqual(ledgerBefore);
    // ...and the collection evidence is untouched.
    expect(claim.paid_at ?? null).not.toBeNull();
    expect(claim.payment_reference).toBe('TEST-REVIEW-PAYREF-OK');

    // The reason is durable, inside the approval's own audit row.
    const audits = await approvalAuditsFor(claimId);
    expect(audits.length).toBe(1);
    expect(audits[0].admin_user).toBe('admin-jane');
    expect(String(audits[0].details)).toContain('no dispute filed');
  });


  it('is refused outside the review window, writing no approval and no audit row', async () => {
    const { claimId } = await makeReviewableClaim('EARLY', 48 * 60 * 60 * 1000);
    const before = (await db.getClaim(claimId))!;

    const result = await db.approveSettlement(claimId, 'admin-jane', 'too early');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('outside_review_window');
    expect(result.alreadyApproved).toBe(false);

    const after = (await db.getClaim(claimId))!;
    expect(after.settlement_approved_at ?? null).toBeNull();
    expect(after.settlement_approved_by ?? null).toBeNull();
    expect(after.status).toBe(before.status);
    expect((await approvalAuditsFor(claimId)).length, 'no success evidence for a refused approval').toBe(0);
    // ...and the release CAS refuses the same claim for the same reason.
    expect(await db.attemptSettlementRelease(claimId)).toBe(false);
  });

  it('is refused for a claim that is not pending_settlement, for a missing window, and for an unknown claim', async () => {
    // (a) A claim that has already left the review state entirely.
    const { claimId: releasableId } = await makeReviewableClaim('NOTPENDING', -1000);
    expect((await db.approveSettlement(releasableId, 'admin-jane', 'prime it')).ok).toBe(true);
    expect(await db.attemptSettlementRelease(releasableId)).toBe(true);
    const moved = await db.approveSettlement(releasableId, 'admin-jane', 'again while releasing');
    expect(moved.ok).toBe(false);
    expect(moved.code).toBe('not_pending_settlement');

    // (b) A claim whose settle_at was never set has no review window at all.
    const noWindow = await makeReviewableClaim('NOWINDOW', -1000);
    // Clear the window through the same table the application reads, so this is
    // the real "legacy row with no settle_at" shape.
    await drizzleDb.update(claimsTable).set({ settle_at: null } as any).where(eq(claimsTable.id, noWindow.claimId));
    const noWindowResult = await db.approveSettlement(noWindow.claimId, 'admin-jane', 'no window');
    expect(noWindowResult.ok).toBe(false);
    expect(noWindowResult.code).toBe('no_review_window');
    expect(await db.attemptSettlementRelease(noWindow.claimId), 'a claim with no deadline can never be released').toBe(false);

    // (c) A claim id that does not exist.
    const missing = await db.approveSettlement(`TEST-REVIEW-${testRunId}-DOES-NOT-EXIST`, 'admin-jane', 'ghost');
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('claim_not_found');
    expect(missing.claim).toBeNull();
  });

  it('requires a reason: a blank one records nothing at all', async () => {
    const { claimId } = await makeReviewableClaim('NOREASON', -1000);
    for (const blank of ['', '   ']) {
      const result = await db.approveSettlement(claimId, 'admin-jane', blank);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('reason_required');
    }
    const claim = (await db.getClaim(claimId))!;
    expect(claim.settlement_approved_at ?? null).toBeNull();
    expect((await approvalAuditsFor(claimId)).length).toBe(0);
  });


  it('two concurrent approvals produce exactly one success, one audit row and one stored approval', async () => {
    const { claimId } = await makeReviewableClaim('RACE', -1000);

    const results = await Promise.all([
      db.approveSettlement(claimId, 'admin-1', 'first approver'),
      db.approveSettlement(claimId, 'admin-2', 'second approver'),
    ]);

    // Exactly one call may report success. Before this batch BOTH would have,
    // because the CAS used `= NULL` (which matched the row in the test double and
    // matched nothing in Postgres) and the method returned ok:true without
    // checking the affected-row count at all.
    expect(results.filter((r) => r.ok).length, 'exactly one approval may be recorded').toBe(1);
    expect(results.filter((r) => !r.ok).every((r) => r.code === 'already_approved')).toBe(true);

    // The stored identity/timestamp is the WINNER's, and it was never overwritten.
    const claim = (await db.getClaim(claimId))!;
    const winner = results.find((r) => r.ok)!;
    expect(claim.settlement_approved_by).toBe(winner.claim!.settlement_approved_by);
    expect(['admin-1', 'admin-2']).toContain(String(claim.settlement_approved_by));
    expect(claim.settlement_approved_at).toBe(winner.claim!.settlement_approved_at);

    // Exactly ONE success audit row exists, and it names the same administrator -
    // no false success evidence for the loser.
    const audits = await approvalAuditsFor(claimId);
    expect(audits.length).toBe(1);
    expect(audits[0].admin_user).toBe(claim.settlement_approved_by);
  });

  it('approval is what unlocks the release CAS, which still admits exactly one winner', async () => {
    const { claimId } = await makeReviewableClaim('UNLOCK', -1000);

    // Without the approval the (elapsed-window) claim cannot be released.
    expect(await db.attemptSettlementRelease(claimId)).toBe(false);
    expect((await db.getClaim(claimId))!.status).toBe('pending_settlement');

    // With it, exactly one of two concurrent initiations wins the lock.
    expect((await db.approveSettlement(claimId, 'admin-jane', 'unlock release')).ok).toBe(true);
    const results = await Promise.all([
      db.attemptSettlementRelease(claimId),
      db.attemptSettlementRelease(claimId),
    ]);
    expect(results.filter(Boolean).length).toBe(1);
    expect((await db.getClaim(claimId))!.status).toBe('releasing');
    // The approval survives the transition: it is a durable record, not a
    // one-shot token that a later step consumes.
    expect((await db.getClaim(claimId))!.settlement_approved_by).toBe('admin-jane');
  });

  it('the review queue returns due, unapproved claims and excludes approved or still-open ones', async () => {
    const { claimId: unapprovedDue } = await makeReviewableClaim('QUEUE-DUE', -1000);
    const { claimId: approvedDue } = await makeReviewableClaim('QUEUE-APPROVED', -1000);
    const { claimId: openWindow } = await makeReviewableClaim('QUEUE-OPEN', 6 * 60 * 60 * 1000);
    expect((await db.approveSettlement(approvedDue, 'admin-jane', 'already approved')).ok).toBe(true);

    const queued = (await db.getClaimsEligibleForSettlementReview()).map((c) => c.id);
    expect(queued, 'an unapproved, due claim is in the review queue').toContain(unapprovedDue);
    expect(queued, 'an approved claim is no longer awaiting review').not.toContain(approvedDue);
    expect(queued, 'a claim still inside its window is not due for review').not.toContain(openWindow);

    // The queue is a READ: it changed nothing.
    expect((await db.getClaim(unapprovedDue))!.settlement_approved_at ?? null).toBeNull();
  });
});


// ===========================================================================
// D-2B-B-E — THE IN-MEMORY EXECUTOR FOLLOWS SQL NULL SEMANTICS
// ===========================================================================
// The defect this pins: the test double compared values with
// `String(row[col]) === String(val)`, so `String(null) === String(null)` was
// TRUE. A production predicate of the form `eq(column, null)` - which compiles to
// `column = NULL` and matches NOTHING in PostgreSQL - therefore matched every
// NULL row here, and a mock-backed test could "verify" a broken predicate. These
// assertions run the SAME Drizzle expressions the application uses, through the
// same executor, and require Postgres' three-valued answers.
// ===========================================================================
describe('D-2B-B-E — the in-memory executor follows SQL NULL semantics', () => {
  it('eq(col, null) matches nothing, isNull() matches the NULL row, isNotNull() excludes it', async () => {
    const nullId = `TEST-NULLSEM-${testRunId}-NULL`;
    const setId = `TEST-NULLSEM-${testRunId}-SET`;
    const base = {
      item_id: `TEST-NULLSEM-ITEM-${testRunId}`,
      owner_phone: '+254700000000',
      security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'null-semantics fixture' },
      verification_tier: 1,
      status: 'pending_settlement',
    } as any;

    // The in-memory executor parses ONE `VALUES (...)` tuple per INSERT (it has
    // no multi-row handling — see the note in notificationSchemaN2.test.ts), so
    // a multi-row VALUES writes only the first row and the non-NULL row would
    // never exist. Two separate single-row inserts write both rows, exactly as
    // the harness supports, so the positive isNotNull() assertion below really
    // does operate on an actual non-NULL row.
    await drizzleDb.insert(claimsTable).values({ id: nullId, ...base, settlement_approved_at: null } as any);
    await drizzleDb.insert(claimsTable).values({ id: setId, ...base, settlement_approved_at: new Date() } as any);

    // `col = NULL` is UNKNOWN in SQL: it must not match the NULL row...
    const eqNullOnNullRow = await drizzleDb
      .select()
      .from(claimsTable)
      .where(and(eq(claimsTable.id, nullId), eq(claimsTable.settlement_approved_at, null)) as any);
    expect(eqNullOnNullRow.length, 'eq(col, null) must not match a NULL row').toBe(0);
    // ...nor the non-NULL row (it matches nothing at all).
    const eqNullOnSetRow = await drizzleDb
      .select()
      .from(claimsTable)
      .where(and(eq(claimsTable.id, setId), eq(claimsTable.settlement_approved_at, null)) as any);
    expect(eqNullOnSetRow.length, 'eq(col, null) must not match a non-NULL row either').toBe(0);

    // isNull() is the correct predicate for "is NULL" ...
    const isNullRows = await drizzleDb
      .select()
      .from(claimsTable)
      .where(and(eq(claimsTable.id, nullId), isNull(claimsTable.settlement_approved_at)) as any);
    expect(isNullRows.length).toBe(1);
    // ... and a NULL value is still excluded by isNotNull() and by any list test.
    const isNotNullRows = await drizzleDb
      .select()
      .from(claimsTable)
      .where(and(eq(claimsTable.id, nullId), isNotNull(claimsTable.settlement_approved_at)) as any);
    expect(isNotNullRows.length).toBe(0);
    const notInRows = await drizzleDb
      .select()
      .from(claimsTable)
      .where(and(
        eq(claimsTable.id, nullId),
        notInArray(claimsTable.settlement_approved_at as any, [new Date()] as any),
      ) as any);
    expect(notInRows.length, 'NULL NOT IN (...) is UNKNOWN, so the row must be excluded').toBe(0);
    // The non-NULL row is still visible to the ordinary predicates, so the fix
    // did not turn every comparison into a non-match.
    const setRow = await drizzleDb
      .select()
      .from(claimsTable)
      .where(and(eq(claimsTable.id, setId), isNotNull(claimsTable.settlement_approved_at)) as any);
    expect(setRow.length).toBe(1);

    // Leave the harness as it was found.
    await drizzleDb.delete(claimsTable).where(eq(claimsTable.id, nullId));
    await drizzleDb.delete(claimsTable).where(eq(claimsTable.id, setId));
  });
});
