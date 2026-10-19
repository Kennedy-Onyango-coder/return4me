import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../db/database';
import { db as drizzle } from '../db/index';
import { claims as claimsTable, ledger as ledgerTable, audit_log as auditLogTable } from '../db/schema';
import { eq } from 'drizzle-orm';
import {
  proposePayoutRepair,
  confirmPayoutRepair,
  normalizeLedgerEntryId,
  normalizeRepairReason,
  normalizeRepairRequestId,
  PAYOUT_REPAIR_RESULT_CODES,
} from '../services/payoutRepair';
import {
  ADMIN_PERMISSIONS,
  adminHasPermission,
  permissionsForAdminUser,
} from '../services/adminPermissions';
import { PAYOUT_REPAIR_PROPOSAL_TTL_MS } from '../config/payoutRepairPolicy';
import {
  PAYOUT_REFUSAL_EVIDENCE_ACTION,
  PAYOUT_REFUSAL_EVIDENCE_PREFIX,
} from '../config/payoutRepairPolicy';

// =============================================================================
// PHASE 1 — THE REPAIR SERVICE AND ITS DUAL-CONTROL TRANSACTION
// =============================================================================
// These tests run against the repository's real data layer (in-memory database
// double) and the real policy. Nothing is stubbed except the PERMISSION
// resolver, which is granted to no role in production — the seam exists so the
// otherwise-unreachable authorized branch can be exercised at all.
//
// What is asserted is the OUTCOME: the ledger row, the request row and the audit
// rows after each operation. A test that only saw a return code would not prove
// that a refused confirmation wrote nothing.

const RUN = `rpr-${Date.now().toString(36)}`;
let seq = 0;

const PROPOSER = { username: `proposer-${RUN}`, role: 'admin' };
const CONFIRMER = { username: `confirmer-${RUN}`, role: 'admin' };
const REASON = 'Provider statement confirms the transfer was refused before execution.';

/** Grant the repair permissions to the two test administrators only. */
const allowAll = () => true;
const denyAll = () => false;

function refusalEvidenceDetails(params: {
  rowId: string;
  claimId: string;
  batchId: string | null;
  entryType?: string;
  overrides?: Record<string, unknown>;
}): string {
  const role = params.entryType === 'agent_payout' ? 'AGENT' : 'FINDER';
  return (
    PAYOUT_REFUSAL_EVIDENCE_PREFIX +
    JSON.stringify({
      version: 1,
      ledger_entry_id: params.rowId,
      provider: 'intasend',
      provider_batch_id: params.batchId,
      provider_transaction_id: null,
      idempotency_key: `PAYOUT_LEG_${role}:${params.claimId}`,
      idempotency_key_disposition: 'released',
      non_execution_reference: `INTASEND-REFUSAL-${params.rowId}`,
      recorded_by: 'reconciliation-operator',
      recorded_at: '2026-05-01T08:00:00.000Z',
      ...(params.overrides ?? {}),
    })
  );
}

async function seedClaim(
  status = 'pending_settlement',
  options: { withEvidence?: boolean; evidenceOverrides?: Record<string, unknown> } = {},
): Promise<{ claimId: string; rowId: string; batchId: string }> {
  seq += 1;
  const claimId = `CLM-${RUN}-${seq}`;
  const rowId = `LED-${RUN}-${seq}`;
  const batchId = `BATCH-${RUN}-${seq}`;
  await drizzle.insert(claimsTable).values({
    id: claimId,
    owner_phone: '+254700000001',
    security_answers: {},
    status,
  } as any);
  await drizzle.insert(ledgerTable).values({
    id: rowId,
    claim_id: claimId,
    item_id: null,
    type: 'finder_payout',
    amount: '100.00',
    phone_or_till: '+254712345678',
    status: 'failed',
    payout_outcome: 'rejected',
    provider_batch_id: batchId,
    provider_transaction_id: null,
    failure_reason: 'IntaSend refused this transaction (provider rejection - the transfer was not executed).',
  } as any);
  if (options.withEvidence !== false) {
    await db.logAudit(
      'SYSTEM',
      PAYOUT_REFUSAL_EVIDENCE_ACTION,
      refusalEvidenceDetails({
        rowId,
        claimId,
        batchId,
        overrides: options.evidenceOverrides,
      }),
    );
  }
  return { claimId, rowId, batchId };
}

