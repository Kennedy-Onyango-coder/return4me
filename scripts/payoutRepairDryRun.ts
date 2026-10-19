#!/usr/bin/env node
// PAYOUT REPAIR DRY RUN (Phase 1 — payout readiness)
//
// =============================================================================
// THIS SCRIPT IS AN INVESTIGATION TOOL. IT IS NOT AN EXECUTION TOOL.
// =============================================================================
// It answers ONE question, per payout leg: "does the evidence in this database
// support an audited repair, and if not, exactly which conditions block it?"
//
// It CANNOT, by construction:
//   * write anything — every data statement it issues is a single SELECT, and
//     each one is checked by assertReadOnlyStatement() at the moment it is run
//     (not merely by convention: this file exports the guard, and the test suite
//     asserts both that the guard rejects `UPDATE ledger` and that every query
//     this script defines passes it);
//   * create a repair request, an audit row, or a ledger change;
//   * call IntaSend, PaymentService, or any payout submission function — it
//     imports no service and no provider client, only the pure policy module;
//   * print a phone number, a full wallet identifier, an amount or a free-text
//     provider statement. Destinations are masked and amounts are reported only
//     as "present"/"absent".
//
// On a real connection it also opens a READ ONLY transaction and ends it with
// ROLLBACK. That is defence in depth for the one statement it issues that is not
// a SELECT ("BEGIN TRANSACTION READ ONLY"), which cannot change data on its own.
//
// HOW TO RUN (LOCAL / NON-PRODUCTION ONLY, IN THIS PHASE)
// ------------------------------------------------------
//   $env:DATABASE_URL = '<local or staging connection string>'
//   $env:PAYOUT_REPAIR_DRY_RUN_TARGET = 'local-or-staging'
//   node .\node_modules\tsx\dist\cli.mjs scripts/payoutRepairDryRun.ts [LEDGER_ROW_ID ...]
//
// With no arguments it inspects the bounded set of `failed` payout legs (the
// class that includes the four legacy rows from the handoff, among them
// CLM-328944 and CLM-792723). With arguments it inspects exactly those rows.
//
// Exit codes:
//   0  every inspected row is ELIGIBLE (nothing blocked, nothing missing)
//   1  at least one row is BLOCKED, missing, or the evidence is insufficient
//   2  the script refused to run (no/unsafe database target, bad arguments)
//   3  the database could not be queried at all
//
// REVIEWED PRODUCTION PROCEDURE (a FUTURE, separately authorized phase)
// ---------------------------------------------------------------------
// Not performed here, and not to be improvised later: production execution
// requires (1) an owner-approved maintenance window and read replica or
// read-only role, (2) `PAYOUT_REPAIR_DRY_RUN_TARGET` set to the approved target
// name by the operator running it, (3) the output captured verbatim into the
// review log, and (4) an independent reviewer comparing every BLOCKED row's
// blocking codes against the provider statement before any proposal exists.
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import {
  evaluatePayoutRepairEligibility,
  maskLedgerDestination,
  PAYOUT_REPAIR_EVIDENCE_AUDIT_ACTIONS,
  type PayoutRepairEvidence,
  type PayoutRepairLedgerSnapshot,
} from '../src/config/payoutRepairPolicy.ts';

// ---------------------------------------------------------------------------
// THE READ-ONLY GUARD
// ---------------------------------------------------------------------------
// Deliberately conservative: an allow-list of statement FORMS plus a deny-list
// of keywords. A statement that is not obviously safe is refused, and the
// refusal names the reason — the script must never "try it and see".
const FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|REFRESH|COMMENT|LOCK|CALL|DO|EXECUTE|PREPARE|DEALLOCATE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|ANALYZE|DISCARD|LISTEN|NOTIFY|INTO)\b/i;

export class ReadOnlyViolationError extends Error {
  constructor(message: string) {
    super(`Refused to run a non-read-only statement: ${message}`);
    this.name = 'ReadOnlyViolationError';
  }
}

/**
 * Throw unless `sql` is exactly one read-only statement.
 *
 * This is the enforceable form of the repository's "SELECT-only" convention for
 * this tool, and the regression test for `UPDATE ledger` calls it directly.
 */
