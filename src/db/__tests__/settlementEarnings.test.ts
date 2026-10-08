import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../database';
import { testRunId } from './ensureTestCategory';
// E3A — the shared retry-eligibility predicate, imported rather than restated
// so these tests assert the SAME rule the settlement executor applies.
import { isPayoutSubmittable } from '../../config/payoutOutcomes';

// =============================================================================
// ISSUE B — SETTLEMENT / PAYOUT VISIBILITY (and a verification of the sweep)
// =============================================================================
// THE OBSERVED CONFUSION
//   A claim whose handover had been confirmed sits in 'pending_settlement' for the
//   whole dispute window, with its agent_payout ledger row booked as 'pending' and
//   NOTHING disbursed yet. The Agent dashboard read `getAgentEarnings()`, which
//   summed only completed agent_payout rows — so it displayed "Total Earned: KES 0"
//   the entire time, even though a real, booked payout was already owed.
//
// WHAT WAS CHANGED (visibility only)
//   getAgentEarnings() now publishes the two states separately:
//     completed (paid) earnings  <- agent_payout + status 'completed'
//     pending settlement earnings<- agent_payout + status 'pending'
//   The 48-hour dispute window, enterPendingSettlement, the CAS release lock, the
//   per-recipient ledger rows and the provider payout are all UNCHANGED. Nothing is
//   paid earlier. Failed payouts are counted in neither figure.
//
// This file also verifies the settlement sweep's own guarantees (A–I of the brief)
// against the real database functions the sweep calls.
// =============================================================================

// This file lives in src/db/__tests__, so the repo root is three levels up.
const repoRoot = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
const SERVER_TS = read('src/server.ts');
const AGENT_OPS_TS = read('src/routes/agentOps.ts');
const DATABASE_TS = read('src/db/database.ts');

const DISPUTE_WINDOW_MS = 48 * 60 * 60 * 1000;

async function makeAgent(suffix: string) {
  const id = `TEST-AGENT-EARNINGS-${testRunId}-${suffix}`;
  await db.createAgent({
    id,
    business_name: 'Test Earnings Hub',
    // contact_phone is NOT NULL UNIQUE in the real schema; the trailing code is
    // derived from the suffix so every fixture phone is distinct.
    contact_phone: `+2547${testRunId}${String(suffix.charCodeAt(0))}`,
    location_address: 'Test location',
    latitude: null,
    longitude: null,
    mpesa_till_or_paybill: `9${String(suffix.charCodeAt(0))}4321`,
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-earnings',
    needs_manual_geocoding: false,
  } as any);
  return id;
}

async function makeCategory(suffix: string) {
  const id = `test-cat-earnings-${testRunId}-${suffix}`;
  const existing = await db.getCategories();
  if (existing.some((c) => c.id === id)) return id;
  await db.createCategory({
    id,
    name_en: 'Test Earnings Category',
    name_sw: 'Kategoria ya Mapato',
    total_fee: 1000,
    finder_share: 250,
    agent_share: 350,
    platform_share: 400,
    is_sensitive_document: false,
  });
  return id;
}

/**
 * A real escrow_held claim with an item, an agent and a category — the state
 * enterPendingSettlement() requires. Returns the ids plus the locked split.
 */
async function makeEscrowHeldClaim(suffix: string) {
  const categoryId = await makeCategory(suffix);
  const agentId = await makeAgent(suffix);
  const itemId = `TEST-ITEM-EARNINGS-${testRunId}-${suffix}`;
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
    finder_phone: '+254700000031',
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

  const claimId = `TEST-CLAIM-EARNINGS-${testRunId}-${suffix}`;
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: '+254700000032',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
    verification_tier: 1,
    status: 'escrow_held',
    owner_id_proof_url: null,
    payment_reference: `TEST-PAYREF-EARNINGS-${suffix}`,
    owner_identifying_details: null,
  } as any);

  return { claimId, itemId, agentId, categoryId };
}

const ledgerRow = async (claimId: string, type: string) =>
  (await db.getLedgerEntriesForClaim(claimId)).find((e) => e.type === type);