async function readRow(rowId: string): Promise<any> {
  const result: any[] = await drizzle.select().from(ledgerTable);
  return result.find((r) => r.id === rowId);
}

async function readAudit(action: string): Promise<any[]> {
  const rows: any[] = await drizzle.select().from(auditLogTable);
  return rows.filter((r) => r.action === action);
}

async function readRequest(requestId: string): Promise<any> {
  return db.getPayoutRepairRequestById(requestId);
}

const cleanupIds: string[] = [];
afterEach(() => {
  // Nothing to roll back in the in-memory double; unique ids per test keep rows
  // isolated, and this list documents what was created.
  cleanupIds.length = 0;
});

describe('payout repair permissions are granted to NO role by default', () => {
  it('defines both permissions but grants them to no role', () => {
    expect(ADMIN_PERMISSIONS.CLAIMS_PAYOUT_REPAIR_PROPOSE).toBe('claims.payout_repair_propose');
    expect(ADMIN_PERMISSIONS.CLAIMS_PAYOUT_REPAIR_CONFIRM).toBe('claims.payout_repair_confirm');

    for (const role of ['admin', 'owner', 'agent', 'customer', 'admin_pending_2fa', '', 'superadmin']) {
      const user = { role, username: 'someone' };
      const granted = permissionsForAdminUser(user);
      expect(granted).not.toContain(ADMIN_PERMISSIONS.CLAIMS_PAYOUT_REPAIR_PROPOSE);
      expect(granted).not.toContain(ADMIN_PERMISSIONS.CLAIMS_PAYOUT_REPAIR_CONFIRM);
      expect(adminHasPermission(user, ADMIN_PERMISSIONS.CLAIMS_PAYOUT_REPAIR_PROPOSE)).toBe(false);
      expect(adminHasPermission(user, ADMIN_PERMISSIONS.CLAIMS_PAYOUT_REPAIR_CONFIRM)).toBe(false);
    }
    // The pre-existing grants are untouched: this phase adds and removes nothing.
    expect(permissionsForAdminUser({ role: 'admin' })).toContain(
      ADMIN_PERMISSIONS.CLAIMS_SETTLEMENT_INITIATE,
    );
  });

  it('refuses a proposal by an admin who does not hold the permission (the production default)', async () => {
    const { rowId } = await seedClaim();
    const result = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: denyAll },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.FORBIDDEN);
    expect(await db.getOpenPayoutRepairRequestForLedger(rowId)).toBeNull();
  });

  it('refuses a non-admin role even if the permission resolver says yes', async () => {
    const { rowId } = await seedClaim();
    const result = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: { username: 'someone', role: 'agent' } },
      { hasPermission: allowAll },
    );
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.FORBIDDEN);
  });

  it('refuses confirmation without the confirm permission, and does not touch the proposal', async () => {
    const { rowId } = await seedClaim();
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    expect(proposed.ok).toBe(true);

    const result = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: CONFIRMER },
      { hasPermission: denyAll },
    );
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.FORBIDDEN);
    expect((await readRequest(proposed.requestId!)).status).toBe('proposed');
    expect((await readRow(rowId)).status).toBe('failed');
  });
});