export function assertReadOnlyStatement(sql: unknown): string {
  if (typeof sql !== 'string') throw new ReadOnlyViolationError('statement is not a string');
  const trimmed = sql.trim();
  if (trimmed === '') throw new ReadOnlyViolationError('statement is empty');

  // Exactly one statement. A semicolon anywhere but the very end means the
  // caller is trying to smuggle a second statement past the allow-list.
  const withoutTrailing = trimmed.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new ReadOnlyViolationError('multiple statements are not allowed');
  }

  if (!/^(SELECT|WITH)\b/i.test(withoutTrailing)) {
    throw new ReadOnlyViolationError('only SELECT (or WITH ... SELECT) is permitted');
  }
  if (/^WITH\b/i.test(withoutTrailing) && !/\bSELECT\b/i.test(withoutTrailing)) {
    throw new ReadOnlyViolationError('a WITH statement must end in a SELECT');
  }

  const forbidden = withoutTrailing.match(FORBIDDEN_KEYWORDS);
  if (forbidden) {
    throw new ReadOnlyViolationError(`statement contains the keyword '${forbidden[0]}'`);
  }
  return withoutTrailing;
}

/** The only non-SELECT statement this script may issue, and only to a real connection. */
export const READ_ONLY_SESSION_BEGIN = 'BEGIN TRANSACTION READ ONLY';
export const READ_ONLY_SESSION_END = 'ROLLBACK';

// ---------------------------------------------------------------------------
// THE QUERIES (every one of them is a single SELECT)
// ---------------------------------------------------------------------------
// Exported so the test can prove two things about the REAL query path rather
// than about a disconnected string: each statement passes assertReadOnlyStatement()
// AND none of them contains a mutating keyword.

const LEDGER_COLUMNS = [
  'id',
  'claim_id',
  'item_id',
  'type',
  'amount',
  'phone_or_till',
  'status',
  'payout_outcome',
  'provider_batch_id',
  'provider_transaction_id',
  'failure_reason',
  'created_at',
].join(', ');

export const DRY_RUN_QUERIES = {
  /** The target payout leg, by primary key. */
  LEDGER_ROW: `SELECT ${LEDGER_COLUMNS} FROM ledger WHERE id = $1`,
  /** The claim the leg belongs to (status is part of the decision). */
  CLAIM: 'SELECT id, status FROM claims WHERE id = $1',
  /** Every ledger row for the claim: the sibling legs the rule compares against. */
  CLAIM_LEDGER: `SELECT ${LEDGER_COLUMNS} FROM ledger WHERE claim_id = $1`,
  /**
   * Audit rows that can contradict a clean provider refusal, or show a previous
   * repair. `details LIKE $2` is a coarse pre-filter only; the policy re-checks
   * the id with a word-boundary match.
   */
  AUDIT_EVIDENCE:
    'SELECT id, action, details FROM audit_log WHERE details LIKE $1 OR action = ANY($2)',
  /**
   * The bounded candidate set: payout legs recorded as `failed`. This is the
   * class the handoff's four legacy rows belong to; the report distinguishes
   * "no submission record found" (payout_outcome NULL) from any positive
   * evidence, and never treats the former as safe to repair.
   */
  FAILED_PAYOUT_CANDIDATES: `SELECT ${LEDGER_COLUMNS} FROM ledger WHERE type IN ('finder_payout', 'agent_payout') AND status = $1 ORDER BY created_at ASC, id ASC LIMIT $2`,
} as const;

/** Validate every query in the map. Throws on the first violation. */
export function assertAllQueriesReadOnly(): void {
  for (const [name, sql] of Object.entries(DRY_RUN_QUERIES)) {
    try {
      assertReadOnlyStatement(sql);
    } catch (error: any) {
      throw new ReadOnlyViolationError(`${name}: ${error?.message ?? error}`);
    }
  }
}

/** A query function: `pg`'s Pool#query satisfies this shape, and so does a test double. */
export type DryRunQueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