// ===========================================================================
// TEST 4 — pending settlement vs completed earnings
// ===========================================================================
describe('TEST 4 — the Agent sees pending settlement separately from paid earnings', () => {
  it('a booked-but-unpaid payout is PENDING, and is NOT reported as KES 0 earned', async () => {
    const { claimId, agentId } = await makeEscrowHeldClaim('A');

    const before = await db.getAgentEarnings(agentId);
    expect(before.totalEarned).toBe(0);
    expect(before.completedPayoutsCount).toBe(0);
    expect(before.pendingSettlementEarnings).toBe(0);

    // Handover confirmed: the three payout rows are booked as 'pending'.
    const settlement = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
    expect(settlement.success, settlement.message).toBe(true);
    expect((await db.getClaim(claimId))?.status).toBe('pending_settlement');

    const pending = await db.getAgentEarnings(agentId);
    // The defect: this used to be 0, with no way to see the owed amount at all.
    expect(pending.totalEarned, 'nothing has actually been PAID yet').toBe(0);
    expect(pending.completedPayoutsCount).toBe(0);
    expect(pending.pendingSettlementEarnings, 'the booked agent share is visible as pending').toBe(350);
    expect(pending.pendingSettlementsCount).toBe(1);
  });

  it('a provider-confirmed payout moves the amount from PENDING to COMPLETED', async () => {
    const { claimId, agentId } = await makeEscrowHeldClaim('B');
    await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);

    const agentRow = (await ledgerRow(claimId, 'agent_payout'))!;
    expect(agentRow.status).toBe('pending');

    await db.recordPayoutAttempt(agentRow.id, {
      status: 'success',
      providerBatchId: 'BATCH-EARN-1',
      providerTransactionId: 'TXN-EARN-1',
    });

    const after = await db.getAgentEarnings(agentId);
    expect(after.totalEarned, 'completed earnings increase').toBe(350);
    expect(after.completedPayoutsCount).toBe(1);
    expect(after.pendingSettlementEarnings, 'pending earnings decrease to zero').toBe(0);
    expect(after.pendingSettlementsCount).toBe(0);
    // ...and the LEDGER ROW itself is what changed, not a cache.
    expect((await ledgerRow(claimId, 'agent_payout'))?.status).toBe('completed');
  });

  it('a FAILED payout is counted in NEITHER figure', async () => {
    const { claimId, agentId } = await makeEscrowHeldClaim('C');
    await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);

    const agentRow = (await ledgerRow(claimId, 'agent_payout'))!;
    await db.recordPayoutAttempt(agentRow.id, {
      status: 'failed',
      providerBatchId: 'BATCH-EARN-2',
      providerTransactionId: null,
      failureReason: 'Invalid till number.',
    });
    expect((await ledgerRow(claimId, 'agent_payout'))?.status).toBe('failed');

    const after = await db.getAgentEarnings(agentId);
    expect(after.totalEarned, 'a failed payout is not money the agent was paid').toBe(0);
    expect(after.completedPayoutsCount).toBe(0);
    expect(after.pendingSettlementEarnings, 'nor is it money currently on its way').toBe(0);
    expect(after.pendingSettlementsCount).toBe(0);
  });

  it('an UNCONFIRMED (unknown) provider outcome stays pending and is never completed', async () => {
    const { claimId, agentId } = await makeEscrowHeldClaim('D');
    await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);

    const agentRow = (await ledgerRow(claimId, 'agent_payout'))!;
    await db.recordPayoutAttempt(agentRow.id, {
      status: 'unknown',
      providerBatchId: null,
      providerTransactionId: null,
      failureReason: 'Network/timeout error contacting IntaSend — outcome unconfirmed.',
    });
    // recordPayoutAttempt maps 'unknown' to a PENDING row: the money may be on
    // its way, and it is certainly not paid.
    expect((await ledgerRow(claimId, 'agent_payout'))?.status).toBe('pending');
    // E3A — the provider outcome is recorded alongside it, and that is what
    // makes the row NOT eligible for another automatic submission: it is
    // unresolved work for provider reconciliation, not retry work.
    expect((await ledgerRow(claimId, 'agent_payout'))?.payout_outcome).toBe('unknown');
    expect(isPayoutSubmittable((await ledgerRow(claimId, 'agent_payout'))!)).toBe(false);

    const after = await db.getAgentEarnings(agentId);
    expect(after.totalEarned, 'an unconfirmed outcome must never read as completed').toBe(0);
    expect(after.completedPayoutsCount).toBe(0);
    expect(after.pendingSettlementEarnings).toBe(350);
    expect(after.pendingSettlementsCount).toBe(1);
  });

  it("another recipient's row never changes this agent's figures", async () => {
    const { claimId, agentId } = await makeEscrowHeldClaim('E');
    await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);

    const finderRow = (await ledgerRow(claimId, 'finder_payout'))!;
    await db.recordPayoutAttempt(finderRow.id, {
      status: 'success', providerBatchId: 'BATCH-EARN-3', providerTransactionId: 'TXN-EARN-FINDER',
    });

    const after = await db.getAgentEarnings(agentId);
    expect(after.totalEarned, "the finder's completed payout is not the agent's earnings").toBe(0);
    expect(after.pendingSettlementEarnings).toBe(350);
  });
});