describe('payout repair — proposal', () => {
  it('records an eligible proposal and its audit row without touching the ledger', async () => {
    const { rowId } = await seedClaim();
    const before = await readRow(rowId);
    const auditBefore = (await readAudit('PAYOUT_REPAIR_PROPOSED')).length;

    const now = new Date('2026-05-01T09:00:00.000Z');
    const result = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll, now: () => now },
    );

    expect(result.ok).toBe(true);
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.PROPOSED);
    expect(result.requestId).toMatch(/^RPR-[A-F0-9]{20}$/);
    // D3 — 24 hours exactly.
    expect(new Date(result.expiresAt!).getTime() - now.getTime()).toBe(PAYOUT_REPAIR_PROPOSAL_TTL_MS);

    const request = await readRequest(result.requestId!);
    expect(request).toBeTruthy();
    expect(request.status).toBe('proposed');
    expect(request.ledger_entry_id).toBe(rowId);
    expect(request.repair_operation).toBe('release_rejected_leg');
    expect(request.from_status).toBe('failed');
    expect(request.from_payout_outcome).toBe('rejected');
    expect(request.to_status).toBe('pending');
    expect(request.to_payout_outcome).toBe('not_submitted');
    expect(request.proposed_by).toBe(PROPOSER.username);
    expect(request.confirmed_by ?? null).toBeNull();
    expect(request.row_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(request.request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    // The stored evidence digest is PII-free: no full phone number.
    expect(String(request.evidence_json)).not.toContain('712345678');
    expect(String(request.evidence_json)).toContain('destinationMasked');

    // The LEDGER is untouched by a proposal.
    const after = await readRow(rowId);
    expect(after.status).toBe(before.status);
    expect(after.payout_outcome).toBe(before.payout_outcome);
    expect(after.failure_reason).toBe(before.failure_reason);

    // …and the proposal is audited, by the proposer, naming the row.
    const proposedAudit = await readAudit('PAYOUT_REPAIR_PROPOSED');
    expect(proposedAudit.length).toBe(auditBefore + 1);
    const mine = proposedAudit[proposedAudit.length - 1];
    expect(mine.admin_user).toBe(PROPOSER.username);
    expect(String(mine.details)).toContain(rowId);
    expect(String(mine.details)).toContain(result.requestId!);
    expect(String(mine.details)).not.toContain('712345678');
  });

  it('REFUSES a legacy failed row with a NULL outcome and writes nothing', async () => {
    const { rowId } = await seedClaim();
    await drizzle.update(ledgerTable).set({ payout_outcome: null } as any).where(eq(ledgerTable.id, rowId));

    const result = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.INELIGIBLE);
    expect(result.eligibility?.blockingCodes).toContain('submission_history_missing');
    expect(await db.getOpenPayoutRepairRequestForLedger(rowId)).toBeNull();
  });

  it('rejects malformed input before any database access', async () => {
    const seen: string[] = [];
    const spy = {
      getPayoutRepairEvidence: async (id: string) => {
        seen.push(id);
        return { ledgerEntry: null, claim: null, claimLedger: [], auditEntries: [] };
      },
      getPayoutRepairRequestById: async () => null,
      createPayoutRepairRequest: async () => ({ ok: false, code: 'SHOULD_NOT_RUN' }),
      confirmPayoutRepairRequest: async () => ({ ok: false, code: 'SHOULD_NOT_RUN' }),
    } as any;

    const bad1 = await proposePayoutRepair(
      { ledgerEntryId: "LED-1' OR 1=1", reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll, database: spy },
    );
    expect(bad1.code).toBe(PAYOUT_REPAIR_RESULT_CODES.INVALID_LEDGER_ENTRY_ID);

    const bad2 = await proposePayoutRepair(
      { ledgerEntryId: 'LED-1', reason: 'short', actor: PROPOSER },
      { hasPermission: allowAll, database: spy },
    );
    expect(bad2.code).toBe(PAYOUT_REPAIR_RESULT_CODES.INVALID_REASON);

    expect(seen).toEqual([]);
    expect(normalizeLedgerEntryId(' LED-1 ')).toBe('LED-1');
    expect(normalizeLedgerEntryId('a b')).toBeNull();
    expect(normalizeRepairReason('x'.repeat(1001))).toBeNull();
    expect(normalizeRepairRequestId('RPR-ABC123')).toBe('RPR-ABC123');
    expect(normalizeRepairRequestId('LED-ABC123')).toBeNull();
  });

  it('rejects a second open proposal for the same row', async () => {
    const { rowId } = await seedClaim();
    const first = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    expect(first.ok).toBe(true);

    const second = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    expect(second.ok).toBe(false);
    expect(second.code).toBe(PAYOUT_REPAIR_RESULT_CODES.DUPLICATE_OPEN_REQUEST);
  });
});

