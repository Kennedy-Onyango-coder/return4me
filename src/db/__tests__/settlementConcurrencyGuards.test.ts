import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../database';
import { testRunId } from './ensureTestCategory';

// =============================================================================
// SEC-2B-01 / SEC-2B-03 REGRESSION — WRITE-TIME COMPARE-AND-SWAP
// =============================================================================
// THE DEFECTS THIS PINS
//
// SEC-2B-01 — enterPendingSettlement() guarded the escrow_held ->
// pending_settlement transition with an application-level READ
// (`if (claim.status !== "escrow_held") return failure`) and then wrote with
// `.where(eq(claimsTable.id, claimId))` — no status predicate. Under
// PostgreSQL's default READ COMMITTED isolation, two concurrent
// POST /api/agents/confirm-handover requests can both read 'escrow_held'
// before either writes; the second UPDATE still matches on id, so BOTH callers
// book the three payout ledger rows and an audit entry. The duplicate
// finder_payout/agent_payout rows are then permanently 'pending' (the payout
// executor pays per TYPE, from the first row), which makes finalizeSettlement()
// refuse forever — the claim is stranded in 'releasing' after real money has
// already been disbursed.
//
// SEC-2B-03 — finalizeSettlement() had the identical shape on
// releasing -> released, so two concurrent finalisations both wrote the claim
// and both inserted a FINALIZE_SETTLEMENT audit row.
//
// HOW THIS TEST PROVES THE GUARD RATHER THAN THE READ
//
// The in-memory mock used in CI is single-threaded and strips BEGIN/COMMIT,
// so it cannot hold a row lock. But it DOES evaluate UPDATE WHERE predicates
// through evaluateWhere() and returns the matched rows (src/db/index.ts,
// branch "3. UPDATE"), and every statement is awaited — so two overlapping
// async calls genuinely interleave: both transactions reach and complete
// their `tx.select()` reads before either reaches its UPDATE. That is exactly
// the dangerous interleaving the audit describes, reproduced deterministically
// with Promise.all.
//
// Because both callers therefore read 'escrow_held', the loser CANNOT be
// rejected by the read-based guard: the only thing that can stop it is the
// status predicate on the write. Each concurrency test asserts the loser's
// message is the CAS-specific one ("no longer in status: …"), which is what
// makes the ledger/audit counting assertions meaningful: if the predicate were
// removed, the loser's message would change and the ledger counts would be 6
// instead of 3. A supplementary structural assertion pinning the SQL shape is
// included at the bottom; it does NOT replace these behavioural checks.
// =============================================================================

const DISPUTE_WINDOW_MS = 60 * 60 * 1000;

async function makeAgent(suffix: string) {
  const id = `TEST-AGENT-SETTLE-CAS-${testRunId}-${suffix}`;
  await db.createAgent({
    id,
    business_name: 'Test Settlement Hub',
    // T-1 FIXTURE FIX — agents.contact_phone is NOT NULL UNIQUE in the real
    // schema (src/db/schema.ts:55, sql/schema.sql:44), but the in-memory mock
    // does not enforce that constraint (src/db/index.ts declares unique indexes
    // only for customer_claim_links). The previous
    // `suffix === 'A' ? '31' : '32'` therefore produced FOUR identical
    // `+2547<runId>32` rows for suffixes B–E: green under the mock, three
    // unique-key violations against a real PostgreSQL. The trailing two digits
    // are now derived deterministically from the fixture suffix ('A'..'E' ->
    // 65..69), so every agent this file creates has a distinct phone and each
    // value stays a valid E.164 Kenyan number (+254 followed by exactly 9
    // digits, 13 chars — inside the column's VARCHAR(15)). No randomness, and
    // nothing outside this fixture changes.
    contact_phone: `+2547${testRunId}${String(suffix.charCodeAt(0))}`,
    location_address: 'Test location',
    latitude: null,
    longitude: null,
    mpesa_till_or_paybill: '123456',
    payout_method_type: 'Till Number',
    status: 'active',
    refundable_deposit: 0,
    national_id_hash: 'test-hash-settle-cas',
    needs_manual_geocoding: false,
  } as any);
  return id;
}

