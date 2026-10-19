// PAYOUT REPAIR POLICY (Phase 1 — payout readiness) — pure data + pure functions.
//
// WHY THIS IS A CONFIG MODULE
// ---------------------------
// The same reason `src/config/payoutOutcomes.ts` is one: the eligibility rules and
// the closed vocabularies they use must be readable by
//   * `src/db/schema.ts`             (the CHECK constraints, from the SQL lists below)
//   * `src/db/index.ts`              (the idempotent runtime DDL)
//   * `src/db/database.ts`           (the confirmed-repair transaction)
//   * `src/services/payoutRepair.ts` (proposal/confirmation orchestration)
//   * `scripts/payoutRepairDryRun.ts`(the read-only investigation tool)
// without any of them duplicating a rule. Nothing here touches the database, the
// network, a provider, or a clock: every decision is a function of the evidence
// it is handed, so it can be tested exhaustively and cannot drift per call site.
//
// WHAT A "REPAIR" IS — AND IS NOT
// -------------------------------
// A repair is a NARROW, DUAL-CONTROLLED release of ONE payout leg for which
// SEPARATELY IMPORTED PROVIDER EVIDENCE establishes that the earlier attempt was
// refused before execution, from the stranded `failed` + `rejected` state back
// to the canonical never-submitted state that `isPayoutSubmittable()` already
// understands (`pending` + `not_submitted`).
//
// WHY `rejected` ALONE IS NOT ENOUGH (F1/F7, Phase 1 remediation)
// ---------------------------------------------------------------
// `rejected` is written when the submission path receives a non-2xx provider
// response that it does not classify as ambiguous. The HTTP status is not
// persisted, and the classification cannot exclude duplicate-idempotency
// (409), rate-limit (429), client-closed (499), timeout (408), 3xx or 5xx
// ambiguity. It is therefore a LOCAL CLASSIFICATION, never proof that money did
// not move. Repair eligibility additionally requires a row-level audit record
// (action `PAYOUT_REPAIR_REFUSAL_EVIDENCE_RECORDED`, details prefixed
// `PAYOUT_REFUSAL_EVIDENCE_V1 `) that names this row, the row's provider batch,
// the exact idempotency key the retry would re-use, and the provider's stated
// disposition of that key. No production code writes such a record: it is an
// external, reviewed evidence import. Until one exists, every `rejected` row is
// blocked (`refusal_provenance_unverified`).
//
// It is NOT a retry button, NOT a way to re-open an ambiguous row, and NOT a
// general ledger-edit mechanism:
//   * the only operation in the vocabulary is `release_rejected_leg`;
//   * the only legal source state is `status = 'failed'` + `outcome = 'rejected'`;
//   * the only legal target state is `status = 'pending'` + `outcome = 'not_submitted'`;
//   * a repair never submits anything — afterwards the row is merely *eligible*
//     for the ordinary, separately authorized submission path, which re-reads
//     every gate it always did.
//
// WHY A LEGACY `failed` + NULL ROW IS NEVER ELIGIBLE
// -------------------------------------------------
// `ledger.payout_outcome = NULL` means "no submission history was recorded", not
// "no submission happened" (see the column comment in schema.ts and
// isPayoutSubmittable()). A NULL row may be the residue of a request that
// reached IntaSend and moved money. The absence of a submission record is not
// evidence of absence, and no operator assertion, error string, dashboard label
// or internal `status` value can turn it into proof. Such rows are therefore
// permanently BLOCKED here (`submission_history_missing`) until a separate,
// independently reviewed evidence-import step records provider-side proof that
// the transfer never executed. That is a deliberate outcome, not a gap.

import { createHash } from 'node:crypto';
import { isPayoutOutcome, isUnresolvedPayoutOutcome } from './payoutOutcomes';
import { maskPayoutDestinationForLog } from './payoutDestinations';
import { payoutLegIdempotencyKeyForEntryType } from './payoutIdempotency';

// ---------------------------------------------------------------------------
// VOCABULARIES (single source for schema.ts, sql/schema.sql and db/index.ts)
// ---------------------------------------------------------------------------

/** The complete set of repair operations. Deliberately ONE entry. */
export const PAYOUT_REPAIR_OPERATIONS = ['release_rejected_leg'] as const;
export type PayoutRepairOperation = (typeof PAYOUT_REPAIR_OPERATIONS)[number];

/** The complete lifecycle of a repair request. `proposed` is the only non-terminal value. */
export const PAYOUT_REPAIR_REQUEST_STATUSES = ['proposed', 'confirmed', 'expired', 'rejected'] as const;
export type PayoutRepairRequestStatus = (typeof PAYOUT_REPAIR_REQUEST_STATUSES)[number];

/** `ledger.type` values a repair may ever target. Fees and refunds are not payouts. */
export const PAYOUT_REPAIR_LEG_TYPES = ['finder_payout', 'agent_payout'] as const;

/** The final outcome recorded on a CONFIRMED request. */
export const PAYOUT_REPAIR_OUTCOMES = ['applied'] as const;

/** SQL fragments for CHECK constraints, generated so the copies cannot drift. */
export const PAYOUT_REPAIR_OPERATION_SQL_LIST = PAYOUT_REPAIR_OPERATIONS.map((v) => `'${v}'`).join(', ');
export const PAYOUT_REPAIR_STATUS_SQL_LIST = PAYOUT_REPAIR_REQUEST_STATUSES.map((v) => `'${v}'`).join(', ');
export const PAYOUT_REPAIR_LEG_TYPE_SQL_LIST = PAYOUT_REPAIR_LEG_TYPES.map((v) => `'${v}'`).join(', ');