describe('payout repair — dual-controlled confirmation', () => {
  it('a DIFFERENT administrator confirms: one ledger transition, one audit row, one confirmation', async () => {
    const { rowId, claimId } = await seedClaim();
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    expect(proposed.ok).toBe(true);

    const confirmedAt = new Date('2026-05-01T10:00:00.000Z');
    const result = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: CONFIRMER },
      { hasPermission: allowAll, now: () => confirmedAt },
    );

    expect(result.ok).toBe(true);
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.CONFIRMED);
    expect(result.confirmedBy).toBe(CONFIRMER.username);

    // THE ledger row: exactly the canonical never-submitted state, and nothing else.
    const row = await readRow(rowId);
    expect(row.status).toBe('pending');
    expect(row.payout_outcome).toBe('not_submitted');
    expect(row.claim_id).toBe(claimId);
    expect(String(row.failure_reason)).toContain(proposed.requestId);
    // The provider identity is preserved (destroying it would erase evidence).
    expect(row.provider_batch_id).toBeTruthy();

    // THE request row records WHO confirmed and WHEN.
    const request = await readRequest(proposed.requestId!);
    expect(request.status).toBe('confirmed');
    expect(request.confirmed_by).toBe(CONFIRMER.username);
    expect(request.confirmed_at).toBeTruthy();
    expect(request.outcome).toBe('applied');

    // THE audit row: attributable, names both administrators and the row,
    // and contains no full destination.
    const confirmedAudit = (await readAudit('PAYOUT_REPAIR_CONFIRMED')).filter((a) =>
      String(a.details).includes(proposed.requestId!),
    );
    expect(confirmedAudit).toHaveLength(1);
    expect(confirmedAudit[0].admin_user).toBe(CONFIRMER.username);
    expect(String(confirmedAudit[0].details)).toContain(rowId);
    expect(String(confirmedAudit[0].details)).toContain(PROPOSER.username);
    expect(String(confirmedAudit[0].details)).not.toContain('712345678');
  });

  it('REFUSES self-confirmation and leaves the proposal open', async () => {
    const { rowId } = await seedClaim();
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );

    const result = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.SELF_CONFIRMATION_FORBIDDEN);

    expect((await readRequest(proposed.requestId!)).status).toBe('proposed');
    expect((await readRow(rowId)).status).toBe('failed');
  });

  it('REFUSES a replay of a confirmed request (no second repair)', async () => {
    const { rowId } = await seedClaim();
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    const first = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: CONFIRMER },
      { hasPermission: allowAll },
    );
    expect(first.ok).toBe(true);

    const rowAfterFirst = await readRow(rowId);
    const second = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: CONFIRMER },
      { hasPermission: allowAll },
    );
    expect(second.ok).toBe(false);
    expect(second.code).toBe(PAYOUT_REPAIR_RESULT_CODES.ALREADY_CONFIRMED);

    const rowAfterSecond = await readRow(rowId);
    expect(rowAfterSecond.status).toBe(rowAfterFirst.status);
    expect(rowAfterSecond.payout_outcome).toBe(rowAfterFirst.payout_outcome);
    expect(rowAfterSecond.failure_reason).toBe(rowAfterFirst.failure_reason);
    // Exactly one confirmation audit row exists for this request.
    const confirmedAudit = (await readAudit('PAYOUT_REPAIR_CONFIRMED')).filter((a) =>
      String(a.details).includes(proposed.requestId!),
    );
    expect(confirmedAudit).toHaveLength(1);
  });

  it('concurrent confirmations cannot apply the repair twice', async () => {
    const { rowId } = await seedClaim();
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );

    const results = await Promise.all([
      confirmPayoutRepair({ requestId: proposed.requestId, actor: CONFIRMER }, { hasPermission: allowAll }),
      confirmPayoutRepair({ requestId: proposed.requestId, actor: CONFIRMER }, { hasPermission: allowAll }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(
      results.find((r) => !r.ok)?.code === PAYOUT_REPAIR_RESULT_CODES.ALREADY_CONFIRMED ||
        results.find((r) => !r.ok)?.code === PAYOUT_REPAIR_RESULT_CODES.WRITE_FAILED,
    ).toBe(true);

    const confirmedAudit = (await readAudit('PAYOUT_REPAIR_CONFIRMED')).filter((a) =>
      String(a.details).includes(proposed.requestId!),
    );
    expect(confirmedAudit).toHaveLength(1);
    expect((await readRow(rowId)).status).toBe('pending');
  });
});