async function makeCategory(suffix: string) {
  const id = `test-cat-settle-cas-${testRunId}-${suffix}`;
  const existing = await db.getCategories();
  if (existing.some((c) => c.id === id)) return id;
  await db.createCategory({
    id,
    name_en: 'Test Settlement Category',
    name_sw: 'Kategoria ya Malipo',
    total_fee: 1000,
    finder_share: 250,
    agent_share: 350,
    platform_share: 400,
    is_sensitive_document: false,
  });
  return id;
}

/**
 * A claim sitting in 'escrow_held' with a real item, agent and category, so
 * enterPendingSettlement() can run its whole path. Returns the ids plus the
 * item's locked split so the ledger amounts can be asserted.
 */
async function makeEscrowHeldClaim(suffix: string) {
  const categoryId = await makeCategory(suffix);
  const agentId = await makeAgent(suffix);
  const itemId = `TEST-ITEM-SETTLE-CAS-${testRunId}-${suffix}`;
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

  const claimId = `TEST-CLAIM-SETTLE-CAS-${testRunId}-${suffix}`;
  await db.createClaim({
    id: claimId,
    item_id: itemId,
    owner_phone: '+254700000022',
    security_answers: { lastDigits: '0000', color: 'black', lostDetails: 'test fixture' },
    verification_tier: 1,
    status: 'escrow_held',
    owner_id_proof_url: null,
    payment_reference: `TEST-PAYREF-SETTLE-CAS-${suffix}`,
    owner_identifying_details: null,
  } as any);

  return { claimId, itemId, agentId, categoryId };
}

async function auditRowsForClaim(action: string, claimId: string) {
  const logs = await db.getAuditLogs();
  return logs.filter((l: any) => l.action === action && String(l.details || '').includes(claimId));
}

function countType(entries: any[], type: string) {
  return entries.filter((e) => e.type === type).length;
}

// ---------------------------------------------------------------------------
// SEC-2B-03 — two concurrent finalizeSettlement() calls, one claim
// ---------------------------------------------------------------------------
/** A claim in 'releasing' whose finder/agent payouts are already confirmed. */
async function makeReleasableClaim(suffix: string) {
  const { claimId, itemId } = await makeEscrowHeldClaim(suffix);
  // Move it into 'releasing' through the ordinary primitives: settle it, then
  // win the release CAS. (No payout is actually triggered — this is the DB
  // layer, not executeClaimSettlement.)
  const settled = await db.enterPendingSettlement(claimId, 0);
  expect(settled.success, 'fixture must reach pending_settlement').toBe(true);
  const released = await db.attemptSettlementRelease(claimId, true);
  expect(released, 'fixture must win the release CAS').toBe(true);

  const entries = await db.getLedgerEntriesForClaim(claimId);
  for (const type of ['finder_payout', 'agent_payout']) {
    const row = entries.find((e) => e.type === type);
    expect(row, `fixture must have a ${type} row`).toBeTruthy();
    await db.recordPayoutAttempt(row!.id, {
      status: 'success',
      providerBatchId: `BATCH-SETTLE-CAS-${suffix}`,
      providerTransactionId: `TXN-${type}-${suffix}`,
    });
  }
  expect((await db.getClaim(claimId))?.status).toBe('releasing');
  return { claimId, itemId };
}

describe('SEC-2B-03: only one concurrent caller can move releasing -> released', () => {
  it('one winner, one loser, exactly one FINALIZE_SETTLEMENT audit row', async () => {
    const { claimId } = await makeReleasableClaim('D');

    const [first, second] = await Promise.all([
      db.finalizeSettlement(claimId),
      db.finalizeSettlement(claimId),
    ]);

    const results = [first, second];
    expect(results.filter((r) => r.success), 'exactly one caller may finalize').toHaveLength(1);
    const losers = results.filter((r) => !r.success);
    expect(losers).toHaveLength(1);

    // Same self-validating property as SEC-2B-01: both callers read 'releasing'
    // before either wrote, so the loser must have been stopped by the write-time
    // predicate.
    expect(
      losers[0].message,
      'the loser must be rejected by the write-time status predicate, not by the earlier read',
    ).toContain('no longer in status: releasing');

    expect((await db.getClaim(claimId))?.status).toBe('released');

    const audit = await auditRowsForClaim('FINALIZE_SETTLEMENT', claimId);
    expect(audit, 'duplicate finalization audit entry').toHaveLength(1);

    // The bulk pending -> completed sweep is idempotent; nothing is duplicated.
    const entries = await db.getLedgerEntriesForClaim(claimId);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.status === 'completed')).toBe(true);
  });

  it('a second finalization after the claim is already released is a no-op', async () => {
    const { claimId } = await makeReleasableClaim('E');

    const first = await db.finalizeSettlement(claimId);
    expect(first.success).toBe(true);

    const retry = await db.finalizeSettlement(claimId);
    expect(retry.success).toBe(false);

    expect(await auditRowsForClaim('FINALIZE_SETTLEMENT', claimId)).toHaveLength(1);
    expect((await db.getClaim(claimId))?.status).toBe('released');
  });
});