/**
 * D4 — a proposal is valid for 24 hours. Short enough that a stale proposal
 * cannot be confirmed days later against a world that has moved on, long enough
 * for a second administrator to review the evidence and act in the same
 * working day. Expiry is re-checked (never inferred) at confirmation time, and
 * every eligibility rule is re-evaluated there too.
 */
export const PAYOUT_REPAIR_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * F2 — the ONE ordered column list for `payout_repair_requests`.
 *
 * The three declarations (Drizzle schema, sql/schema.sql, runtime DDL) must
 * match this list exactly, in order. A parity test compares all three against
 * it rather than asserting that a few constraint NAMES merely appear somewhere
 * in each file (the check that previously let a 22-vs-23-vs-24 column drift go
 * unnoticed).
 */
export const PAYOUT_REPAIR_REQUEST_COLUMNS = [
  'id',
  'ledger_entry_id',
  'claim_id',
  'entry_type',
  'repair_operation',
  'from_status',
  'from_payout_outcome',
  'to_status',
  'to_payout_outcome',
  'reason',
  'evidence_json',
  'row_fingerprint',
  'request_fingerprint',
  'status',
  'proposed_by',
  'proposed_at',
  'expires_at',
  'confirmed_by',
  'confirmed_at',
  'outcome',
  'outcome_detail',
  'audit_correlation_id',
  'created_at',
  'updated_at',
] as const;


// ---------------------------------------------------------------------------
// BLOCKING CODES
// ---------------------------------------------------------------------------
// Stable identifiers. They are the API contract of a refusal (the dry run prints
// them; the endpoints return them), so they are never reworded casually and they
// never carry a destination, amount or identity.
export const PAYOUT_REPAIR_BLOCKING_CODES = {
  ROW_NOT_FOUND: 'row_not_found',
  NOT_A_PAYOUT_LEG: 'not_a_payout_leg',
  CLAIM_ASSOCIATION_MISSING: 'claim_association_missing',
  CLAIM_NOT_FOUND: 'claim_not_found',
  CLAIM_STATE_NOT_REPAIRABLE: 'claim_state_not_repairable',
  PAYOUT_OUTCOME_UNRECOGNIZED: 'payout_outcome_unrecognized',
  SUBMISSION_HISTORY_MISSING: 'submission_history_missing',
  SUBMISSION_MAY_HAVE_OCCURRED: 'submission_may_have_occurred',
  ALREADY_COMPLETED: 'already_completed',
  STATUS_NOT_REPAIRABLE: 'status_not_repairable',
  NOTHING_TO_REPAIR: 'nothing_to_repair',
  INCONSISTENT_STATE: 'inconsistent_state',
  PROVIDER_TRANSACTION_REFERENCE_AMBIGUOUS: 'provider_transaction_reference_ambiguous',
  FAILURE_EVIDENCE_MISSING: 'failure_evidence_missing',
  AUDIT_EVIDENCE_AMBIGUOUS: 'audit_evidence_ambiguous',
  DESTINATION_MISSING: 'destination_missing',
  AMOUNT_INVALID: 'amount_invalid',
  DUPLICATE_LEG_ALREADY_COMPLETED: 'duplicate_leg_already_completed',
  CONFLICTING_LEDGER_STATE: 'conflicting_ledger_state',
  ALREADY_REPAIRED: 'already_repaired',
  // Phase 1 remediation (F1/F7): `rejected` is a local classification, not proof
  // of non-execution, and the provider's key-retention semantics are unverified.
  REFUSAL_PROVENANCE_UNVERIFIED: 'refusal_provenance_unverified',
  REFUSAL_EVIDENCE_CONFLICTING: 'refusal_evidence_conflicting',
  IDEMPOTENCY_KEY_STATE_UNVERIFIED: 'idempotency_key_state_unverified',
} as const;

export type PayoutRepairBlockingCode =
  (typeof PAYOUT_REPAIR_BLOCKING_CODES)[keyof typeof PAYOUT_REPAIR_BLOCKING_CODES];

/**
 * F1 / F7 — THE ONLY EVIDENCE THAT MAY PERMIT A REPAIR.
 *
 * `payout_outcome = 'rejected'` is a LOCAL CLASSIFICATION produced from an HTTP
 * status that is not persisted. It cannot, by itself, distinguish "the provider
 * refused before execution" from "a duplicate-idempotency / 3xx / 429 / 499 /
 * timeout-ish response left execution unknown". The policy therefore requires a
 * SEPARATE, row-level record of provider-side non-execution, imported through a
 * reviewed procedure outside this codebase:
 *
 *   audit_log.action = 'PAYOUT_REPAIR_REFUSAL_EVIDENCE_RECORDED'
 *   audit_log.details = 'PAYOUT_REFUSAL_EVIDENCE_V1 {json}'
 *
 * The JSON is deliberately strict. A record is only usable when it names THIS
 * ledger row, the same provider batch the row carries, the SAME idempotency key
 * the submission path would re-use, and states how that key may be reused. The
 * provider's key-retention semantics are unresolved locally (F7); an absent or
 * unrecognised disposition blocks rather than assumes.
 *
 * NO production code writes this action in this batch. That is intentional: the
 * evidence must come from the provider/reconciliation process, not from the
 * same HTTP status the policy refuses to trust. Until such records exist, every
 * `rejected` row remains blocked.
 */