describe('payout repair — expiry, revalidation, staleness and audit failure', () => {
  it('REFUSES a proposal older than 24 hours, marks it expired, and never touches the ledger', async () => {
    const { rowId } = await seedClaim();
    const proposedAt = new Date('2026-05-01T09:00:00.000Z');
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll, now: () => proposedAt },
    );

    const justTooLate = new Date(proposedAt.getTime() + PAYOUT_REPAIR_PROPOSAL_TTL_MS + 1);
    const result = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: CONFIRMER },
      { hasPermission: allowAll, now: () => justTooLate },
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.EXPIRED);
    expect((await readRequest(proposed.requestId!)).status).toBe('expired');
    expect((await readRow(rowId)).status).toBe('failed');
    expect((await readRow(rowId)).payout_outcome).toBe('rejected');
    expect(
      (await readAudit('PAYOUT_REPAIR_EXPIRED')).filter((a) =>
        String(a.details).includes(proposed.requestId!),
      ),
    ).toHaveLength(1);
  });

  it('still works one second inside the window (the boundary is enforced, not approximated)', async () => {
    const { rowId } = await seedClaim();
    const proposedAt = new Date('2026-05-01T09:00:00.000Z');
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll, now: () => proposedAt },
    );
    const result = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: CONFIRMER },
      {
        hasPermission: allowAll,
        now: () => new Date(proposedAt.getTime() + PAYOUT_REPAIR_PROPOSAL_TTL_MS - 1000),
      },
    );
    expect(result.ok).toBe(true);
  });

  it('REVALIDATES eligibility at confirmation (a claim that moved on cannot be repaired)', async () => {
    const { rowId, claimId } = await seedClaim();
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    await drizzle.update(claimsTable).set({ status: 'released' } as any).where(eq(claimsTable.id, claimId));

    const result = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: CONFIRMER },
      { hasPermission: allowAll },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.INELIGIBLE);
    expect(result.eligibility?.blockingCodes).toContain('claim_state_not_repairable');
    expect((await readRow(rowId)).status).toBe('failed');
    expect((await readRequest(proposed.requestId!)).status).toBe('proposed');
  });

  it('REJECTS a proposal whose target row changed after review (stale state)', async () => {
    const { rowId } = await seedClaim();
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    // New evidence arrives: the reviewed proposition is no longer the row.
    await drizzle
      .update(ledgerTable)
      .set({ failure_reason: 'A later provider callback reported a different outcome.' } as any)
      .where(eq(ledgerTable.id, rowId));

    const result = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: CONFIRMER },
      { hasPermission: allowAll },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.STALE_TARGET_STATE);
    const row = await readRow(rowId);
    expect(row.status).toBe('failed');
    expect(row.payout_outcome).toBe('rejected');
    // The refusal is itself audited.
    expect(
      (await readAudit('PAYOUT_REPAIR_REFUSED')).filter((a) =>
        String(a.details).includes(proposed.requestId!),
      ),
    ).toHaveLength(1);
  });

  it('an audit-write failure aborts BEFORE the ledger is repaired (no unaudited repair survives)', async () => {
    const { rowId } = await seedClaim();
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );

    const proto = Object.getPrototypeOf(db);
    const spy = vi.spyOn(proto, 'logAuditInTx').mockRejectedValueOnce(new Error('audit storage unavailable'));
    let result: any;
    try {
      result = await confirmPayoutRepair(
        { requestId: proposed.requestId, actor: CONFIRMER },
        { hasPermission: allowAll },
      );
    } finally {
      spy.mockRestore();
    }

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.WRITE_FAILED);
    // The money row is untouched — the audit write happens FIRST, so a failure
    // there cannot leave a repaired row behind. (The in-memory double models no
    // rollback, which is why the ORDERING — not the rollback — is what this
    // asserts; in PostgreSQL the same throw rolls the whole transaction back.)
    const row = await readRow(rowId);
    expect(row.status).toBe('failed');
    expect(row.payout_outcome).toBe('rejected');
  });

  it('REFUSES a second proposal after a confirmed repair (the row is no longer repairable)', async () => {
    const { rowId } = await seedClaim();
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    await confirmPayoutRepair({ requestId: proposed.requestId, actor: CONFIRMER }, { hasPermission: allowAll });

    const again = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    expect(again.ok).toBe(false);
    expect(again.code).toBe(PAYOUT_REPAIR_RESULT_CODES.INELIGIBLE);
    expect(again.eligibility?.blockingCodes).toContain('nothing_to_repair');
  });

  it('returns NOT_FOUND for an unknown request id', async () => {
    const result = await confirmPayoutRepair(
      { requestId: 'RPR-DOESNOTEXIST', actor: CONFIRMER },
      { hasPermission: allowAll },
    );
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.NOT_FOUND);
  });
});