// ---------------------------------------------------------------------------
// SEC-2B-01 — two concurrent enterPendingSettlement() calls, one claim
// ---------------------------------------------------------------------------
describe('SEC-2B-01: only one concurrent caller can move escrow_held -> pending_settlement', () => {
  it('one winner, one loser, exactly three ledger rows and one audit row (never six)', async () => {
    const { claimId } = await makeEscrowHeldClaim('A');

    // GENUINE interleaving: both calls are started before either is awaited, and
    // every mock statement is awaited, so both transactions complete their
    // SELECT reads before either issues its UPDATE.
    const [first, second] = await Promise.all([
      db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS),
      db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS),
    ]);

    const results = [first, second];
    const winners = results.filter((r) => r.success);
    const losers = results.filter((r) => !r.success);

    expect(winners, 'exactly one caller may win the transition').toHaveLength(1);
    expect(losers, 'exactly one caller must lose it').toHaveLength(1);

    // --- the guard that rejected the loser must be the WRITE-TIME predicate ---
    // Both callers read 'escrow_held' before either wrote, so the read-based
    // check could not have caught the loser. This message therefore proves the
    // loser was stopped by the CAS itself — which is what gives the ledger
    // counts below their meaning.
    expect(
      losers[0].message,
      'the loser must be rejected by the write-time status predicate, not by the earlier read',
    ).toContain('no longer in status: escrow_held');

    // --- the observable state ---
    const claim = await db.getClaim(claimId);
    expect(claim?.status).toBe('pending_settlement');

    const entries = await db.getLedgerEntriesForClaim(claimId);
    expect(entries, 'exactly one settlement booking must exist').toHaveLength(3);
    expect(countType(entries, 'finder_payout'), 'duplicate finder payout booked').toBe(1);
    expect(countType(entries, 'agent_payout'), 'duplicate agent payout booked').toBe(1);
    expect(countType(entries, 'platform_fee'), 'duplicate platform fee booked').toBe(1);

    // Amounts are unchanged by this fix (the loser books nothing at all).
    expect(entries.find((e) => e.type === 'finder_payout')?.amount).toBe(250);
    expect(entries.find((e) => e.type === 'agent_payout')?.amount).toBe(350);
    expect(entries.find((e) => e.type === 'platform_fee')?.amount).toBe(400);

    const audit = await auditRowsForClaim('ENTER_PENDING_SETTLEMENT', claimId);
    expect(audit, 'duplicate settlement audit entry').toHaveLength(1);
  });

  it('a later / retried call after the transition won is a no-op — no second booking', async () => {
    const { claimId } = await makeEscrowHeldClaim('B');

    const first = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
    expect(first.success).toBe(true);

    const retry = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
    expect(retry.success).toBe(false);

    const entries = await db.getLedgerEntriesForClaim(claimId);
    expect(entries).toHaveLength(3);
    expect(await auditRowsForClaim('ENTER_PENDING_SETTLEMENT', claimId)).toHaveLength(1);
    expect((await db.getClaim(claimId))?.status).toBe('pending_settlement');
  });

  it('a claim that is not in escrow_held can never be booked into settlement', async () => {
    const { claimId } = await makeEscrowHeldClaim('C');
    // Move it out of escrow_held first (as a refund/dispute would).
    await db.updateClaimStatus(claimId, 'disputed');

    const result = await db.enterPendingSettlement(claimId, DISPUTE_WINDOW_MS);
    expect(result.success).toBe(false);

    const entries = await db.getLedgerEntriesForClaim(claimId);
    expect(entries, 'no payout may be booked for a claim that never was in escrow').toHaveLength(0);
    expect((await db.getClaim(claimId))?.status).toBe('disputed');
  });
});

