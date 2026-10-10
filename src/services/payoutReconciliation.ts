// ============================================================================
// BATCH 1 — PROVIDER-VERIFIED PAYOUT CONFIRMATION (orchestration only)
// ============================================================================
//
// THE PROBLEM THIS MODULE CLOSES
//
// `executeClaimSettlement()` (server.ts) submits finder/agent payouts and can
// only ever record them as unresolved — IntaSend ACCEPTING a batch is not the
// same as the individual M-Pesa B2C transfers having settled. Nothing then
// turned those accepted rows into confirmed ones, so a real payout that had
// genuinely completed at the provider sat unresolved forever and
// `finalizeSettlement()` refused the claim permanently.
//
// WHAT THIS MODULE IS
//
// The ONE path that may mark a payout leg completed from PROVIDER EVIDENCE:
//   1. ask the provider (authoritatively) what happened to the batch;
//   2. classify each per-transaction status into a verdict;
//   3. bind each completed transaction to EXACTLY ONE local ledger leg by
//      (provider_batch_id, provider_transaction_id);
//   4. hand that leg to a compare-and-swap that can only complete a row which
//      positively recorded a still-unresolved submission.
//
// WHAT THIS MODULE IS NOT — READ THIS BEFORE CHANGING IT
//
//   * It never submits, resubmits, approves, cancels or refunds anything. It
//     does not import triggerIntasendPayout, executeClaimSettlement,
//     finalizeSettlement or any approval/settlement transition, and a
//     source-invariant test pins that.
//   * It never finalises a settlement. Completing the LAST leg of a batch does
//     NOT release the claim: `finalizeSettlement()` keeps its own
//     "every leg confirmed?" guard and `executeClaimSettlement()` keeps its
//     unresolved-payout check, so settlement still requires every leg to be
//     verified AND the ordinary approval/lock path.
//   * It never retries. A 'failed'/'cancelled' verdict leaves the row
//     unresolved; it does not make it submittable again (the retry rule in
//     config/payoutOutcomes.ts is untouched).
//   * A webhook is a TRIGGER only. The callback's own status field is never
//     read as proof: the provider lookup above is the evidence.
//
// FAIL-CLOSED BY CONSTRUCTION
//
// Every failure mode — no credentials, a provider error, an ambiguous status, a
// missing transaction id, a duplicate/out-of-order delivery, an unmatched
// legacy row, a row already resolved, two ids that are not unique — results in
// NOTHING being completed. There is no branch in which an uncertain fact
// completes a payout.

import { db } from '../db/database';
import { PaymentService } from './payments';
import {
  matchPayoutTransactionToLegs,
  type PayoutLegIdentity,
  type PayoutTransactionVerdict,
} from '../config/payoutOutcomes';

/** The provider-lookup view this module consumes. Structurally typed for stubbing. */
export interface PayoutBatchStatusView {
  verified: boolean;
  reason: string;
  providerTrackingId: string | null;
  transactions: Array<{
    transactionId: string | null;
    providerStatus: string | null;
    verdict: PayoutTransactionVerdict;
  }>;
}

/** Why a provider transaction was NOT turned into a completed leg. */
export type PayoutSkipReason =
  | 'provider_verdict_not_completed'
  | 'unmatched_provider_transaction'
  | 'leg_not_confirmable';

export interface PayoutReconciliationResult {
  /** The provider was asked AND answered about this batch. */
  handled: boolean;
  reason: string;
  /** The batch the provider actually answered about, when it was verified. */
  providerTrackingId: string | null;
  /** Leg ids THIS call completed (never ids that were already completed). */
  confirmedLegIds: string[];
  /**
   * Legs of this batch that are still NOT completed after this call — captured
   * before the call, minus whatever it just confirmed. A leg that was already
   * completed on entry is not "unresolved".
   */
  unresolvedLegIds: string[];
  /** One entry per provider transaction that did not become a completion. */
  skipped: Array<{
    transactionId: string | null;
    verdict: PayoutTransactionVerdict | null;
    reason: PayoutSkipReason;
  }>;
}

/** The collaborators this orchestration needs. Injected so it is testable. */
export interface PayoutReconciliationPorts {
  lookupBatchStatus: (trackingId: string) => Promise<PayoutBatchStatusView>;
  listLegsByBatchId: (
    trackingId: string,
  ) => Promise<Array<PayoutLegIdentity & { status?: string | null; payout_outcome?: string | null }>>;
  confirmVerified: (
    legId: string,
    ids: { providerBatchId: string; providerTransactionId: string },
  ) => Promise<boolean>;
  audit: (action: string, details: string) => Promise<void>;
}

/**
 * The production collaborators: the real provider lookup, the real ledger read,
 * the real CAS and the real audit log. Held as a value so the module can be
 * exercised end-to-end with stubs — no network and no database at all.
 */
export const payoutReconciliationPorts: PayoutReconciliationPorts = {
  lookupBatchStatus: (trackingId) => PaymentService.fetchIntasendPayoutBatchStatus(trackingId),
  listLegsByBatchId: (trackingId) => db.getPayoutLegsByProviderBatchId(trackingId),
  confirmVerified: (legId, ids) =>
    db.confirmPayoutVerified(legId, {
      providerBatchId: ids.providerBatchId,
      providerTransactionId: ids.providerTransactionId,
      failureReason: null,
    }),
  audit: (action, details) => db.logAudit('SYSTEM', action, details),
};