// ===========================================================================
// TEST 5 — the 48-hour dispute window is honoured (and only then released)
// ===========================================================================
describe('TEST 5 — a claim inside its dispute window is never paid out', () => {
  it('settle_at in the FUTURE is not selected by the sweep and cannot be released', async () => {
    const { claimId } = await makeEscrowHeldClaim('F');
    const settlement = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
    expect(settlement.success, settlement.message).toBe(true);

    const claim = await db.getClaim(claimId);
    expect(claim?.settle_at, 'enterPendingSettlement must set the window').toBeTruthy();
    expect(new Date(claim!.settle_at!).getTime()).toBeGreaterThan(Date.now());

    // The sweep's own two decision points:
    //   1. getClaimsDueForSettlement() — the work queue (settle_at <= now).
    //   2. attemptSettlementRelease(id, /*force*/ false) — the CAS the sweep uses,
    //      which MUST honour settle_at.
    expect((await db.getClaimsDueForSettlement()).some((c) => c.id === claimId)).toBe(false);
    expect(await db.attemptSettlementRelease(claimId, false)).toBe(false);
    // Nothing moved: the claim is still waiting and no payout row was paid.
    expect((await db.getClaim(claimId))?.status).toBe('pending_settlement');
    expect((await db.getLedgerEntriesForClaim(claimId)).map((e) => `${e.type}:${e.status}`).sort())
      .toEqual(['agent_payout:pending', 'finder_payout:pending', 'platform_fee:pending']);
  });

  it('settle_at in the PAST is selected by the sweep and IS releasable', async () => {
    const { claimId } = await makeEscrowHeldClaim('G');
    // A window that has already elapsed (the SWEEP is what waits 48h; this fixture
    // only has to be due now).
    const settlement = await db.enterPendingSettlement(claimId, -1000);
    expect(settlement.success, settlement.message).toBe(true);

    expect((await db.getClaimsDueForSettlement()).some((c) => c.id === claimId)).toBe(true);
    expect(await db.attemptSettlementRelease(claimId, false), 'the sweep must be able to take the lock').toBe(true);
    expect((await db.getClaim(claimId))?.status).toBe('releasing');
  });

  it('E3A — a newly booked payout is recorded as never submitted, so it can be sent exactly once', async () => {
    const { claimId } = await makeEscrowHeldClaim('K');
    expect((await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS)).success).toBe(true);

    const finder = (await ledgerRow(claimId, 'finder_payout'))!;
    const agent = (await ledgerRow(claimId, 'agent_payout'))!;
    const platformFee = (await ledgerRow(claimId, 'platform_fee'))!;

    // The BOOKING path states the fact instead of leaving it to inference:
    // "booked, never submitted" is written down.
    expect(finder.payout_outcome).toBe('not_submitted');
    expect(agent.payout_outcome).toBe('not_submitted');
    // The platform's own retained fee never touches a provider, so it stays
    // NULL — there is no submission history because none can exist.
    expect(platformFee.payout_outcome ?? null).toBeNull();

    // ...which is exactly what keeps the FIRST legitimate submission possible.
    expect(isPayoutSubmittable(finder)).toBe(true);
    expect(isPayoutSubmittable(agent)).toBe(true);

    // Once the pre-submission marker is taken the row is no longer submittable,
    // so the same attempt cannot be issued twice...
    expect(await db.markPayoutSubmissionStarted(finder.id)).toBe(true);
    expect(isPayoutSubmittable((await ledgerRow(claimId, 'finder_payout'))!)).toBe(false);
    // ...and the sibling leg is untouched by it: the two recipients'
    // submission states are independent.
    expect(isPayoutSubmittable((await ledgerRow(claimId, 'agent_payout'))!)).toBe(true);
  });

  it('the 48-hour default dispute window is untouched by this batch', () => {
    expect(SERVER_TS).toContain(
      'const DISPUTE_WINDOW_HOURS = process.env.DISPUTE_WINDOW_HOURS ? parseFloat(process.env.DISPUTE_WINDOW_HOURS) : 48;',
    );
    // The handover route still books a pending settlement for that window and does
    // NOT pay immediately.
    expect(AGENT_OPS_TS).toContain('db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS)');
    expect(AGENT_OPS_TS).not.toContain('executeClaimSettlement');
  });
});