export const PAYOUT_REFUSAL_EVIDENCE_ACTION = 'PAYOUT_REPAIR_REFUSAL_EVIDENCE_RECORDED' as const;
export const PAYOUT_REFUSAL_EVIDENCE_PREFIX = 'PAYOUT_REFUSAL_EVIDENCE_V1 ' as const;
export const PAYOUT_REFUSAL_EVIDENCE_VERSION = 1 as const;

export const PAYOUT_REFUSAL_IDEMPOTENCY_DISPOSITIONS = ['released', 'never_consumed'] as const;
export type PayoutRefusalIdempotencyDisposition =
  (typeof PAYOUT_REFUSAL_IDEMPOTENCY_DISPOSITIONS)[number];

export interface PayoutRefusalEvidence {
  version: typeof PAYOUT_REFUSAL_EVIDENCE_VERSION;
  ledger_entry_id: string;
  provider: string;
  provider_batch_id: string | null;
  provider_transaction_id: string | null;
  idempotency_key: string;
  /** May be any string at parse time; the policy validates the vocabulary. */
  idempotency_key_disposition: string;
  non_execution_reference: string;
  recorded_by: string;
  recorded_at: string;
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Parse ONE evidence record. Structural validation only; semantic matching
 * against a ledger row (id, batch, key, disposition) happens in the rule, so the
 * refusal can say which part conflicted.
 *
 * Returns null for anything malformed — never a partially trusted object.
 */
export function parsePayoutRefusalEvidence(details: string | null | undefined): PayoutRefusalEvidence | null {
  if (typeof details !== 'string') return null;
  const text = details.trim();
  if (!text.startsWith(PAYOUT_REFUSAL_EVIDENCE_PREFIX)) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(PAYOUT_REFUSAL_EVIDENCE_PREFIX.length));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.version !== PAYOUT_REFUSAL_EVIDENCE_VERSION) return null;
  if (!nonEmptyString(parsed.ledger_entry_id)) return null;
  if (!nonEmptyString(parsed.provider)) return null;
  if (parsed.provider_batch_id !== null && !nonEmptyString(parsed.provider_batch_id)) return null;
  if (parsed.provider_transaction_id !== null && !nonEmptyString(parsed.provider_transaction_id)) {
    return null;
  }
  if (!nonEmptyString(parsed.idempotency_key)) return null;
  if (typeof parsed.idempotency_key_disposition !== 'string') return null;
  if (!nonEmptyString(parsed.non_execution_reference)) return null;
  if (!nonEmptyString(parsed.recorded_by)) return null;
  if (!nonEmptyString(parsed.recorded_at) || !Number.isFinite(Date.parse(parsed.recorded_at))) {
    return null;
  }
  return {
    version: PAYOUT_REFUSAL_EVIDENCE_VERSION,
    ledger_entry_id: parsed.ledger_entry_id.trim(),
    provider: parsed.provider.trim(),
    provider_batch_id: parsed.provider_batch_id === null ? null : parsed.provider_batch_id.trim(),
    provider_transaction_id:
      parsed.provider_transaction_id === null ? null : parsed.provider_transaction_id.trim(),
    idempotency_key: parsed.idempotency_key.trim(),
    idempotency_key_disposition: parsed.idempotency_key_disposition,
    non_execution_reference: parsed.non_execution_reference.trim(),
    recorded_by: parsed.recorded_by.trim(),
    recorded_at: parsed.recorded_at.trim(),
  };
}

/**
 * Audit actions that make a row AMBIGUOUS, i.e. they record (or imply) an
 * outcome that is not a clean, provider-recorded refusal.
 *
 * `CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED` is deliberately NOT in this list: it is
 * the normal, expected companion of a `rejected` outcome (the request WAS made
 * and the provider refused it). What must block a repair is any record that the
 * attempt was inconclusive, that another worker may have sent the same row, or
 * that this row was already repaired.
 */
export const PAYOUT_REPAIR_AMBIGUOUS_AUDIT_ACTIONS = [
  'PAYOUT_NOT_CONFIRMED',
  'PAYOUT_RECONCILIATION_REQUIRED',
  'PAYOUT_ATTEMPT_ALREADY_IN_FLIGHT',
  'CLAIM_SETTLEMENT_PAYOUT_UNRESOLVED',
] as const;

/**
 * F6 — audit actions that are BATCH-scoped: their `details` name a provider
 * batch (and a provider transaction) rather than this ledger row. They are
 * execution evidence and must be considered whenever the batch could contain
 * this row.
 */
export const PAYOUT_REPAIR_BATCH_SCOPED_AUDIT_ACTIONS = [
  'PAYOUT_VERIFICATION_UNMATCHED',
  'PAYOUT_VERIFIED_COMPLETED',
  'PAYOUT_VERIFICATION_LEG_NOT_CONFIRMABLE',
] as const;


/** Audit actions this phase writes/reads about a repair request itself. */
export const PAYOUT_REPAIR_AUDIT_ACTIONS = {
  PROPOSED: 'PAYOUT_REPAIR_PROPOSED',
  CONFIRMED: 'PAYOUT_REPAIR_CONFIRMED',
  EXPIRED: 'PAYOUT_REPAIR_EXPIRED',
  REFUSED: 'PAYOUT_REPAIR_REFUSED',
} as const;

/**
 * F6 — the INVERTED allowlist. A record that names this ledger row is ignored
 * only when its action is explicitly known-safe. Every other action (including
 * a future or manually written one) blocks. This replaces the old closed list,
 * which silently ignored `PAYOUT_VERIFICATION_UNMATCHED` and any unknown action.
 *
 * `PAYOUT_REPAIR_CONFIRMED` is handled separately as ALREADY_REPAIRED rather
 * than as ambiguity.
 */
