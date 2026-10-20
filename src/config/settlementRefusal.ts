// =============================================================================
// PHASE 3 — TRUTHFUL SETTLEMENT REFUSALS
// =============================================================================
// Every settlement refusal gets ONE stable machine code and one operator-facing
// message + next action. The rules this module exists to enforce:
//
//   * NEVER report success without evidence. A payout is "submitted", never
//     "paid"; only a completed ledger row proves money moved.
//   * NEVER promise an automatic retry. `automatic_retry` is always false and
//     every message says what an operator must verify or do.
//   * NEVER collapse an ambiguous provider outcome into "failed": a timeout, a
//     5xx or a legacy row with no history may already have moved money.
//
// Pure: no I/O, no provider, no database.
// =============================================================================

import type { PayoutOutcome } from './payoutOutcomes';

export type SettlementRefusalCode =
  | 'claim_not_found'
  | 'claim_data_unreadable'
  | 'item_missing'
  | 'agent_missing'
  | 'category_missing'
  | 'payout_paused'
  | 'claim_not_pending_settlement'
  | 'settlement_already_in_flight'
  | 'durable_approval_missing'
  | 'settlement_window_open'
  | 'release_lock_lost'
  | 'release_state_changed'
  | 'approval_snapshot_mismatch'
  | 'approval_snapshot_unreadable'
  | 'payout_rows_missing'
  | 'payout_rows_unreadable'
  | 'ledger_amount_mismatch'
  | 'ledger_destination_mismatch'
  | 'destination_not_eligible'
  | 'payout_outcome_unresolved'
  | 'submission_history_unknown'
  | 'provider_refused'
  | 'provider_accepted_unconfirmed'
  | 'provider_outcome_ambiguous'
  | 'payout_already_sent'
  | 'no_submittable_payout'
  | 'simulation_not_permitted'
  | 'disbursement_wallet_missing'
  | 'wallet_routing_refused'
  | 'item_on_hold'
  | 'payout_recording_failed'
  | 'internal_error';

export interface SettlementRefusal {
  code: SettlementRefusalCode;
  operator_message: string;
  next_action: string;
  /** Always false: this platform never retries a payout on a timer. */
  automatic_retry: false;
  /** True only when repeating the SAME action after a fix can help. */
  retry_after_fix: boolean;
}

interface CatalogEntry {
  operator_message: string;
  next_action: string;
  retry_after_fix: boolean;
}