// ===========================================================================
// TEST 6 — idempotency: no duplicate payout execution, no duplicate rows
// ===========================================================================
describe('TEST 6 — settlement execution is idempotent', () => {
  it('the release CAS admits exactly ONE winner even when run concurrently', async () => {
    const { claimId } = await makeEscrowHeldClaim('H');
    await db.enterPendingSettlement(claimId, -1000);
    const rowsBefore = (await db.getLedgerEntriesForClaim(claimId)).length;
    expect(rowsBefore).toBe(3);

    const results = await Promise.all([
      db.attemptSettlementRelease(claimId, true),
      db.attemptSettlementRelease(claimId, true),
    ]);
    expect(results.filter(Boolean).length, 'exactly one caller may take the lock').toBe(1);
    // The loser books nothing at all.
    expect((await db.getLedgerEntriesForClaim(claimId)).length).toBe(rowsBefore);
    expect((await db.getClaim(claimId))?.status).toBe('releasing');
  });

  it('a repeated handover confirmation cannot book a second set of payout rows', async () => {
    const { claimId } = await makeEscrowHeldClaim('I');
    expect((await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS)).success).toBe(true);
    const rowsAfterFirst = (await db.getLedgerEntriesForClaim(claimId)).length;
    expect(rowsAfterFirst).toBe(3);

    const second = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
    expect(second.success, 'a repeat must lose the compare-and-swap').toBe(false);
    expect((await db.getLedgerEntriesForClaim(claimId)).length, 'no duplicate ledger rows').toBe(rowsAfterFirst);
  });

  it('running the full settlement twice produces one release, three completed rows and one FINALIZE_SETTLEMENT audit', async () => {
    const { claimId } = await makeEscrowHeldClaim('J');
    await db.enterPendingSettlement(claimId, -1000);
    expect(await db.attemptSettlementRelease(claimId, false)).toBe(true);

    // The provider confirmed both recipients (what executeClaimSettlement records).
    for (const type of ['finder_payout', 'agent_payout']) {
      const row = (await ledgerRow(claimId, type))!;
      await db.recordPayoutAttempt(row.id, {
        status: 'success', providerBatchId: 'BATCH-IDEM', providerTransactionId: `TXN-IDEM-${type}`,
      });
    }
    // H — platform_fee is NOT completed while the settlement is still in flight.
    expect((await ledgerRow(claimId, 'platform_fee'))?.status).toBe('pending');

    expect((await db.finalizeSettlement(claimId)).success).toBe(true);
    expect((await db.getClaim(claimId))?.status).toBe('released');
    const finalRows = await db.getLedgerEntriesForClaim(claimId);
    expect(finalRows.length, 'no duplicate ledger rows were created').toBe(3);
    expect(finalRows.every((r) => r.status === 'completed'), 'H — platform_fee completes only on finalize').toBe(true);

    const finalizeAudits = async () =>
      (await db.getAuditLogs()).filter(
        (a) => a.action === 'FINALIZE_SETTLEMENT' && String(a.details).includes(claimId),
      ).length;
    expect(await finalizeAudits()).toBe(1);

    // A repeat of the whole release/finalize path is refused and changes nothing.
    expect(await db.attemptSettlementRelease(claimId, true)).toBe(false);
    expect((await db.finalizeSettlement(claimId)).success).toBe(false);
    expect((await db.getLedgerEntriesForClaim(claimId)).length).toBe(3);
    expect(await finalizeAudits()).toBe(1);
  });
});