export const PAYOUT_REPAIR_SAFE_AUDIT_ACTIONS = [
  'CLAIM_SETTLEMENT_PAYOUT_ATTEMPTED',
  PAYOUT_REFUSAL_EVIDENCE_ACTION,
  PAYOUT_REPAIR_AUDIT_ACTIONS.PROPOSED,
  PAYOUT_REPAIR_AUDIT_ACTIONS.EXPIRED,
  PAYOUT_REPAIR_AUDIT_ACTIONS.REFUSED,
] as const;

/** Every audit action the evidence query must fetch for a row or its batch. */
export const PAYOUT_REPAIR_EVIDENCE_AUDIT_ACTIONS = [
  ...PAYOUT_REPAIR_AMBIGUOUS_AUDIT_ACTIONS,
  ...PAYOUT_REPAIR_BATCH_SCOPED_AUDIT_ACTIONS,
  PAYOUT_REPAIR_AUDIT_ACTIONS.CONFIRMED,
  PAYOUT_REFUSAL_EVIDENCE_ACTION,
] as const;


// ---------------------------------------------------------------------------
// EVIDENCE SHAPES
// ---------------------------------------------------------------------------
// These are DATABASE SNAPSHOTS, not API views. `phone_or_till` appears because
// eligibility must know a destination is present; nothing here is ever returned
// to an HTTP client, and it is masked before it reaches an audit row or a log.

export interface PayoutRepairLedgerSnapshot {
  id: string;
  claim_id: string | null;
  item_id: string | null;
  type: string;
  amount: string | number | null;
  phone_or_till: string | null;
  status: string | null;
  payout_outcome: string | null;
  provider_batch_id: string | null;
  provider_transaction_id: string | null;
  failure_reason: string | null;
  created_at?: Date | string | null;
}

export interface PayoutRepairClaimSnapshot {
  id: string;
  status: string | null;
}

/** An audit row whose `details` NAMES the target ledger row. */
export interface PayoutRepairAuditSnapshot {
  id: string;
  action: string;
  details: string | null;
}

/** All evidence the decision is allowed to consider. Nothing outside this is consulted. */
export interface PayoutRepairEvidence {
  ledgerEntry: PayoutRepairLedgerSnapshot | null;
  claim: PayoutRepairClaimSnapshot | null;
  /** Every ledger row belonging to the same claim (sibling legs + the target). */
  claimLedger: PayoutRepairLedgerSnapshot[];
  /** Audit rows naming this ledger row id (ambiguous + prior-repair actions only). */
  auditEntries: PayoutRepairAuditSnapshot[];
}

/**
 * Structured evidence digest stored on the request and returned by the dry run.
 * Contains NO full destination and NO personal data — only presence flags,
 * counts and the masked destination.
 */
export interface PayoutRepairEvidenceDigest {
  ledgerEntryId: string | null;
  entryType: string | null;
  status: string | null;
  payoutOutcome: string | null;
  claimId: string | null;
  claimStatus: string | null;
  amountPresent: boolean;
  destinationMasked: string | null;
  providerBatchRefPresent: boolean;
  providerTransactionRefPresent: boolean;
  failureReasonPresent: boolean;
  siblingLegCount: number;
  siblingCompletedCount: number;
  auditEvidenceCount: number;
  ambiguousAuditEvidenceCount: number;
  priorRepairEvidenceCount: number;
  /** F1 — how many refusal-evidence records name this row, and whether one is usable. */
  refusalEvidenceCount: number;
  refusalEvidenceValid: boolean;
  /** F7 — the disposition the usable evidence asserts, if any. */
  idempotencyKeyDisposition: string | null;
  /** F6 — batch-scoped events that matched this row's batch (or could not be linked). */
  batchScopedAuditEvidenceCount: number;
  /** F6 — events with no possible row linkage (the row/claim carries no batch id). */
  unlinkableBatchAuditEvidenceCount: number;
}

export interface PayoutRepairEligibility {
  eligible: boolean;
  operation: PayoutRepairOperation | null;
  fromStatus: string | null;
  fromOutcome: string | null;
  toStatus: 'pending' | null;
  toOutcome: 'not_submitted' | null;
  blockingCodes: PayoutRepairBlockingCode[];
  /** Plain-English, PII-free explanation per blocking code (index-aligned). */
  blockingReasons: string[];
  evidence: PayoutRepairEvidenceDigest;
}

/** Mask a ledger destination for any output that leaves the process. */
export function maskLedgerDestination(value: string | null | undefined): string | null {
  if (!value) return null;
  return maskPayoutDestinationForLog(String(value));
}

/**
 * F4 — preserve a previous `failure_reason` in the confirmation audit WITHOUT
 * copying a raw phone/Till into the audit log.
 *
 * The value is free text. Any phone-like run of digits is masked with the same
 * helper used for destinations, whitespace is collapsed, and the result is
 * bounded so a provider dump cannot be absorbed into `audit_log`.
 */
export function redactPayoutFailureReasonForAudit(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return null;
  const masked = trimmed.replace(/\+?\d[\d\s().-]{5,}\d/g, (candidate) =>
    maskPayoutDestinationForLog(candidate.replace(/[\s().-]/g, '')),
  );
  return masked.length > 240 ? `${masked.slice(0, 237)}...` : masked;
}