export interface PayoutRepairDryRunReport {
  ledgerEntryId: string;
  found: boolean;
  claimId: string | null;
  entryType: string | null;
  status: string | null;
  payoutOutcome: string | null;
  /** Masked. Never the full destination. */
  destinationMasked: string | null;
  amountPresent: boolean;
  classification: 'ELIGIBLE' | 'BLOCKED';
  blockingCodes: string[];
  blockingReasons: string[];
  evidenceSummary: {
    claimStatus: string | null;
    providerBatchRefPresent: boolean;
    providerTransactionRefPresent: boolean;
    failureReasonPresent: boolean;
    siblingLegCount: number;
    siblingCompletedCount: number;
    ambiguousAuditEvidenceCount: number;
    priorRepairEvidenceCount: number;
    refusalEvidenceCount: number;
    refusalEvidenceValid: boolean;
    batchScopedAuditEvidenceCount: number;
    unlinkableBatchAuditEvidenceCount: number;
  };
  /** Plain-language reading of the submission-history question, never a verdict of "safe". */
  submissionHistoryReading: string;
}

export interface PayoutRepairDryRunResult {
  target: 'explicit-ids' | 'failed-payout-candidates';
  inspected: number;
  eligible: number;
  blocked: number;
  missing: number;
  rows: PayoutRepairDryRunReport[];
  exitCode: number;
}

// ---------------------------------------------------------------------------
// CLASSIFICATION
// ---------------------------------------------------------------------------

function toSnapshot(row: any): PayoutRepairLedgerSnapshot {
  return {
    id: row.id,
    claim_id: row.claim_id ?? null,
    item_id: row.item_id ?? null,
    type: row.type,
    amount: row.amount ?? null,
    phone_or_till: row.phone_or_till ?? null,
    status: row.status ?? null,
    payout_outcome: row.payout_outcome ?? null,
    provider_batch_id: row.provider_batch_id ?? null,
    provider_transaction_id: row.provider_transaction_id ?? null,
    failure_reason: row.failure_reason ?? null,
    created_at: row.created_at ?? null,
  };
}

/** Run one SELECT through the guard, so the guard cannot be bypassed by accident. */
async function sanctionedQuery(query: DryRunQueryFn, sql: string, params: any[]): Promise<any[]> {
  assertReadOnlyStatement(sql);
  const result = await query(sql, params);
  return Array.isArray(result?.rows) ? result.rows : [];
}

/**
 * Read the evidence for ONE ledger row and classify it.
 *
 * A row that cannot be read at all is reported as BLOCKED (never "probably
 * fine"), with the specific reason. There is no code path that returns ELIGIBLE
 * without the pure policy function agreeing.
 */
