// Payout submission-outcome vocabulary (E3A) — pure data, no imports, so it can
// be used by the schema definitions, the data layer and the settlement executor
// without a circular import.
//
// WHY THIS EXISTS AT ALL
// ----------------------
// The ledger's `status` column ('pending' | 'completed' | 'failed') cannot
// express the one distinction that decides whether re-sending a payout is safe:
// whether a provider submission was ever made for this row, and what the
// provider did with it. Before this, `recordPayoutAttempt()` collapsed three
// genuinely different provider outcomes into the single value 'pending':
//
//   * a provider ACCEPTED the batch and the individual B2C transfer had not
//     been confirmed yet;
//   * a network/timeout exception meant we did not know whether the provider
//     received or executed the request at all;
//   * the row had simply never been submitted.
//
// The settlement executor then treated every 'pending' row as eligible for
// submission, so an accepted-or-uncertain transfer whose process died (or whose
// sibling leg failed) was re-sent to the provider on the next sweep. That is a
// duplicate-transfer risk, and it is the defect this vocabulary closes.
//
// The vocabulary is deliberately a SEPARATE column (`ledger.payout_outcome`)
// rather than new values in `ledger.status`: `status` is read by the admin
// dashboard, the agent-earnings figures, `finalizeSettlement()`'s
// "still outstanding?" guard and existing tests, and none of those meanings
// change here.

/**
 * The complete `ledger.payout_outcome` vocabulary. Kept in lockstep with:
 *   sql/schema.sql            (the inline column CHECK, table `ledger`)
 *   src/db/schema.ts          (the column and its named CHECK)
 *   src/db/index.ts           (the runtime ADD COLUMN / DROP+ADD CONSTRAINT)
 *
 * NULL is also legal and is NOT in this list: it means "no submission history
 * was ever recorded for this row" (every row written before this batch, plus
 * non-provider rows such as `platform_fee`). NULL is treated as UNRESOLVED, not
 * as "never submitted" — see isPayoutSubmittable().
 */
export const PAYOUT_OUTCOME_VALUES = [
  /** Booked and never submitted to a provider — the normal new-payout state. */
  'not_submitted',
  /**
   * A durable pre-submission marker was persisted and the provider call was
   * about to be (or was) issued, but no result was ever recorded. The process
   * may have died mid-call. UNRESOLVED: must never be auto-resubmitted.
   */
  'submitting',
  /**
   * The provider returned an acceptance-like response. Acceptance is NOT
   * completion: the individual transfer has not been authoritatively
   * confirmed. UNRESOLVED.
   */
  'accepted',
  /**
   * Timeout, transport failure, malformed response, or a provider 5xx — the
   * request may already have been executed. UNRESOLVED.
   */
  'unknown',
  /**
   * Reliable evidence that THIS attempt was refused before execution (a 4xx
   * provider rejection, excluding 408). No transfer happened. Not retried
   * automatically in this batch — see isPayoutSubmittable().
   */
  'rejected',
  /** Authoritative evidence that the transfer completed. Terminal. */
  'completed',
] as const;

export type PayoutOutcome = (typeof PAYOUT_OUTCOME_VALUES)[number];

/**
 * SQL fragment for the CHECK constraint, generated from the single list above
 * so the Drizzle definition, sql/schema.sql and the runtime DDL cannot drift
 * apart (the same single-source pattern used by CLAIM_SLOT_EXCLUDED_SQL_LIST
 * and lostReportStatuses).
 */
export const PAYOUT_OUTCOME_SQL_LIST = PAYOUT_OUTCOME_VALUES.map((v) => `'${v}'`).join(', ');

/**
 * Outcomes that mean "this row may already have moved money, and we cannot
 * prove otherwise". A row in any of these states is NEVER submitted again by
 * automatic retry; it stays visible for provider reconciliation.
 */
export const UNRESOLVED_PAYOUT_OUTCOMES: readonly PayoutOutcome[] = ['submitting', 'accepted', 'unknown'];

export function isPayoutOutcome(value: unknown): value is PayoutOutcome {
  return typeof value === 'string' && (PAYOUT_OUTCOME_VALUES as readonly string[]).includes(value);
}

/** May this row's transfer have been executed without us knowing? */
export function isUnresolvedPayoutOutcome(value: unknown): boolean {
  return typeof value === 'string' && (UNRESOLVED_PAYOUT_OUTCOMES as readonly string[]).includes(value);
}

/**
 * The MINIMAL shape needed to decide payout retry eligibility. Structural
 * typing (rather than importing LedgerEntry) keeps this module dependency-free
 * so schema.ts can import it.
 */
export interface PayoutSubmissionState {
  status?: string | null;
  payout_outcome?: string | null;
}

/**
 * THE retry-eligibility rule, in one place.
 *
 * A row may be sent to the provider ONLY when:
 *   1. it is still bookable (`status === 'pending'` — a 'completed' row is
 *      never re-sent, and a 'failed' row is not silently retried), AND
 *   2. its submission history is positively recorded as "never submitted"
 *      (`payout_outcome === 'not_submitted'`).
 *
 * Every other value fails CLOSED:
 *   'submitting' | 'accepted' | 'unknown' — may already have moved money.
 *   'rejected'                            — the provider refused it; retrying
 *                                           needs an explicit, evidence-based
 *                                           policy, which this batch does not
 *                                           introduce.
 *   'completed'                           — already paid.
 *   NULL                                  — legacy/unknown history. We cannot
 *                                           prove this row was never submitted,
 *                                           so we must not resubmit it.
 */
export function isPayoutSubmittable(row: PayoutSubmissionState | null | undefined): boolean {
  if (!row) return false;
  return row.status === 'pending' && row.payout_outcome === 'not_submitted';
}

/**
 * A payout row that is still unresolved: not confirmed completed, and NOT
 * eligible for another automatic submission. These are the rows an operator has
 * to reconcile against the provider — the ones that must never be silently
 * forgotten, and never be silently re-sent.
 */
export function isUnresolvedPayoutRow(row: PayoutSubmissionState | null | undefined): boolean {
  if (!row) return false;
  if (row.status === 'completed') return false;
  return !isPayoutSubmittable(row);
}
