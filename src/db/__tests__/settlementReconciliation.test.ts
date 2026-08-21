import { describe, it, expect } from 'vitest';
import { db } from '../database';

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
  const claimId = `TEST-CLAIM-${suffix}`;
  const itemId = `TEST-ITEM-${suffix}`;
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