export async function classifyPayoutLeg(
  query: DryRunQueryFn,
  ledgerEntryId: string,
): Promise<PayoutRepairDryRunReport> {
  const emptyEvidence: PayoutRepairEvidence = {
    ledgerEntry: null,
    claim: null,
    claimLedger: [],
    auditEntries: [],
  };

  const ledgerRows = await sanctionedQuery(query, DRY_RUN_QUERIES.LEDGER_ROW, [ledgerEntryId]);
  if (ledgerRows.length === 0) {
    const eligibility = evaluatePayoutRepairEligibility(emptyEvidence);
    return {
      ledgerEntryId,
      found: false,
      claimId: null,
      entryType: null,
      status: null,
      payoutOutcome: null,
      destinationMasked: null,
      amountPresent: false,
      classification: 'BLOCKED',
      blockingCodes: eligibility.blockingCodes,
      blockingReasons: eligibility.blockingReasons,
      evidenceSummary: {
        claimStatus: null,
        providerBatchRefPresent: false,
        providerTransactionRefPresent: false,
        failureReasonPresent: false,
        siblingLegCount: 0,
        siblingCompletedCount: 0,
        ambiguousAuditEvidenceCount: 0,
        priorRepairEvidenceCount: 0,
        refusalEvidenceCount: 0,
        refusalEvidenceValid: false,
        batchScopedAuditEvidenceCount: 0,
        unlinkableBatchAuditEvidenceCount: 0,
      },
      submissionHistoryReading: 'The ledger row could not be read; nothing can be concluded.',
    };
  }

  const ledgerEntry = toSnapshot(ledgerRows[0]);
  let claim: { id: string; status: string | null } | null = null;
  let claimLedger: PayoutRepairLedgerSnapshot[] = [ledgerEntry];

  if (ledgerEntry.claim_id) {
    const claimRows = await sanctionedQuery(query, DRY_RUN_QUERIES.CLAIM, [ledgerEntry.claim_id]);
    claim = claimRows[0] ? { id: claimRows[0].id, status: claimRows[0].status ?? null } : null;
    const siblingRows = await sanctionedQuery(query, DRY_RUN_QUERIES.CLAIM_LEDGER, [ledgerEntry.claim_id]);
    claimLedger = siblingRows.map(toSnapshot);
  }

  const auditRows = await sanctionedQuery(query, DRY_RUN_QUERIES.AUDIT_EVIDENCE, [
    `%${ledgerEntry.id}%`,
    [...PAYOUT_REPAIR_EVIDENCE_AUDIT_ACTIONS],
  ]);

  const evidence: PayoutRepairEvidence = {
    ledgerEntry,
    claim,
    claimLedger,
    auditEntries: auditRows.map((a: any) => ({ id: a.id, action: a.action, details: a.details ?? null })),
  };

  const eligibility = evaluatePayoutRepairEligibility(evidence);
  const digest = eligibility.evidence;

  // The submission-history reading is deliberately hedged where the data is
  // silent: "no record found" is a statement about THIS database, never about
  // whether money moved.
  let submissionHistoryReading: string;
  if (!digest.payoutOutcome) {
    submissionHistoryReading =
      'no submission record was found (payout_outcome is NULL). This database cannot show whether a transfer ' +
      'was submitted; it is NOT evidence that none was. Provider reconciliation is required.';
  } else if (digest.payoutOutcome === 'rejected') {
    submissionHistoryReading =
      'the row records a LOCAL refusal-class outcome (rejected). That is NOT proof that no transfer ' +
      'executed: the provider HTTP status is not persisted and duplicate-idempotency, rate-limit, ' +
      'timeout, redirect and 5xx responses are indistinguishable here. Repair additionally requires ' +
      'imported, row-level provider refusal evidence; without it this row is BLOCKED.';
  } else if (digest.payoutOutcome === 'completed') {
    submissionHistoryReading = 'the row records a completed transfer.';
  } else if (digest.payoutOutcome === 'not_submitted') {
    submissionHistoryReading = 'the row positively records that it was never submitted.';
  } else {
    submissionHistoryReading =
      `the recorded outcome '${digest.payoutOutcome}' means the transfer may already have moved money.`;
  }

  return {
    ledgerEntryId: ledgerEntry.id,
    found: true,
    claimId: ledgerEntry.claim_id,
    entryType: ledgerEntry.type,
    status: ledgerEntry.status,
    payoutOutcome: ledgerEntry.payout_outcome,
    destinationMasked: maskLedgerDestination(ledgerEntry.phone_or_till),
    amountPresent: digest.amountPresent,
    classification: eligibility.eligible ? 'ELIGIBLE' : 'BLOCKED',
    blockingCodes: eligibility.blockingCodes,
    blockingReasons: eligibility.blockingReasons,
    evidenceSummary: {
      claimStatus: digest.claimStatus,
      providerBatchRefPresent: digest.providerBatchRefPresent,
      providerTransactionRefPresent: digest.providerTransactionRefPresent,
      failureReasonPresent: digest.failureReasonPresent,
      siblingLegCount: digest.siblingLegCount,
      siblingCompletedCount: digest.siblingCompletedCount,
      ambiguousAuditEvidenceCount: digest.ambiguousAuditEvidenceCount,
      priorRepairEvidenceCount: digest.priorRepairEvidenceCount,
      refusalEvidenceCount: digest.refusalEvidenceCount,
      refusalEvidenceValid: digest.refusalEvidenceValid,
      batchScopedAuditEvidenceCount: digest.batchScopedAuditEvidenceCount,
      unlinkableBatchAuditEvidenceCount: digest.unlinkableBatchAuditEvidenceCount,
    },
    submissionHistoryReading,
  };
}

// ---------------------------------------------------------------------------
// THE RUN
// ---------------------------------------------------------------------------

/**
 * Inspect the requested rows (or the bounded `failed` payout candidates) and
 * summarise the classification.
 *
 * READ-ONLY: every statement goes through `sanctionedQuery`, which refuses
 * anything that is not a single SELECT. The runner has no write path at all.
 */
