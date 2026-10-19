// PAYOUT REPAIR SERVICE (Phase 1 — payout readiness)
//
// WHAT THIS MODULE IS
// -------------------
// The thin orchestration layer between the two narrowly scoped admin endpoints
// and the data layer:
//
//   endpoint  ->  this service (authorization, validation, error mapping)
//             ->  db.getPayoutRepairEvidence / createPayoutRepairRequest /
//                 confirmPayoutRepairRequest
//             ->  config/payoutRepairPolicy.ts (the ONE eligibility rule)
//
// It is deliberately thin. The decision that matters ("may this row be
// repaired?") is a pure function with no database or clock access, and the
// atomic write is in the data layer's transaction. Duplicating either here
// would create a second place for the rule to drift.
//
// AUTHORIZATION
// -------------
// Two NEW permissions, granted to NO role (see adminPermissions.ts):
//   claims.payout_repair_propose
//   claims.payout_repair_confirm
//
// The endpoint guard enforces them server-side, and `hasPermission` is checked
// AGAIN here, so a future route wired without the guard still cannot reach the
// data layer. `deps.hasPermission` exists only so tests can exercise the
// otherwise-unreachable authorized branch; production always uses the real
// resolver, which grants these to nobody today.
//
// WHAT THIS MODULE CANNOT DO
// --------------------------
// No provider call, no payout submission, no money movement, no arbitrary
// ledger write. Confirmation's only state change is the one transition encoded
// by the table's CHECK constraints, applied by the data layer's CAS.

import crypto from 'crypto';
import { db } from '../db/database.ts';
import { ADMIN_PERMISSIONS, adminHasPermission } from './adminPermissions.ts';
import {
  evaluatePayoutRepairEligibility,
  isPayoutRepairRequestExpired,
  payoutRepairExpiryFor,
  payoutRepairRequestFingerprint,
  payoutRowFingerprint,
  type PayoutRepairEligibility,
} from '../config/payoutRepairPolicy.ts';

/**
 * Stable result codes. These are the API contract: the endpoints return them
 * verbatim, so they are never reworded, and they never contain a destination,
 * amount or personal data.
 */
export const PAYOUT_REPAIR_RESULT_CODES = {
  PROPOSED: 'PROPOSED',
  CONFIRMED: 'CONFIRMED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_LEDGER_ENTRY_ID: 'INVALID_LEDGER_ENTRY_ID',
  INVALID_REASON: 'INVALID_REASON',
  INVALID_REQUEST_ID: 'INVALID_REQUEST_ID',
  MISSING_ACTOR: 'MISSING_ACTOR',
  NOT_FOUND: 'NOT_FOUND',
  INELIGIBLE: 'INELIGIBLE',
  EXPIRED: 'EXPIRED',
  SELF_CONFIRMATION_FORBIDDEN: 'SELF_CONFIRMATION_FORBIDDEN',
  ALREADY_CONFIRMED: 'ALREADY_CONFIRMED',
  REQUEST_NOT_OPEN: 'REQUEST_NOT_OPEN',
  REQUEST_TAMPERED: 'REQUEST_TAMPERED',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  STALE_TARGET_STATE: 'STALE_TARGET_STATE',
  DUPLICATE_OPEN_REQUEST: 'DUPLICATE_OPEN_REQUEST',
  WRITE_FAILED: 'WRITE_FAILED',
} as const;

export interface PayoutRepairActor {
  /** The authenticated administrator's username, exactly as the audit trail records it. */
  username: string;
  role: string;
}

export interface PayoutRepairServiceDeps {
  /**
   * Data-layer seam. Production omits it and gets the real `db`; a test may
   * supply the same object to prove the service performs authorization and
   * validation BEFORE touching the database.
   */
  database?: {
    getPayoutRepairEvidence: typeof db.getPayoutRepairEvidence;
    getPayoutRepairRequestById: typeof db.getPayoutRepairRequestById;
    createPayoutRepairRequest: typeof db.createPayoutRepairRequest;
    confirmPayoutRepairRequest: typeof db.confirmPayoutRepairRequest;
  };
  /** Permission seam. Production omits it and gets the real resolver. */
  hasPermission?: (user: any, permission: string) => boolean;
  /** Clock seam. Production omits it; tests pin the 24-hour boundary. */
  now?: () => Date;
}

export interface PayoutRepairProposalResult {
  ok: boolean;
  code: string;
  requestId?: string;
  expiresAt?: string;
  eligibility?: PayoutRepairEligibility;
  message?: string;
}

export interface PayoutRepairConfirmationResult {
  ok: boolean;
  code: string;
  requestId?: string;
  confirmedBy?: string;
  eligibility?: PayoutRepairEligibility;
  message?: string;
}