// ---------------------------------------------------------------------------
// SUPPLEMENTARY (structural) — these do NOT replace the behavioural tests
// above. They exist so the guarded SQL shape cannot silently regress to the
// unguarded "SELECT-guard then blind UPDATE" form, which is the shape that
// makes the two races above possible in the first place.
// ---------------------------------------------------------------------------
const databaseTs = fs.readFileSync(path.resolve(__dirname, '../database.ts'), 'utf8');

describe('the settlement CAS guards are expressed as conditional UPDATEs (supplementary)', () => {
  const ENTER_START = 'public async enterPendingSettlement';
  const ENTER_END = '   * Returns claims whose dispute window';
  const FINALIZE_START = 'public async finalizeSettlement';
  const FINALIZE_END = 'NOTE: the old refundEscrow()';

  function fnBody(startMarker: string, endMarker: string): string {
    const start = databaseTs.indexOf(startMarker);
    expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
    const end = databaseTs.indexOf(endMarker, start);
    expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
    return databaseTs.slice(start, end);
  }

  it('enterPendingSettlement transitions with WHERE id AND status = "escrow_held" + RETURNING', () => {
    const body = fnBody(ENTER_START, ENTER_END);
    expect(body).toMatch(
      /\.set\(\{ status: "pending_settlement", settle_at: settleAt, updated_at: new Date\(\) \}\)[\s\S]*?\.where\(and\(eq\(claimsTable\.id, claimId\), eq\(claimsTable\.status, "escrow_held"\)\)\)[\s\S]*?\.returning\(/,
    );
    // The unguarded form must never come back.
    expect(body).not.toMatch(
      /\.set\(\{ status: "pending_settlement"[\s\S]{0,240}?\.where\(eq\(claimsTable\.id, claimId\)\)/,
    );
  });

  it('enterPendingSettlement books no ledger rows when the CAS affects zero rows', () => {
    const body = fnBody(ENTER_START, ENTER_END);
    const casIdx = body.indexOf('if (wonSettlementSlot.length === 0)');
    const firstLedgerIdx = body.indexOf('tx.insert(ledgerTable)');
    expect(casIdx, 'zero-row guard present').toBeGreaterThan(-1);
    expect(firstLedgerIdx, 'ledger insert present').toBeGreaterThan(-1);
    expect(casIdx, 'the zero-row guard must run before any ledger insert').toBeLessThan(firstLedgerIdx);
  });

  it('finalizeSettlement transitions with WHERE id AND status = "releasing" + RETURNING', () => {
    const body = fnBody(FINALIZE_START, FINALIZE_END);
    expect(body).toMatch(
      /\.set\(\{ status: "released", updated_at: new Date\(\) \}\)[\s\S]*?\.where\(and\(eq\(claimsTable\.id, claimId\), eq\(claimsTable\.status, "releasing"\)\)\)[\s\S]*?\.returning\(/,
    );
    expect(body).not.toMatch(
      /\.set\(\{ status: "released", updated_at: new Date\(\) \}\)\.where\(eq\(claimsTable\.id, claimId\)\)/,
    );
  });

  it('finalizeSettlement writes no audit row when the CAS affects zero rows', () => {
    const body = fnBody(FINALIZE_START, FINALIZE_END);
    const casIdx = body.indexOf('if (releasedRows.length === 0)');
    // Match the audit INSERT itself (`action: "FINALIZE_SETTLEMENT"`), not the
    // bare action name — the explanatory comment above the CAS names it too.
    const auditIdx = body.indexOf('action: "FINALIZE_SETTLEMENT"');
    expect(casIdx, 'zero-row guard present').toBeGreaterThan(-1);
    expect(auditIdx, 'audit insert present').toBeGreaterThan(-1);
    expect(casIdx, 'the zero-row guard must run before the audit insert').toBeLessThan(auditIdx);
  });
});