/** True when an audit row's details genuinely name this ledger row (not a prefix collision). */
export function auditEntryNamesLedgerRow(details: string | null | undefined, ledgerEntryId: string): boolean {
  if (!details || !ledgerEntryId) return false;
  // A word-boundary check, because `LED-1234` is a prefix of `LED-12345`: a naive
  // substring test would let an unrelated row's evidence block this one (or,
  // worse, fail to block it). Anything ambiguous counts as naming the row — the
  // conservative direction, since that can only ADD a blocking reason.
  const hay = String(details);
  const needle = String(ledgerEntryId);
  const isWordChar = (ch) => /[A-Za-z0-9]/.test(ch);
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : hay[at - 1];
    const after = at + needle.length >= hay.length ? "" : hay[at + needle.length];
    if ((!before || !isWordChar(before)) && (!after || !isWordChar(after))) return true;
    from = at + 1;
  }
}

// ---------------------------------------------------------------------------
// FINGERPRINTS (stale-proposal detection)
// ---------------------------------------------------------------------------
// The fingerprint is the whole safety mechanism for "has this row changed since
// the proposal?". It therefore covers every field the repair READS OR WRITES,
// and it serialises them in a fixed order with explicit null markers — no JSON
// key ordering, no locale, no Date formatting drift.
//
// F5 (Phase 1 remediation): the destination (`phone_or_till`) is now covered
// too, as a SHA-256 of the trimmed value — never the value itself. A destination
// changed between proposal and confirmation therefore invalidates the proposal,
// and no raw destination is ever stored as fingerprint evidence. `created_at`
// is included for completeness even though the rule does not read it.
//
// `failure_reason` is included even though a repair appends to it: a changed
// failure reason between proposal and confirmation means new information
// arrived, so the proposition that was reviewed is no longer the row that
// exists.

function fpField(value: unknown): string {
  if (value === null || value === undefined) return '\u0000null';
  if (value instanceof Date) return `T:${value.getTime()}`;
  // TIMESTAMPS ARE NORMALISED, NOT STRINGIFIED. PostgreSQL returns a Date for a
  // TIMESTAMPTZ column, while the in-memory test double returns the ISO string it
  // stored. Hashing the two forms differently would make every confirmation fail
  // its own integrity check outside production, so both are reduced to epoch ms.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return `T:${ms}`;
  }
  return `V:${String(value)}`;
}

/**
 * F5 — destination evidence for the row fingerprint.
 *
 * Hashed, never emitted: the fingerprint is stored on the request row and could
 * be read by an administrator, so it must not be a reversible encoding of a
 * phone number or Till. Trimming only ignores formatting noise; any change to
 * the value itself changes the digest and invalidates the proposal.
 */
function fpDestination(value: string | null | undefined): string {
  if (value === null || value === undefined) return '\u0000null';
  const compact = String(value).trim();
  if (compact === '') return 'D:empty';
  return `D:${createHash('sha256').update(compact).digest('hex')}`;
}