// ---------------------------------------------------------------------------
// INPUT VALIDATION
// ---------------------------------------------------------------------------
// Every value is untrusted. Identifiers use the same charset policy as the
// Claims Administration routes (`repositoryId`): letters, digits, `_ . : -`
// and at most 50 characters — enough for every real id, and none of the
// characters that make injection or path-shaped payloads interesting.

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,50}$/;
const REPAIR_REQUEST_PATTERN = /^RPR-[A-Za-z0-9]{1,46}$/;

export function normalizeLedgerEntryId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return IDENTIFIER_PATTERN.test(value) ? value : null;
}

export function normalizeRepairRequestId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return REPAIR_REQUEST_PATTERN.test(value) ? value : null;
}

/**
 * The operator's reason. Length-bounded on purpose: long enough to record the
 * evidence an administrator relied on, short enough not to become a place to
 * paste a whole provider statement (which the audit trail must not absorb).
 */
export function normalizeRepairReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length < 10 || value.length > 1000) return null;
  return value;
}

function normalizeActor(actor: PayoutRepairActor | null | undefined): PayoutRepairActor | null {
  if (!actor || typeof actor.username !== 'string') return null;
  const username = actor.username.trim();
  if (username.length === 0 || username.length > 100) return null;
  if (typeof actor.role !== 'string' || actor.role.length === 0) return null;
  return { username, role: actor.role };
}

/**
 * Authorization for BOTH operations. `role === 'admin'` is required as well as
 * the permission, mirroring `requireAdminPermission`: a token whose role is
 * `admin_pending_2fa` (or an agent/customer token) must never satisfy a repair
 * permission, independent of any grant table.
 */
function isAuthorized(
  actor: PayoutRepairActor,
  permission: string,
  hasPermission: (user: any, permission: string) => boolean,
): boolean {
  if (actor.role !== 'admin') return false;
  return hasPermission(actor, permission) === true;
}

// ---------------------------------------------------------------------------
// PROPOSE
// ---------------------------------------------------------------------------

/**
 * Record an audited proposal to release ONE rejected payout leg.
 *
 * ORDER, and why it matters:
 *   1. validate the actor + inputs (no database call for malformed input);
 *   2. authorize (no database call is made for an unauthorized caller — a
 *      refusal must not even reveal whether a ledger row exists);
 *   3. read the evidence and apply the pure rule;
 *   4. only when ELIGIBLE, insert the proposal + its audit row.
 *
 * An ineligible row is never inserted, so no "maybe later" request can sit in
 * the table waiting for a state change to make it confirmable. The refusal
 * carries the complete, PII-free list of blocking reasons.
 */