/**
 * Verify ONE payout batch against the provider, and complete ONLY the legs the
 * provider authoritatively reports as done.
 *
 * The return value is a report, not a promise: `confirmedLegIds` are the only
 * rows this call changed, and everything else is enumerated in `skipped` with a
 * stable reason so an operator (and a test) can see exactly why nothing else
 * moved.
 *
 * Ordering and idempotency:
 *   * The provider is asked FIRST; a lookup that is not `verified` writes only
 *     an audit line and completes nothing.
 *   * Each transaction is evaluated independently, so a partially-completed
 *     batch completes exactly the legs that are done and leaves the rest.
 *   * The confirmation is a compare-and-swap, so a duplicate or out-of-order
 *     delivery of the same event finds the row no longer in a confirmable state
 *     and changes nothing.
 */
export async function reconcilePayoutBatchStatus(
  trackingId: string,
  ports: PayoutReconciliationPorts = payoutReconciliationPorts,
): Promise<PayoutReconciliationResult> {
  const trimmed = String(trackingId || '').trim();

  const report = (
    handled: boolean,
    reason: string,
    extra: Partial<PayoutReconciliationResult> = {},
  ): PayoutReconciliationResult => ({
    handled,
    reason,
    providerTrackingId: null,
    confirmedLegIds: [],
    unresolvedLegIds: [],
    skipped: [],
    ...extra,
  });

  if (!trimmed) return report(false, 'missing_tracking_id');

  // ---- 1. THE PROVIDER IS THE AUTHORITY ------------------------------------
  const status = await ports.lookupBatchStatus(trimmed);
  if (!status || !status.verified) {
    const reason = (status && status.reason) || 'provider_status_unverified';
    // An unverifiable lookup is not an error the caller can act on — it is
    // simply not evidence. Nothing but the audit trail is written.
    await ports.audit(
      'PAYOUT_VERIFICATION_UNVERIFIED',
      `Payout batch ${trimmed}: provider status could not be verified (${reason}). No payout leg was changed.`,
    );
    return report(false, reason);
  }

  const legs = await ports.listLegsByBatchId(trimmed);
  const result = report(true, status.reason || 'provider_status_retrieved', {
    providerTrackingId: status.providerTrackingId,
  });

  if (legs.length === 0) {
    // A verified batch with no local legs means our records do not carry the
    // batch id — e.g. a legacy row whose provider_batch_id is NULL. Nothing can
    // be bound, so nothing is completed.
    await ports.audit(
      'PAYOUT_VERIFICATION_NO_LOCAL_LEGS',
      `Payout batch ${trimmed}: provider verified the batch but no local ledger leg carries this batch id. Nothing was changed — including for any legacy row that has no batch id recorded.`,
    );
    return result;
  }

  // ---- 2. PER-TRANSACTION VERDICT + EXACT BINDING -------------------------
  for (const transaction of status.transactions) {
    // A non-completed verdict is NOT a completion. It is deliberately NOT turned
    // into a local 'failed'/'rejected' transition either: that would touch the
    // retry vocabulary this batch must not alter.
    if (transaction.verdict !== 'completed') {
      result.skipped.push({
        transactionId: transaction.transactionId,
        verdict: transaction.verdict,
        reason: 'provider_verdict_not_completed',
      });
      continue;
    }

    const legId = matchPayoutTransactionToLegs(
      { batchId: status.providerTrackingId, transactionId: transaction.transactionId },
      legs,
    );

    if (legId === null) {
      // Zero matches (an unmatched or legacy row) or more than one (ids that are
      // not unique among this batch's legs). Both are refusals: an ambiguous
      // provider report must never complete a payout, and choosing a leg would
      // be exactly that guess.
      result.skipped.push({
        transactionId: transaction.transactionId,
        verdict: transaction.verdict,
        reason: 'unmatched_provider_transaction',
      });
      await ports.audit(
        'PAYOUT_VERIFICATION_UNMATCHED',
        `Payout batch ${trimmed}: provider reported transaction ${transaction.transactionId || '(none)'} completed, but it does not match exactly ONE local payout leg. Refusing to confirm; operator reconciliation required.`,
      );
      continue;
    }

    const won = await ports.confirmVerified(legId, {
      providerBatchId: status.providerTrackingId as string,
      providerTransactionId: transaction.transactionId as string,
    });

    if (won) {
      result.confirmedLegIds.push(legId);
      await ports.audit(
        'PAYOUT_VERIFIED_COMPLETED',
        `Payout batch ${trimmed}: ledger leg ${legId} confirmed completed from the authoritative provider status for transaction ${transaction.transactionId}.`,
      );
    } else {
      // The CAS lost: the row was already resolved, or it is in a state that
      // positively says no submission was ever made, or its history is NULL
      // (a legacy row). Losing the CAS is the guard working, not an error.
      result.skipped.push({
        transactionId: transaction.transactionId,
        verdict: transaction.verdict,
        reason: 'leg_not_confirmable',
      });
      await ports.audit(
        'PAYOUT_VERIFICATION_LEG_NOT_CONFIRMABLE',
        `Payout batch ${trimmed}: provider reports transaction ${transaction.transactionId} completed, but ledger leg ${legId} is not in a confirmable state (already resolved, never submitted, or unknown history). Left unchanged for operator review.`,
      );
    }
  }

  result.unresolvedLegIds = legs
    .filter((leg) => leg.status !== 'completed' && !result.confirmedLegIds.includes(leg.id))
    .map((leg) => leg.id);

  // NO settlement finalisation, NO resubmission, NO approval, NO cancellation
  // here. Completing every leg of a batch only makes the claim eligible for the
  // ordinary settlement path, which re-checks every leg for itself.
  return result;
}