describe('payout repair — refusal provenance, batch evidence and key state', () => {
  it('REFUSES a rejected row with NO imported evidence and writes nothing', async () => {
    const { rowId } = await seedClaim('pending_settlement', { withEvidence: false });
    const result = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.INELIGIBLE);
    expect(result.eligibility?.blockingCodes).toContain('refusal_provenance_unverified');
    expect(await db.getOpenPayoutRepairRequestForLedger(rowId)).toBeNull();
  });

  it('REFUSES evidence that names a DIFFERENT idempotency key', async () => {
    const { rowId } = await seedClaim('pending_settlement', {
      evidenceOverrides: { idempotency_key: 'PAYOUT_LEG_AGENT:CLM-OTHER' },
    });
    const result = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.INELIGIBLE);
    expect(result.eligibility?.blockingCodes).toContain('refusal_evidence_conflicting');
  });

  it('REFUSES an unrecognised idempotency-key disposition (F7 stays unresolved)', async () => {
    const { rowId } = await seedClaim('pending_settlement', {
      evidenceOverrides: { idempotency_key_disposition: 'unknown' },
    });
    const result = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.INELIGIBLE);
    expect(result.eligibility?.blockingCodes).toContain('idempotency_key_state_unverified');
  });

  it('REFUSES a row whose batch has a provider-verification UNMATCHED event', async () => {
    const { rowId, batchId } = await seedClaim();
    await db.logAudit(
      'SYSTEM',
      'PAYOUT_VERIFICATION_UNMATCHED',
      `Payout batch ${batchId}: provider reported transaction TXN-X completed, but it does not match exactly ONE local payout leg.`,
    );
    const result = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.INELIGIBLE);
    expect(result.eligibility?.blockingCodes).toContain('audit_evidence_ambiguous');
    expect(result.eligibility?.evidence.batchScopedAuditEvidenceCount).toBeGreaterThan(0);
  });

  it('DOES propose when the evidence contract is satisfied', async () => {
    const { rowId } = await seedClaim();
    const result = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    expect(result.ok).toBe(true);
    expect(result.eligibility?.evidence.refusalEvidenceValid).toBe(true);
  });
});