const CATALOG: Record<SettlementRefusalCode, CatalogEntry> = {
  claim_not_found: {
    operator_message: 'The claim could not be found, so no settlement decision was made.',
    next_action: 'Reload the claims list and confirm the claim still exists before trying again.',
    retry_after_fix: true,
  },
  claim_data_unreadable: {
    operator_message: 'The claim or a record it depends on could not be read, so the payout was not submitted.',
    next_action: 'Refresh the claim. If the data is still incomplete, review the item, its category and the assigned agent before initiating again.',
    retry_after_fix: true,
  },
  item_missing: {
    operator_message: 'The item for this claim no longer exists, so the payout destination and booked shares cannot be verified.',
    next_action: 'Escalate to a data review. Do not create a payout manually.',
    retry_after_fix: false,
  },
  agent_missing: {
    operator_message: 'The agent assigned to this item could not be resolved, so the agent payout leg cannot be verified.',
    next_action: 'Restore or review the item assignment before initiating the settlement again.',
    retry_after_fix: true,
  },
  category_missing: {
    operator_message: 'The category for this item could not be resolved, so the payout amounts cannot be computed or verified.',
    next_action: 'Assign a valid category to the item, then review the booked payout rows before initiating again.',
    retry_after_fix: true,
  },
  payout_paused: {
    operator_message: 'Payouts are paused platform-wide by an administrator, so nothing was submitted.',
    next_action: 'Resume payouts in the console, then initiate this approved payout again. It is not retried automatically.',
    retry_after_fix: true,
  },
  claim_not_pending_settlement: {
    operator_message: 'The claim is not in pending settlement, so it is not eligible for payout initiation.',
    next_action: 'Reload the claim and check its current status before deciding what to do. Do not resubmit a payout that may already have been sent.',
    retry_after_fix: false,
  },
  settlement_already_in_flight: {
    operator_message: 'A settlement attempt is already in flight for this claim, so this request was not started.',
    next_action: 'Wait for the in-flight attempt to finish and refresh the ledger. Do not start a second attempt.',
    retry_after_fix: true,
  },
  durable_approval_missing: {
    operator_message: 'No durable administrator approval is recorded for this claim, so the payout was not submitted.',
    next_action: 'Record the settlement approval, or use the combined approve-and-pay action, after checking the payout details.',
    retry_after_fix: true,
  },
  settlement_window_open: {
    operator_message: 'The dispute review window has not elapsed, so the payout was not submitted.',
    next_action: 'Wait until the recorded settle time has passed, then initiate again. Nothing is retried automatically.',
    retry_after_fix: true,
  },
  release_lock_lost: {
    operator_message: 'The settlement release lock was not obtained, so no payout was submitted.',
    next_action: 'Refresh the claim. If it is still pending settlement, initiate again; if it is releasing, wait for the other attempt.',
    retry_after_fix: true,
  },
  release_state_changed: {
    operator_message: 'The claim changed state after the release lock was taken, so the payout was stopped before any provider request.',
    next_action: 'Refresh the claim and review the current state. Verify with the provider before any new attempt if a payout may have been sent.',
    retry_after_fix: false,
  },
  approval_snapshot_mismatch: {
    operator_message: 'The payout rows or total no longer match the settlement approval on file, so no money was sent.',
    next_action: 'Review the claim, its booked payout rows and the approval. A new approval is required before this payout can be initiated.',
    retry_after_fix: true,
  },
  approval_snapshot_unreadable: {
    operator_message: 'The settlement approval on file cannot be read completely, so the payout was refused.',
    next_action: 'A data review of the approval record is required. Do not initiate the payout until it is readable.',
    retry_after_fix: false,
  },
  payout_rows_missing: {
    operator_message: 'No finder or agent payout row is booked for this claim, so there is nothing legitimate to pay.',
    next_action: 'Review how the claim reached pending settlement. Do not create a payout manually.',
    retry_after_fix: false,
  },
  payout_rows_unreadable: {
    operator_message: 'One or more payout rows could not be read unambiguously, so the whole payout was refused.',
    next_action: 'A ledger review is required. No leg of this claim was sent.',
    retry_after_fix: false,
  },
  ledger_amount_mismatch: {
    operator_message: 'The amount this attempt would send does not equal the amount booked on the ledger row, so no leg was sent.',
    next_action: 'Review the item’s locked shares or the category used at booking. Correct the source of the difference; never edit the ledger amount to match a transfer.',
    retry_after_fix: true,
  },
  ledger_destination_mismatch: {
    operator_message: 'The destination this attempt would pay is not the destination booked on the ledger row, so no leg was sent.',
    next_action: 'Review the recipient’s current payout destination against the booked row. The booked row is the record of what was owed.',
    retry_after_fix: true,
  },
  destination_not_eligible: {
    operator_message: 'A required payout destination is not a supported Personal M-Pesa phone number, so the whole payout was refused.',
    next_action: 'Correct the destination (Personal M-Pesa only; no Till, Paybill or Pochi) and review the booked row before initiating again.',
    retry_after_fix: true,
  },
  payout_outcome_unresolved: {
    operator_message: 'A payout row already has a submission outcome that is not completed, so it was not re-sent.',
    next_action: 'Reconcile the row with the provider before any new attempt. Re-sending could move the same money twice.',
    retry_after_fix: false,
  },
  submission_history_unknown: {
    operator_message:
      'No submission history is recorded for this payout row, so this build cannot prove whether the provider executed it.',
    next_action:
      'Do not resend it. Reconcile the row against the provider statement and use the audited payout-repair process only when non-execution is positively evidenced.',
    retry_after_fix: false,
  },
  provider_refused: {
    operator_message: 'The provider refused this transfer. That is a refusal of the request, not proof that no transfer can ever succeed.',
    next_action:
      'Verify the refusal in the provider statement, correct the cause, and use the audited payout-repair process before any new attempt. Nothing is retried automatically.',
    retry_after_fix: false,
  },
  provider_accepted_unconfirmed: {
    operator_message: 'The provider accepted the batch but has not confirmed the individual transfer as complete.',
    next_action: 'Check the provider’s authoritative status for this recipient before doing anything else. Do not resend it.',
    retry_after_fix: false,
  },
  provider_outcome_ambiguous: {
    operator_message: 'The provider outcome is ambiguous (timeout, transport failure or provider error). The transfer may already have been executed.',
    next_action: 'Verify the transaction with the provider before any new attempt. Do not resend it automatically.',
    retry_after_fix: false,
  },
  payout_already_sent: {
    operator_message: 'This payout leg is already recorded as accepted or completed, so it is a reconciliation item, not a new payout.',
    next_action: 'Reconcile the recorded provider reference. Do not initiate a second payout for this leg.',
    retry_after_fix: false,
  },
  no_submittable_payout: {
    operator_message: 'No outstanding payout leg is eligible for submission, so nothing was sent.',
    next_action: 'Review the claim’s payout rows and their outcomes before deciding whether any action is appropriate.',
    retry_after_fix: false,
  },
  simulation_not_permitted: {
    operator_message: 'This deployment has no usable provider credentials, so the payout would have to be simulated, and simulation is not permitted in this environment.',
    next_action: 'Configure real IntaSend credentials, or run locally with NODE_ENV=development/test. A production-like environment must never report a simulated transfer as paid.',
    retry_after_fix: true,
  },
  disbursement_wallet_missing: {
    operator_message: 'The disbursement (working) wallet is not configured in production, so the payout was refused before submission.',
    next_action: 'Configure a non-blank, non-placeholder INTASEND_DISBURSEMENT_WALLET_ID and restart the service.',
    retry_after_fix: true,
  },
  wallet_routing_refused: {
    operator_message: 'The configured payout wallet is unsafe (missing, or the same wallet that receives collections), so the payout was refused.',
    next_action: 'Configure two distinct wallet IDs: a working wallet for payouts and a separate settlement wallet. Then initiate again.',
    retry_after_fix: true,
  },
  item_on_hold: {
    operator_message: 'The item is under a suspected-stolen or legal-hold review, so the payout was stopped before any provider request.',
    next_action: 'Resolve the item review with the responsible administrator. Do not resend the payout while the hold is active.',
    retry_after_fix: true,
  },
  payout_recording_failed: {
    operator_message: 'Every required payout leg is recorded completed, but the claim could not be finalized.',
    next_action: 'Do not resend any payout. An administrator must reconcile the claim in the releasing state manually.',
    retry_after_fix: false,
  },
  internal_error: {
    operator_message: 'The settlement could not be completed because of an internal error.',
    next_action: 'Check the server log for the correlation entry, then reconcile the claim and its ledger rows before any new attempt.',
    retry_after_fix: false,
  },
};