// ===========================================================================
// SWEEP VERIFICATION A–I — what the sweep itself guarantees
// ===========================================================================
// The sweep (releaseDueSettlements) and its executor (executeClaimSettlement) live
// in server.ts, which boots the HTTP listener at import time and therefore cannot
// be mounted. The behavioural halves are asserted above against the REAL database
// functions the sweep calls; the wiring is pinned here, exactly as the repo already
// does for other inline code in server.ts.
describe('the settlement sweep and its executor keep their safety guarantees (E3A reviewed them)', () => {
  it('B — the sweep takes its queue from the due-settlement query, not from all pending claims', () => {
    const sweep = SERVER_TS.slice(SERVER_TS.indexOf('async function releaseDueSettlements()'));
    expect(sweep).toContain('const due = await db.getClaimsDueForSettlement();');
    expect(sweep).toContain('const won = await db.attemptSettlementRelease(claim.id, false);');
    const casIdx = sweep.indexOf('attemptSettlementRelease(claim.id, false)');
    expect(sweep.indexOf('executeClaimSettlement(claim.id)'), 'money moves only after the lock is won').toBeGreaterThan(casIdx);
  });

  it('A — the due-settlement query is the ONLY place settle_at is applied, and it is a read-only SELECT', () => {
    const body = DATABASE_TS.slice(
      DATABASE_TS.indexOf('public async getClaimsDueForSettlement('),
      DATABASE_TS.indexOf('STAGE 2', DATABASE_TS.indexOf('public async getClaimsDueForSettlement(')),
    );
    expect(body).toContain('eq(claimsTable.status, "pending_settlement")');
    expect(body).toContain('new Date(r.settle_at).getTime() <= now');
    // No write of any kind in the work-queue query.
    expect(body).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });

  it('D — only recipients whose payout was NEVER SUBMITTED are ever sent money (E3A)', () => {
    // Eligibility is no longer inferred from 'pending' alone: the executor asks
    // the ONE shared predicate, so an accepted/uncertain row cannot be re-sent.
    expect(SERVER_TS).toContain('const submittable = candidates.filter(c => isPayoutSubmittable(c.row));');
    expect(SERVER_TS).toContain("import { isPayoutSubmittable } from './config/payoutOutcomes';");
    // The old status-only gate must NOT come back.
    expect(SERVER_TS).not.toContain("if (finderRow && finderRow.status === 'pending') {");
    expect(SERVER_TS).not.toContain("if (agentRow && agentRow.status === 'pending') {");

    // Every row enters the provider batch only after winning its durable
    // pre-submission marker, and the marker is written BEFORE the call.
    expect(SERVER_TS).toContain('if (await db.markPayoutSubmissionStarted(candidate.row.id)) {');
    const markerIdx = SERVER_TS.indexOf('markPayoutSubmissionStarted(candidate.row.id)');
    const callIdx = SERVER_TS.indexOf('await PaymentService.triggerIntasendPayout(claimId, claimed.map(c => c.payload))');
    expect(markerIdx).toBeGreaterThan(-1);
    expect(callIdx, 'the durable marker must precede the provider call').toBeGreaterThan(markerIdx);

    // And the outcome is re-read rather than assumed.
    expect(SERVER_TS).toContain('const unresolvedPayout = refreshedLedgerRows.find(');
    expect(SERVER_TS).toContain("r => (r.type === 'finder_payout' || r.type === 'agent_payout') && r.status !== 'completed'");
  });

  it('F — a non-completed recipient reverts the lock, and is never auto-resubmitted', () => {
    const unresolvedIdx = SERVER_TS.indexOf('if (unresolvedPayout) {');
    const finalizedIdx = SERVER_TS.indexOf('const finalized = await db.finalizeSettlement', unresolvedIdx);
    expect(unresolvedIdx).toBeGreaterThan(-1);
    expect(finalizedIdx, 'the unresolved branch must end before finalization').toBeGreaterThan(unresolvedIdx);
    const branch = SERVER_TS.slice(unresolvedIdx, finalizedIdx);
    // The lock is given back so the claim cannot stay parked in 'releasing'.
    expect(branch).toContain('await db.revertSettlementRelease(claimId);');
    // ...but the PAYOUT is not re-queued: the operator-facing message says so
    // explicitly, and eligibility is re-decided from payout_outcome, not from
    // claim state.
    expect(branch).toContain('will NOT be resubmitted automatically');
    expect(branch).toContain("'PAYOUT_RECONCILIATION_REQUIRED'");
  });

  it('F2 (E3A) — every LOCAL failure path returns the release lock instead of stranding the claim', () => {
    const start = SERVER_TS.indexOf('async function executeClaimSettlement');
    const end = SERVER_TS.indexOf('const claimLedgerRows = await db.getLedgerEntriesForClaim(claimId);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const head = SERVER_TS.slice(start, end);

    // The lock is given back on every one of them (this function runs only
    // after the lock was already won, so a bare early return would park the
    // claim in 'releasing' with nothing able to reach it).
    expect(head).toContain('const abandonRelease = async (reason: string) => {');
    expect(head).toContain('await db.revertSettlementRelease(claimId);');
    expect(head).toContain("'SETTLEMENT_RELEASE_ABANDONED'");
    // No un-reverted early return may come back.
    expect(head).not.toMatch(/return \{ success: false, message: '(Claim|Item|Agent|Category) not found/);
    // ...and every one of the four lookups uses it.
    expect((head.match(/return await abandonRelease\(/g) ?? []).length).toBe(4);
  });

  it('G — finalizeSettlement refuses while any finder/agent payout is not genuinely completed', () => {
    const body = DATABASE_TS.slice(
      DATABASE_TS.indexOf('public async finalizeSettlement('),
      DATABASE_TS.indexOf('NOTE: the old refundEscrow()'),
    );
    expect(body).toContain("r => (r.type === 'finder_payout' || r.type === 'agent_payout') && r.status !== 'completed'");
    const guardIdx = body.indexOf('if (outstandingPayout) {');
    const bulkIdx = body.indexOf('.set({ status: "completed" })');
    expect(guardIdx, 'the guard must run before the bulk completion').toBeLessThan(bulkIdx);
  });

  it('H — the admin revenue figure counts only COMPLETED platform_fee rows', () => {
    expect(SERVER_TS).toContain("ledger.filter(l => l.type === 'platform_fee' && l.status === 'completed').reduce((sum, l) => sum + l.amount, 0)");
  });
});

describe('I — the Agent Hub publishes pending and completed earnings as separate figures', () => {
  const HUB = read('src/components/agent/AgentHub.tsx');
  const HOOK = read('src/hooks/useAgentOperations.ts');
  const TYPES = read('src/types/agent.ts');

  it('the server projects both figures from the ledger, not from client state', async () => {
    const { totalEarned, completedPayoutsCount, pendingSettlementEarnings, pendingSettlementsCount } =
      await db.getAgentEarnings(`TEST-AGENT-EARNINGS-${testRunId}-A`);
    expect([totalEarned, completedPayoutsCount, pendingSettlementEarnings, pendingSettlementsCount].every(Number.isFinite)).toBe(true);
    expect(read('src/routes/agentOps.ts')).toContain('const earnings = await db.getAgentEarnings(agentId);');
  });

  it('the earnings projection carries all four fields through the client boundary', () => {
    for (const field of ['pendingSettlementEarnings', 'pendingSettlementsCount']) {
      expect(TYPES, `${field} missing from AgentEarnings`).toContain(field);
      expect(HOOK, `${field} missing from the hook state`).toContain(field);
      expect(HUB, `${field} missing from the Hub`).toContain(field);
    }
  });

  it('the Hub keeps paid earnings and pending settlement visually distinct', () => {
    // The two EXISTING figures stay at exactly one read each (the card's own
    // binding), so this batch cannot have duplicated the earnings surface.
    expect((HUB.match(/props\.agentEarnings\.totalEarned/g) ?? []).length).toBe(1);
    expect((HUB.match(/props\.agentEarnings\.completedPayoutsCount/g) ?? []).length).toBe(1);
    // The two NEW figures are read by the separate pending-settlement card (once
    // for its render guard and once for the value).
    expect((HUB.match(/props\.agentEarnings\.pendingSettlementEarnings/g) ?? []).length).toBe(1);
    expect((HUB.match(/props\.agentEarnings\.pendingSettlementsCount/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(HUB).toContain('Pending settlement (not yet paid');
    expect(HUB).toContain('handovers awaiting settlement');
    expect(HUB).toContain('completed handovers paid out');
  });
});