describe('payout repair — expiry lifecycle (F3) and preserved failure evidence (F4)', () => {
  it('the PROPOSER may drive an expired request to `expired` (expiry is checked first)', async () => {
    const { rowId } = await seedClaim();
    const proposedAt = new Date('2026-05-01T09:00:00.000Z');
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll, now: () => proposedAt },
    );
    const tooLate = new Date(proposedAt.getTime() + PAYOUT_REPAIR_PROPOSAL_TTL_MS + 1);
    const result = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: PROPOSER },
      { hasPermission: allowAll, now: () => tooLate },
    );
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.EXPIRED);
    expect((await readRequest(proposed.requestId!)).status).toBe('expired');
    expect((await readRow(rowId)).status).toBe('failed');
  });

  it('a repeated confirmation writes NO second expiry audit row', async () => {
    const { rowId } = await seedClaim();
    const proposedAt = new Date('2026-05-01T09:00:00.000Z');
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll, now: () => proposedAt },
    );
    const tooLate = new Date(proposedAt.getTime() + PAYOUT_REPAIR_PROPOSAL_TTL_MS + 1);
    await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: CONFIRMER },
      { hasPermission: allowAll, now: () => tooLate },
    );
    const second = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: CONFIRMER },
      { hasPermission: allowAll, now: () => tooLate },
    );
    expect(second.code).toBe(PAYOUT_REPAIR_RESULT_CODES.EXPIRED);
    expect(
      (await readAudit('PAYOUT_REPAIR_EXPIRED')).filter((a) =>
        String(a.details).includes(proposed.requestId!),
      ),
    ).toHaveLength(1);
  });

  it('two concurrent confirmations of an expired request produce ONE expiry audit row', async () => {
    const { rowId } = await seedClaim();
    const proposedAt = new Date('2026-05-01T09:00:00.000Z');
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll, now: () => proposedAt },
    );
    const tooLate = new Date(proposedAt.getTime() + PAYOUT_REPAIR_PROPOSAL_TTL_MS + 1);
    const results = await Promise.all([
      confirmPayoutRepair(
        { requestId: proposed.requestId, actor: CONFIRMER },
        { hasPermission: allowAll, now: () => tooLate },
      ),
      confirmPayoutRepair(
        { requestId: proposed.requestId, actor: CONFIRMER },
        { hasPermission: allowAll, now: () => tooLate },
      ),
    ]);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(
      (await readAudit('PAYOUT_REPAIR_EXPIRED')).filter((a) =>
        String(a.details).includes(proposed.requestId!),
      ),
    ).toHaveLength(1);
    expect((await readRow(rowId)).status).toBe('failed');
  });

  it('an expired proposal no longer blocks a replacement proposal', async () => {
    const { rowId } = await seedClaim();
    const proposedAt = new Date('2026-05-01T09:00:00.000Z');
    const first = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll, now: () => proposedAt },
    );
    expect(first.ok).toBe(true);

    const later = new Date(proposedAt.getTime() + PAYOUT_REPAIR_PROPOSAL_TTL_MS + 1);
    const second = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll, now: () => later },
    );
    expect(second.ok).toBe(true);
    expect(second.requestId).not.toBe(first.requestId);
    expect((await readRequest(first.requestId!)).status).toBe('expired');
    expect((await readRequest(second.requestId!)).status).toBe('proposed');
    expect(
      (await readAudit('PAYOUT_REPAIR_EXPIRED')).filter((a) =>
        String(a.details).includes(first.requestId!),
      ),
    ).toHaveLength(1);
  });

  it('preserves the original failure reason on the row and in the audit (F4)', async () => {
    const { rowId } = await seedClaim();
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    const result = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: CONFIRMER },
      { hasPermission: allowAll },
    );
    expect(result.ok).toBe(true);

    const row = await readRow(rowId);
    expect(row.failure_reason).toContain('IntaSend refused this transaction');
    expect(row.failure_reason).toContain(`Released to unsubmitted by audited payout repair ${proposed.requestId}`);

    const confirmedAudit = (await readAudit('PAYOUT_REPAIR_CONFIRMED')).filter((a) =>
      String(a.details).includes(proposed.requestId!),
    );
    expect(confirmedAudit).toHaveLength(1);
    expect(String(confirmedAudit[0].details)).toContain('Pre-repair evidence preserved');
    expect(String(confirmedAudit[0].details)).toContain('IntaSend refused this transaction');
    expect(String(confirmedAudit[0].details)).not.toContain('712345678');
  });

  it('a destination change after the proposal invalidates it (F5)', async () => {
    const { rowId } = await seedClaim();
    const proposed = await proposePayoutRepair(
      { ledgerEntryId: rowId, reason: REASON, actor: PROPOSER },
      { hasPermission: allowAll },
    );
    await drizzle
      .update(ledgerTable)
      .set({ phone_or_till: '+254799999999' } as any)
      .where(eq(ledgerTable.id, rowId));

    const result = await confirmPayoutRepair(
      { requestId: proposed.requestId, actor: CONFIRMER },
      { hasPermission: allowAll },
    );
    expect(result.code).toBe(PAYOUT_REPAIR_RESULT_CODES.STALE_TARGET_STATE);
    expect((await readRow(rowId)).status).toBe('failed');
  });
});