export function payoutRowFingerprint(row: PayoutRepairLedgerSnapshot | null): string {
  const parts = [
    'payout-repair-row-v2',
    fpField(row?.id),
    fpField(row?.claim_id),
    fpField(row?.item_id),
    fpField(row?.type),
    fpField(row?.amount),
    fpDestination(row?.phone_or_till),
    fpField(row?.status),
    fpField(row?.payout_outcome),
    fpField(row?.provider_batch_id),
    fpField(row?.provider_transaction_id),
    fpField(row?.failure_reason),
    fpField(row?.created_at),
  ];
  return createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

/** The request's own reviewed state, so a rewritten proposal cannot be confirmed. */
export function payoutRepairRequestFingerprint(request: {
  id?: string | null;
  ledger_entry_id?: string | null;
  claim_id?: string | null;
  entry_type?: string | null;
  repair_operation?: string | null;
  from_status?: string | null;
  from_payout_outcome?: string | null;
  to_status?: string | null;
  to_payout_outcome?: string | null;
  reason?: string | null;
  row_fingerprint?: string | null;
  proposed_by?: string | null;
  expires_at?: Date | string | null;
}): string {
  const parts = [
    'payout-repair-request-v2',
    fpField(request?.id),
    fpField(request?.ledger_entry_id),
    fpField(request?.claim_id),
    fpField(request?.entry_type),
    fpField(request?.repair_operation),
    fpField(request?.from_status),
    fpField(request?.from_payout_outcome),
    fpField(request?.to_status),
    fpField(request?.to_payout_outcome),
    fpField(request?.reason),
    fpField(request?.row_fingerprint),
    fpField(request?.proposed_by),
    fpField(request?.expires_at),
  ];
  return createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

// ---------------------------------------------------------------------------
// THE ELIGIBILITY RULE
// ---------------------------------------------------------------------------
// Every check is a REASON TO REFUSE. There is exactly one way to be eligible:
// the row is a payout leg of a claim stranded in `pending_settlement`, its
// status is `failed`, its outcome is `rejected`, imported provider evidence
// establishes non-execution AND a reusable/never-consumed idempotency key for
// this exact row, the provider never produced a per-transaction reference, the
// failure is recorded rather than blank, no audit record (row- or batch-scoped)
// contradicts a clean refusal, no sibling leg of the same role is already
// completed or independently submittable, and the amount/destination fields are
// usable.
//
// ALL blocking reasons are collected (not just the first) so an investigator
// sees the complete picture for a row instead of rediscovering it one refusal
// at a time — which is what makes the dry run useful.

export function evaluatePayoutRepairEligibility(evidence: PayoutRepairEvidence): PayoutRepairEligibility {
  const row = evidence?.ledgerEntry ?? null;
  const claim = evidence?.claim ?? null;
  const claimLedger = Array.isArray(evidence?.claimLedger) ? evidence.claimLedger : [];
  const auditEntries = Array.isArray(evidence?.auditEntries) ? evidence.auditEntries : [];

  const codes: PayoutRepairBlockingCode[] = [];
  const reasons: string[] = [];
  const block = (code: PayoutRepairBlockingCode, reason: string) => {
    if (!codes.includes(code)) {
      codes.push(code);
      reasons.push(reason);
    }
  };

  const siblings = row ? claimLedger.filter((l) => l && l.id !== row.id && l.type === row.type) : [];
  // F6 — every batch id this row or a sibling leg of the same claim carries.
  // A batch-scoped event is execution evidence about the batch, not the row; it
  // can only be excluded when it names a DIFFERENT batch than every batch this
  // claim is associated with.
  const batchIds = Array.from(
    new Set(
      [row, ...siblings]
        .map((l) => (l?.provider_batch_id ? String(l.provider_batch_id) : null))
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const isBatchScoped = (action: string) =>
    (PAYOUT_REPAIR_BATCH_SCOPED_AUDIT_ACTIONS as readonly string[]).includes(action);
  const isSafeAction = (action: string) =>
    (PAYOUT_REPAIR_SAFE_AUDIT_ACTIONS as readonly string[]).includes(action);
  const isAmbiguousAction = (action: string) =>
    (PAYOUT_REPAIR_AMBIGUOUS_AUDIT_ACTIONS as readonly string[]).includes(action);

  const namesRow = (a: PayoutRepairAuditSnapshot) =>
    Boolean(row && auditEntryNamesLedgerRow(a.details, row.id));
  const namesBatch = (a: PayoutRepairAuditSnapshot) =>
    batchIds.some((id) => auditEntryNamesLedgerRow(a.details, id));

  const ambiguousAudit = !row
    ? []
    : auditEntries.filter((a) => {
        if (!a) return false;
        if (a.action === PAYOUT_REPAIR_AUDIT_ACTIONS.CONFIRMED) return false;
        if (isBatchScoped(a.action)) {
          // Relevant when it names this row, a batch this claim is linked to, or
          // when the claim carries no batch id at all (no reliable linkage — fail
          // closed rather than assume the event is about another batch).
          return namesRow(a) || namesBatch(a) || batchIds.length === 0;
        }
        if (isAmbiguousAction(a.action)) return namesRow(a);
        // THE INVERTED ALLOWLIST (F6): any other action naming this row blocks,
        // including actions this codebase does not know yet.
        return namesRow(a) && !isSafeAction(a.action);
      });
  const priorRepairAudit = row
    ? auditEntries.filter(
        (a) =>
          a &&
          a.action === PAYOUT_REPAIR_AUDIT_ACTIONS.CONFIRMED &&
          auditEntryNamesLedgerRow(a.details, row.id),
      )
    : [];

  // F1 / F7 — parse every imported refusal-evidence record. Structural failures
  // are distinguished from semantic conflicts so the operator is told whether
  // evidence is absent, unreadable, or about a different row/batch/key.
  const refusalCandidates = auditEntries
    .filter((a) => a && a.action === PAYOUT_REFUSAL_EVIDENCE_ACTION)
    .map((a) => ({ entry: a, parsed: parsePayoutRefusalEvidence(a.details) }));
  const refusalAboutRow = refusalCandidates.filter(
    (candidate) => candidate.parsed && candidate.parsed.ledger_entry_id === row?.id,
  );
  const malformedRefusalNamingRow = refusalCandidates.filter(
    (candidate) => !candidate.parsed && row && auditEntryNamesLedgerRow(candidate.entry.details, row.id),
  );

  const expectedIdempotencyKey = row
    ? payoutLegIdempotencyKeyForEntryType(row.claim_id, row.type)
    : null;
  let refusalEvidenceValid = false;
  let refusalEvidenceDisposition: string | null = null;
  let refusalProblem: { code: PayoutRepairBlockingCode; reason: string } | null = null;

  if (row && row.payout_outcome === 'rejected') {
    if (refusalAboutRow.length === 0) {
      refusalProblem = {
        code: PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_PROVENANCE_UNVERIFIED,
        reason:
          'No imported provider refusal evidence names this row. `rejected` is a local HTTP-status ' +
          'classification — it is not proof that no transfer executed. Repair requires a ' +
          `'${PAYOUT_REFUSAL_EVIDENCE_ACTION}' audit record with a ` +
          `'${PAYOUT_REFUSAL_EVIDENCE_PREFIX.trim()}' payload naming this row, its batch, its ` +
          'idempotency key and the key disposition.',
      };
    } else if (refusalAboutRow.length > 1) {
      refusalProblem = {
        code: PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_EVIDENCE_CONFLICTING,
        reason: `${refusalAboutRow.length} refusal-evidence records name this row; conflicting evidence cannot permit a repair.`,
      };
    } else {
      const refusal = refusalAboutRow[0].parsed!;
      if (refusal.provider !== 'intasend') {
        refusalProblem = {
          code: PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_EVIDENCE_CONFLICTING,
          reason: `Refusal evidence names provider '${refusal.provider}', not the provider this ledger submits to.`,
        };
      } else if (!expectedIdempotencyKey) {
        refusalProblem = {
          code: PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_EVIDENCE_CONFLICTING,
          reason: 'The idempotency key for this row cannot be derived (missing claim or non-payout type).',
        };
      } else if (refusal.provider_batch_id !== (row.provider_batch_id ?? null)) {
        refusalProblem = {
          code: PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_EVIDENCE_CONFLICTING,
          reason: 'Refusal evidence names a different provider batch than the ledger row carries.',
        };
      } else if (refusal.provider_transaction_id !== null) {
        refusalProblem = {
          code: PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_EVIDENCE_CONFLICTING,
          reason:
            'Refusal evidence carries a provider transaction reference; a materialised transaction ' +
            'contradicts non-execution.',
        };
      } else if (refusal.idempotency_key !== expectedIdempotencyKey) {
        refusalProblem = {
          code: PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_EVIDENCE_CONFLICTING,
          reason: 'Refusal evidence names a different idempotency key than the one this leg would re-use.',
        };
      } else if (
        !(PAYOUT_REFUSAL_IDEMPOTENCY_DISPOSITIONS as readonly string[]).includes(
          refusal.idempotency_key_disposition,
        )
      ) {
        refusalProblem = {
          code: PAYOUT_REPAIR_BLOCKING_CODES.IDEMPOTENCY_KEY_STATE_UNVERIFIED,
          reason:
            'Refusal evidence does not state a recognised idempotency-key disposition (' +
            `${PAYOUT_REFUSAL_IDEMPOTENCY_DISPOSITIONS.join(' | ')}). Whether the provider retains ` +
            'a refused key is unverified, so the retry cannot be shown safe.',
        };
      } else if (malformedRefusalNamingRow.length > 0) {
        refusalProblem = {
          code: PAYOUT_REPAIR_BLOCKING_CODES.REFUSAL_EVIDENCE_CONFLICTING,
          reason:
            'A malformed refusal-evidence record also names this row; ambiguous evidence cannot ' +
            'permit a repair.',
        };
      } else {
        refusalEvidenceValid = true;
        refusalEvidenceDisposition = refusal.idempotency_key_disposition;
      }
    }
  }

  const digest: PayoutRepairEvidenceDigest = {
    ledgerEntryId: row?.id ?? null,
    entryType: row?.type ?? null,
    status: row?.status ?? null,
    payoutOutcome: row?.payout_outcome ?? null,
    claimId: row?.claim_id ?? null,
    claimStatus: claim?.status ?? null,
    amountPresent: row?.amount !== null && row?.amount !== undefined && String(row.amount).trim() !== '',
    destinationMasked: maskLedgerDestination(row?.phone_or_till),
    providerBatchRefPresent: Boolean(row?.provider_batch_id),
    providerTransactionRefPresent: Boolean(row?.provider_transaction_id),
    failureReasonPresent: Boolean(row?.failure_reason && String(row.failure_reason).trim()),
    siblingLegCount: siblings.length,
    siblingCompletedCount: siblings.filter((l) => l?.status === 'completed').length,
    auditEvidenceCount: auditEntries.length,
    ambiguousAuditEvidenceCount: ambiguousAudit.length,
    priorRepairEvidenceCount: priorRepairAudit.length,
    refusalEvidenceCount: refusalAboutRow.length,
    refusalEvidenceValid,
    idempotencyKeyDisposition: refusalEvidenceDisposition,
    batchScopedAuditEvidenceCount: ambiguousAudit.filter((a) =>
      isBatchScoped(a.action),
    ).length,
    unlinkableBatchAuditEvidenceCount: ambiguousAudit.filter(
      (a) => isBatchScoped(a.action) && batchIds.length === 0 && !namesRow(a),
    ).length,
  };

  if (!row) {
    block(PAYOUT_REPAIR_BLOCKING_CODES.ROW_NOT_FOUND, 'The ledger row does not exist.');
  } else {
    const outcome = row.payout_outcome;

    // --- 1. WHAT IS THIS ROW? ----------------------------------------------
    if (!(PAYOUT_REPAIR_LEG_TYPES as readonly string[]).includes(String(row.type))) {
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.NOT_A_PAYOUT_LEG,
        'The ledger row is not a finder or agent payout leg.',
      );
    }
    if (!row.claim_id) {
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.CLAIM_ASSOCIATION_MISSING,
        'The ledger row is not associated with a claim.',
      );
    } else if (!claim) {
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.CLAIM_NOT_FOUND,
        'The claim the ledger row belongs to could not be read.',
      );
    } else if (claim.status !== 'pending_settlement') {
      // Only `pending_settlement` is a state in which a stranded payout leg
      // actually blocks a human decision. `releasing` means an execution is (or
      // was) in flight; `released`/`refunded`/`disputed` must never have a leg
      // re-armed underneath them.
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.CLAIM_STATE_NOT_REPAIRABLE,
        `The claim is in state '${String(claim.status)}', not 'pending_settlement'.`,
      );
    }

    // --- 2. SUBMISSION HISTORY (the decisive question) ---------------------
    if (outcome === null || outcome === undefined || String(outcome).trim() === '') {
      // THE LEGACY CLASS. Not eligible, by design — see the module header.
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.SUBMISSION_HISTORY_MISSING,
        'No submission history is recorded for this row (payout_outcome IS NULL). ' +
          'The absence of a record is not proof that no transfer was submitted; ' +
          'provider reconciliation is required before this row can be repaired.',
      );
    } else if (!isPayoutOutcome(outcome)) {
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.PAYOUT_OUTCOME_UNRECOGNIZED,
        `The recorded payout outcome '${String(outcome)}' is not a known value.`,
      );
    } else if (isUnresolvedPayoutOutcome(outcome)) {
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.SUBMISSION_MAY_HAVE_OCCURRED,
        `The recorded payout outcome '${outcome}' means the transfer may already have moved money.`,
      );
    } else if (outcome === 'completed') {
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.ALREADY_COMPLETED,
        'The recorded payout outcome is completed; the transfer is already paid.',
      );
    } else if (outcome === 'not_submitted') {
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.NOTHING_TO_REPAIR,
        'The row already records that it was never submitted; there is nothing to release.',
      );
    }

    // --- 3. INTERNAL STATUS -------------------------------------------------
    if (row.status === 'completed') {
      block(PAYOUT_REPAIR_BLOCKING_CODES.ALREADY_COMPLETED, 'The ledger row status is completed.');
    } else if (row.status !== 'failed') {
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.STATUS_NOT_REPAIRABLE,
        `The ledger row status is '${String(row.status)}', not 'failed'.`,
      );
    }

    // --- 4. THE ONE SUPPORTED CLASS: failed + provider refusal -------------
    // These checks describe that class precisely. They run whenever the outcome
    // is `rejected`, even if a check above already refused, so the report is
    // complete rather than truncated at the first problem.
    if (outcome === 'rejected') {
      if (row.status !== 'failed') {
        block(
          PAYOUT_REPAIR_BLOCKING_CODES.INCONSISTENT_STATE,
          'A rejected outcome is only repairable together with a failed status.',
        );
      }
      if (row.provider_transaction_id) {
        // A per-transaction provider reference means the provider MATERIALISED a
        // transaction for this row. Whatever a later refusal says, this database
        // can no longer prove that nothing executed.
        block(
          PAYOUT_REPAIR_BLOCKING_CODES.PROVIDER_TRANSACTION_REFERENCE_AMBIGUOUS,
          'A provider transaction reference exists on this row, so non-execution cannot be proven.',
        );
      }
      if (!digest.failureReasonPresent) {
        block(
          PAYOUT_REPAIR_BLOCKING_CODES.FAILURE_EVIDENCE_MISSING,
          'No failure evidence is recorded on the row; the refusal cannot be corroborated.',
        );
      }
      // F1 / F7 — the decisive gate. `rejected` alone is never enough.
      if (refusalProblem) {
        block(refusalProblem.code, refusalProblem.reason);
      }
    }

    // --- 5. CORROBORATING RECORDS ------------------------------------------
    if (ambiguousAudit.length > 0) {
      const batchScoped = ambiguousAudit.filter((a) => isBatchScoped(a.action));
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.AUDIT_EVIDENCE_AMBIGUOUS,
        `${ambiguousAudit.length} audit record(s) name this row, its batch, or cannot be excluded ` +
          'from it, with an inconclusive, in-flight, completed or unresolved outcome' +
          (batchScoped.length > 0
            ? ` (${batchScoped.length} batch-scoped provider-verification event(s)).`
            : '.'),
      );
    }
    if (priorRepairAudit.length > 0) {
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.ALREADY_REPAIRED,
        'An audit record shows this row was already repaired once.',
      );
    }

    // --- 6. FIELD SANITY ----------------------------------------------------
    if (!row.phone_or_till || String(row.phone_or_till).trim() === '') {
      block(PAYOUT_REPAIR_BLOCKING_CODES.DESTINATION_MISSING, 'The ledger row has no payout destination.');
    }
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      block(PAYOUT_REPAIR_BLOCKING_CODES.AMOUNT_INVALID, 'The ledger row amount is not a positive number.');
    }

    // --- 7. SIBLING LEGS OF THE SAME ROLE -----------------------------------
    if (siblings.some((l) => l?.status === 'completed')) {
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.DUPLICATE_LEG_ALREADY_COMPLETED,
        'Another payout leg of the same role for this claim is already completed.',
      );
    }
    if (siblings.some((l) => isSubmittableSibling(l))) {
      block(
        PAYOUT_REPAIR_BLOCKING_CODES.CONFLICTING_LEDGER_STATE,
        'Another live, submittable payout leg of the same role exists for this claim.',
      );
    }
  }

  const eligible = codes.length === 0;
  return {
    eligible,
    operation: eligible ? 'release_rejected_leg' : null,
    fromStatus: row?.status ?? null,
    fromOutcome: row?.payout_outcome ?? null,
    toStatus: eligible ? 'pending' : null,
    toOutcome: eligible ? 'not_submitted' : null,
    blockingCodes: codes,
    blockingReasons: reasons,
    evidence: digest,
  };
}