export async function runPayoutRepairDryRun(options: {
  query: DryRunQueryFn;
  ledgerEntryIds?: string[];
  candidateLimit?: number;
}): Promise<PayoutRepairDryRunResult> {
  assertAllQueriesReadOnly();

  const explicitIds = Array.isArray(options.ledgerEntryIds)
    ? Array.from(new Set(options.ledgerEntryIds.map((v) => String(v).trim()).filter(Boolean)))
    : [];

  let targetIds: string[];
  const target: PayoutRepairDryRunResult['target'] = explicitIds.length
    ? 'explicit-ids'
    : 'failed-payout-candidates';

  if (explicitIds.length) {
    targetIds = explicitIds;
  } else {
    const limit = Math.max(1, Math.min(Number(options.candidateLimit) || 200, 1000));
    const rows = await sanctionedQuery(options.query, DRY_RUN_QUERIES.FAILED_PAYOUT_CANDIDATES, [
      'failed',
      limit,
    ]);
    targetIds = rows.map((r: any) => String(r.id));
  }

  const reports: PayoutRepairDryRunReport[] = [];
  for (const id of targetIds) {
    reports.push(await classifyPayoutLeg(options.query, id));
  }

  const eligible = reports.filter((r) => r.classification === 'ELIGIBLE').length;
  const missing = reports.filter((r) => !r.found).length;
  const blocked = reports.length - eligible;

  return {
    target,
    inspected: reports.length,
    eligible,
    blocked,
    missing,
    rows: reports,
    // "Meaningful status": NEVER 0 merely because the script ran. Zero requires
    // that rows were inspected and every one of them is eligible and present.
    exitCode: reports.length > 0 && blocked === 0 && missing === 0 ? 0 : 1,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
// Guard rails, not conveniences. This phase must not touch a production
// database, so the script refuses to start unless the operator has explicitly
// named a non-production target and NODE_ENV is not production.

export function assertSafeDryRunEnvironment(env: NodeJS.ProcessEnv): void {
  const target = (env.PAYOUT_REPAIR_DRY_RUN_TARGET || '').trim().toLowerCase();
  if (!target) {
    throw new Error(
      'PAYOUT_REPAIR_DRY_RUN_TARGET is not set. This tool never guesses its database target; ' +
        'set it to "local-or-staging" for an approved non-production run.',
    );
  }
  if (target === 'production') {
    throw new Error('This phase forbids running the dry run against a production target.');
  }
  if (!['local-or-staging', 'local', 'staging', 'test'].includes(target)) {
    throw new Error(`Unrecognised PAYOUT_REPAIR_DRY_RUN_TARGET '${target}'.`);
  }
  if ((env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('NODE_ENV=production: the dry run refuses to start in this phase.');
  }
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set.');
  }
}

async function main(argv: string[]): Promise<void> {
  try {
    assertSafeDryRunEnvironment(process.env);
  } catch (error: any) {
    console.error(`[payout-repair-dry-run] REFUSED: ${error?.message ?? error}`);
    process.exitCode = 2;
    return;
  }

  const requestedIds = argv.length > 0 ? argv : [];
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    application_name: 'r4m-payout-repair-dry-run',
    statement_timeout: 15_000,
    // A read-only transaction is defence in depth; the operator role should also
    // lack write grants, which is what the production procedure requires.
  });

  let client: any = null;
  try {
    client = await pool.connect();
    // The ONLY non-SELECT statement in this file, issued on a real connection
    // only. It cannot change data, and it is always ended with ROLLBACK.
    await client.query(READ_ONLY_SESSION_BEGIN);

    const result = await runPayoutRepairDryRun({
      query: (sql: string, params?: any[]) => client.query(sql, params ?? []),
      ledgerEntryIds: requestedIds,
    });

    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2));
    process.exitCode = result.exitCode;
  } catch (error: any) {
    console.error(`[payout-repair-dry-run] DATABASE ERROR: ${error?.message ?? error}`);
    process.exitCode = 3;
  } finally {
    try {
      if (client) await client.query(READ_ONLY_SESSION_END);
    } catch {
      /* the session is being discarded anyway */
    }
    try {
      if (client) client.release();
    } catch {
      /* ignore */
    }
    await pool.end().catch(() => undefined);
  }
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void main(process.argv.slice(2));
}