export async function proposePayoutRepair(
  input: { ledgerEntryId: unknown; reason: unknown; actor: PayoutRepairActor | null | undefined },
  deps: PayoutRepairServiceDeps = {},
): Promise<PayoutRepairProposalResult> {
  const database = deps.database ?? db;
  const hasPermission = deps.hasPermission ?? adminHasPermission;
  const now = deps.now ? deps.now() : new Date();

  const actor = normalizeActor(input?.actor);
  if (!actor) return { ok: false, code: PAYOUT_REPAIR_RESULT_CODES.MISSING_ACTOR };

  if (!isAuthorized(actor, ADMIN_PERMISSIONS.CLAIMS_PAYOUT_REPAIR_PROPOSE, hasPermission)) {
    return { ok: false, code: PAYOUT_REPAIR_RESULT_CODES.FORBIDDEN };
  }

  const ledgerEntryId = normalizeLedgerEntryId(input?.ledgerEntryId);
  if (!ledgerEntryId) {
    return { ok: false, code: PAYOUT_REPAIR_RESULT_CODES.INVALID_LEDGER_ENTRY_ID };
  }
  const reason = normalizeRepairReason(input?.reason);
  if (!reason) return { ok: false, code: PAYOUT_REPAIR_RESULT_CODES.INVALID_REASON };

  let evidence;
  try {
    evidence = await database.getPayoutRepairEvidence(ledgerEntryId);
  } catch {
    return { ok: false, code: PAYOUT_REPAIR_RESULT_CODES.WRITE_FAILED, message: 'Evidence could not be read.' };
  }

  const eligibility = evaluatePayoutRepairEligibility(evidence);
  if (!eligibility.eligible || !evidence.ledgerEntry) {
    return {
      ok: false,
      code: PAYOUT_REPAIR_RESULT_CODES.INELIGIBLE,
      eligibility,
      message: 'The payout row is not eligible for an audited repair. See blockingCodes.',
    };
  }

  const row = evidence.ledgerEntry;
  const expiresAt = payoutRepairExpiryFor(now);
  const requestId = `RPR-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
  const rowFingerprint = payoutRowFingerprint(row);
  const requestFingerprint = payoutRepairRequestFingerprint({
    id: requestId,
    ledger_entry_id: row.id,
    claim_id: row.claim_id ?? null,
    entry_type: String(row.type),
    repair_operation: 'release_rejected_leg',
    from_status: row.status,
    from_payout_outcome: row.payout_outcome,
    to_status: 'pending',
    to_payout_outcome: 'not_submitted',
    reason,
    row_fingerprint: rowFingerprint,
    proposed_by: actor.username,
    expires_at: expiresAt,
  });

  const created = await database.createPayoutRepairRequest({
    requestId,
    ledgerEntryId: row.id,
    claimId: row.claim_id ?? null,
    entryType: String(row.type),
    fromStatus: String(row.status),
    fromPayoutOutcome: row.payout_outcome ?? null,
    toStatus: 'pending',
    toPayoutOutcome: 'not_submitted',
    reason,
    // Structured, PII-free: the digest contains a MASKED destination only.
    evidenceJson: JSON.stringify({
      policy: 'payout-repair-v1',
      decision: 'eligible',
      blockingCodes: eligibility.blockingCodes,
      evidence: eligibility.evidence,
    }),
    rowFingerprint,
    requestFingerprint,
    proposedBy: actor.username,
    now,
    expiresAt,
    auditCorrelationId: requestId,
  });

  if (!created.ok) {
    return { ok: false, code: created.code };
  }
  return {
    ok: true,
    code: PAYOUT_REPAIR_RESULT_CODES.PROPOSED,
    requestId,
    expiresAt: expiresAt.toISOString(),
    eligibility,
  };
}

// ---------------------------------------------------------------------------
// CONFIRM
// ---------------------------------------------------------------------------

/**
 * Confirm another administrator's proposal.
 *
 * THIS FUNCTION PERFORMS NO DECISION OF ITS OWN beyond authorization and input
 * validation: the data layer re-reads everything, re-applies the same pure rule
 * and applies the single CAS inside one transaction. That is deliberate — a
 * second opinion here could only ever disagree with the transaction that
 * actually writes.
 *
 * The proposer/confirmer separation is checked twice: a cheap pre-read here (so
 * the caller gets the specific SELF_CONFIRMATION_FORBIDDEN code without a write
 * attempt) and again inside the transaction, where it is authoritative.
 */
export async function confirmPayoutRepair(
  input: { requestId: unknown; actor: PayoutRepairActor | null | undefined },
  deps: PayoutRepairServiceDeps = {},
): Promise<PayoutRepairConfirmationResult> {
  const database = deps.database ?? db;
  const hasPermission = deps.hasPermission ?? adminHasPermission;
  const now = deps.now ? deps.now() : new Date();

  const actor = normalizeActor(input?.actor);
  if (!actor) return { ok: false, code: PAYOUT_REPAIR_RESULT_CODES.MISSING_ACTOR };

  if (!isAuthorized(actor, ADMIN_PERMISSIONS.CLAIMS_PAYOUT_REPAIR_CONFIRM, hasPermission)) {
    return { ok: false, code: PAYOUT_REPAIR_RESULT_CODES.FORBIDDEN };
  }

  const requestId = normalizeRepairRequestId(input?.requestId);
  if (!requestId) return { ok: false, code: PAYOUT_REPAIR_RESULT_CODES.INVALID_REQUEST_ID };

  // Cheap pre-read for a specific refusal code. The transaction re-checks this;
  // nothing here is authoritative.
  let existing: any = null;
  try {
    existing = await database.getPayoutRepairRequestById(requestId);
  } catch {
    return { ok: false, code: PAYOUT_REPAIR_RESULT_CODES.WRITE_FAILED, message: 'The request could not be read.' };
  }
  if (!existing) return { ok: false, code: PAYOUT_REPAIR_RESULT_CODES.NOT_FOUND };
  // F3 — an EXPIRED proposal is cleaned up by the transaction (and reported as
  // EXPIRED), even when the proposer is the caller. Returning the specific
  // self-confirmation code first would leave the row trapped as 'proposed'.
  if (
    !isPayoutRepairRequestExpired(existing, now) &&
    String(existing.proposed_by) === actor.username
  ) {
    return { ok: false, code: PAYOUT_REPAIR_RESULT_CODES.SELF_CONFIRMATION_FORBIDDEN, requestId };
  }

  const result = await database.confirmPayoutRepairRequest({
    requestId,
    confirmer: actor.username,
    now,
  });

  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      requestId,
      eligibility: result.eligibility,
      message: result.detail,
    };
  }
  return {
    ok: true,
    code: PAYOUT_REPAIR_RESULT_CODES.CONFIRMED,
    requestId,
    confirmedBy: actor.username,
    eligibility: result.eligibility,
  };
}