/**
 * A sibling leg that the ordinary submission path would already consider
 * payable. Kept as a local predicate with the SAME two-field rule as
 * `isPayoutSubmittable()` — not a second policy, just a readable filter; the
 * canonical rule itself is never bypassed or re-derived for the target row.
 */
function isSubmittableSibling(row: PayoutRepairLedgerSnapshot | null | undefined): boolean {
  if (!row) return false;
  return row.status === 'pending' && row.payout_outcome === 'not_submitted';
}

// ---------------------------------------------------------------------------
// DERIVED HELPERS
// ---------------------------------------------------------------------------

/** Is this request past its window at `now`? Never inferred from status alone. */
export function isPayoutRepairRequestExpired(
  request: { expires_at?: Date | string | null } | null | undefined,
  now: Date,
): boolean {
  if (!request?.expires_at) return true; // no expiry recorded ⇒ cannot be shown to be valid
  const at = request.expires_at instanceof Date ? request.expires_at : new Date(request.expires_at);
  const ms = at.getTime();
  if (!Number.isFinite(ms)) return true;
  return ms <= now.getTime();
}

/** Expiry for a proposal created at `now` (D3: 24 hours). */
export function payoutRepairExpiryFor(now: Date): Date {
  return new Date(now.getTime() + PAYOUT_REPAIR_PROPOSAL_TTL_MS);
}