/** Build the one truthful refusal description for a code. */
export function describeSettlementRefusal(
  code: SettlementRefusalCode,
  detail?: string | null,
): SettlementRefusal {
  const entry = CATALOG[code] ?? CATALOG.internal_error;
  const trimmedDetail = typeof detail === 'string' ? detail.trim() : '';
  return {
    code: CATALOG[code] ? code : 'internal_error',
    operator_message: trimmedDetail
      ? `${entry.operator_message} (${trimmedDetail})`
      : entry.operator_message,
    next_action: entry.next_action,
    automatic_retry: false,
    retry_after_fix: entry.retry_after_fix,
  };
}

/** The stable body every settlement refusal route returns. */
export function settlementRefusalBody(code: SettlementRefusalCode, detail?: string | null) {
  const refusal = describeSettlementRefusal(code, detail);
  return {
    reason_code: refusal.code,
    operator_message: refusal.operator_message,
    next_action: refusal.next_action,
    automatic_retry: false as const,
    retry_after_fix: refusal.retry_after_fix,
  };
}

/**
 * Classify an UNRESOLVED payout row by what is actually recorded.
 *
 * The order matters: a completed/accepted row is never described as a failure,
 * and a NULL history is never described as "never submitted".
 */
export function classifyUnresolvedPayoutRow(row: {
  status?: string | null;
  payout_outcome?: PayoutOutcome | null;
}): SettlementRefusalCode {
  const outcome = row?.payout_outcome ?? null;
  if (outcome === 'completed' || outcome === 'accepted') return 'payout_already_sent';
  if (outcome === 'rejected') return 'provider_refused';
  if (outcome === 'submitting') return 'provider_accepted_unconfirmed';
  if (outcome === 'unknown') return 'provider_outcome_ambiguous';
  if (outcome === null || outcome === undefined) return 'submission_history_unknown';
  // `not_submitted` on a row that is unresolved means the local state is
  // inconsistent (e.g. status failed without provider evidence): fail closed.
  return 'payout_outcome_unresolved';
}
