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

// ===========================================================================
// BATCH 1 — PROVIDER-SIDE PAYOUT VERIFICATION (read-only evidence)
// ===========================================================================
//
// Everything below answers ONE question, using the PROVIDER as the authority:
// "may this specific local payout leg be marked completed, because IntaSend
// authoritatively reports that ITS transfer completed?"
//
// It is deliberately pure data + pure functions, and it is deliberately
// SEPARATE from the submission vocabulary above. Nothing here can submit,
// resubmit, approve or cancel anything: the retry rules in
// isPayoutSubmittable() are not modified, relaxed or bypassed by any of it.
//
// WHY A "VERDICT" AND NOT THE RAW PROVIDER STATUS
// ----------------------------------------------
// IntaSend reports a per-transaction status code. Trusting the raw string at
// each call site would spread an unknown-but-incomplete status across the
// codebase and invite a caller to treat "not TF-something" as success. The
// mapping below is therefore the ONE place a provider status code becomes a
// decision, and anything it does not recognize maps to 'unknown' — which every
// caller must read as "do not confirm", never as success.

/**
 * The complete provider-transaction verdict vocabulary. Only 'completed' may
 * ever be treated as money having moved; 'failed'/'cancelled' describe a
 * transfer the provider says did NOT happen (and are deliberately NOT turned
 * into a local retry here); 'in_progress' and 'unknown' are both "not yet
 * knowable" and must never complete a payout.
 */
export type PayoutTransactionVerdict = 'completed' | 'failed' | 'cancelled' | 'in_progress' | 'unknown';

/**
 * IntaSend per-transaction status codes, mapped to a verdict.
 *
 *   TS100         — transaction success.
 *   TF103/105/106 — transaction failed (provider-side failure / rejected).
 *   TC108         — transaction cancelled.
 *   TP / TH / TR  — pending / on hold / retrying: the transfer has NOT settled.
 *
 * Keys are the CODE TOKEN only (see classifyPayoutTransactionStatus, which
 * strips any human-readable suffix such as "TS100 - Success").
 */
const PROVIDER_TRANSACTION_STATUS_VERDICTS: Readonly<Record<string, PayoutTransactionVerdict>> = {
  TS100: 'completed',
  TF103: 'failed',
  TF105: 'failed',
  TF106: 'failed',
  TC108: 'cancelled',
  TP: 'in_progress',
  TH: 'in_progress',
  TR: 'in_progress',
};

/**
 * BATCH 1B — the SUFFIXED forms of the NON-COMPLETING families.
 *
 * IntaSend writes a code as a two-letter family + a three-digit reason
 * (`TS100`, `TP101`, `TF103`, `TC108`) and sometimes emits the bare family
 * token (`TP`). Before Batch 1B only the bare tokens were recognised, so the
 * provider's actual pending code `TP101` fell through to 'unknown'.
 *
 * WHY BROADENING HERE IS SAFE AND NOT A WEAKENING
 *
 * This pattern matches ONLY the pending / on-hold / retrying families, whose
 * verdict is 'in_progress' — a "do not confirm" answer. Every code it can ever
 * match is therefore forced DOWN in severity, never up; there is no input for
 * which it returns 'completed'. The fail-closed property this module exists to
 * provide ("an unrecognised code never completes a payout") is untouched.
 *
 * The SUCCESS family is deliberately excluded from the pattern. `TS100` is the
 * single code that may complete a payout, so it is only ever recognised as the
 * exact literal above — a truncated code (`TS10`), a typo (`TS100X`) or an
 * unknown sibling (`TS101`) all remain 'unknown' and confirm nothing.
 */
const NON_COMPLETING_FAMILY_CODE = /^(TP|TH|TR)\d{3}$/;

/**
 * Normalise ONE provider status value into a verdict. FAIL-CLOSED: anything
 * that is not a recognised code — including a missing value, a number, an
 * object, or a future code this build does not know — becomes 'unknown'.
 *
 * Accepts a code with a human-readable suffix because the provider echoes one
 * (e.g. "TS100 - Success"); the first whitespace/dash/colon-delimited token is
 * the machine code.
 */
export function classifyPayoutTransactionStatus(rawStatus: unknown): PayoutTransactionVerdict {
  if (typeof rawStatus !== 'string') return 'unknown';
  const normalized = rawStatus.trim().toUpperCase();
  if (!normalized) return 'unknown';
  const code = normalized.split(/[\s\-–—:]+/)[0];
  const known = PROVIDER_TRANSACTION_STATUS_VERDICTS[code];
  if (known) return known;
  // The only permitted fallback: the suffixed NON-COMPLETING families, whose
  // verdict is 'in_progress'. `TS` is not among them, so no code can reach
  // 'completed' through this branch.
  return NON_COMPLETING_FAMILY_CODE.test(code) ? 'in_progress' : 'unknown';
}

/**
 * BATCH 1B — WHICH PROVIDER FIELD IS THE STATUS AUTHORITY, AND WHAT IT MEANS.
 *
 * IntaSend returns BOTH a machine-readable code and a human-readable label:
 *
 *   { "status_code": "TS100", "status": "Successful" }
 *
 * The CODE is the contract; the label is presentation, and the provider is free
 * to reword it. Reading the label first — which is what this build did before
 * Batch 1B — meant `TS100` was never seen at all, so a transfer the provider had
 * genuinely completed classified as 'unknown' and its payout leg stayed
 * unresolved forever (and the settlement that depended on it never released).
 * The code therefore WINS whenever it is present and usable.
 *
 * THE FALLBACK, AND WHY IT IS STILL FAIL-CLOSED
 *
 * `status` is read only when `status_code` is absent, blank, or not a string.
 * That covers a provider revision that renames or omits the code field — and,
 * because classification matches the CODE SHAPE rather than the field name, a
 * response that puts `"TS100"` in `status` still classifies correctly.
 *
 * The case worth stating explicitly is a HUMAN-READABLE-ONLY response, e.g.
 * `{ "status": "Successful" }`. "Successful" is not in the code table, so it
 * resolves to 'unknown' and CANNOT complete a payout. That is the intended safe
 * fallback: a rewordable label is not authoritative evidence that money moved,
 * and no reworded label may ever be turned into a completion here.
 *
 * Returns the chosen raw string alongside the verdict so both come from ONE
 * read. A missing or malformed pair yields `{ providerStatus: null, verdict:
 * 'unknown' }`.
 */
export function readProviderTransactionStatus(
  entry: unknown,
): { providerStatus: string | null; verdict: PayoutTransactionVerdict } {
  const providerStatus = pickProviderStatusField(entry);
  return { providerStatus, verdict: classifyPayoutTransactionStatus(providerStatus) };
}

/** A non-blank string, trimmed. Anything else (absent, blank, non-string) counts as "no status". */
function usableProviderStatusString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The status FIELD precedence rule, in exactly one place: `status_code` first,
 * `status` only as the documented fallback. Not exported — it exists so the
 * precedence cannot be re-implemented (and drift) at a call site.
 */
function pickProviderStatusField(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  return (
    usableProviderStatusString(record.status_code) ??
    usableProviderStatusString(record.status)
  );
}

/**
 * The `ledger.payout_outcome` values a provider status lookup may COMPLETE.
 *
 * These are exactly the UNRESOLVED_PAYOUT_OUTCOMES — the rows that positively
 * record "a submission was made and no final result is known", i.e. the only
 * rows for which a later provider confirmation is the missing evidence.
 *
 * Everything else is excluded on purpose:
 *   'not_submitted' — no submission was ever made, so no provider transfer
 *                     can exist to confirm; completing it from a provider
 *                     lookup would be a guess.
 *   'rejected'      — the provider refused it; a "completed" status would
 *                     contradict the recorded refusal.
 *   'completed'     — already paid (idempotency).
 *   NULL            — legacy/unknown history. Fail closed.
 */
export const CONFIRMABLE_PAYOUT_OUTCOMES: readonly PayoutOutcome[] = UNRESOLVED_PAYOUT_OUTCOMES;

/**
 * May THIS row's payout be marked completed by an authoritative provider
 * confirmation? A positive statement only: the row must still be bookable
 * (`status === 'pending'`) AND carry a recorded, still-unresolved submission
 * outcome. Every other state — including NULL — fails closed.
 *
 * This is the pure mirror of the SQL predicate confirmPayoutVerified() applies
 * in its UPDATE ... WHERE clause, so the write-time guard and this readable
 * rule cannot drift apart.
 */
export function isPayoutConfirmable(row: PayoutSubmissionState | null | undefined): boolean {
  if (!row) return false;
  if (row.status !== 'pending') return false;
  return (
    typeof row.payout_outcome === 'string' &&
    (CONFIRMABLE_PAYOUT_OUTCOMES as readonly string[]).includes(row.payout_outcome)
  );
}

/** The minimal identity of a local payout leg used for provider matching. */
export interface PayoutLegIdentity {
  /** The ledger row id — what a successful match returns. */
  id: string;
  provider_batch_id?: string | null;
  provider_transaction_id?: string | null;
}

/** One provider-reported transaction, keyed by the two ids we correlate on. */
export interface PayoutProviderTransaction {
  batchId?: string | null;
  transactionId?: string | null;
}

/** Trim to a non-empty string, or null. Blank/whitespace counts as absent. */
function normalizeProviderRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolve ONE provider transaction to EXACTLY ONE local payout leg.
 *
 * The correlation is `(provider_batch_id, provider_transaction_id)` — both,
 * matched exactly. That pair is the only thing that makes a provider report
 * evidence about a specific finder/agent transfer: a batch id alone covers
 * every leg in the batch, and a transaction id alone could belong to another
 * batch.
 *
 * Returns the leg's id, or null when the answer is not unambiguous:
 *   * zero matches  — an unmatched row (e.g. a legacy row whose
 *                     provider_transaction_id is NULL, or a batch id we never
 *                     recorded). We cannot prove which leg this is, so we
 *                     confirm nothing.
 *   * two or more   — the provider answered with ids that are not unique among
 *                     this batch's legs (duplicate transaction ids, which can
 *                     arise when the submission path bound responses by
 *                     recipient account instead of by position — see the
 *                     Batch 1B proposal). Choosing one would be a coin flip.
 *   * a missing id on EITHER side — an incomplete correlation is a guess.
 *
 * This is a pure function of data, so it is exhaustively unit-testable and
 * cannot perform a side effect of any kind.
 */
export function matchPayoutTransactionToLegs(
  transaction: PayoutProviderTransaction | null | undefined,
  legs: readonly PayoutLegIdentity[] | null | undefined,
): string | null {
  if (!transaction || !Array.isArray(legs) || legs.length === 0) return null;

  const batchId = normalizeProviderRef(transaction.batchId);
  const transactionId = normalizeProviderRef(transaction.transactionId);
  // Both identifiers are REQUIRED. Without either one, a "match" is a guess.
  if (!batchId || !transactionId) return null;

  const matches = legs.filter((leg) => {
    if (!leg || typeof leg.id !== 'string') return false;
    const legBatch = normalizeProviderRef(leg.provider_batch_id);
    const legTransaction = normalizeProviderRef(leg.provider_transaction_id);
    return (
      legBatch !== null &&
      legTransaction !== null &&
      legBatch === batchId &&
      legTransaction === transactionId
    );
  });

  return matches.length === 1 ? matches[0].id : null;
}

// ============================================================================
// BATCH 1B-C1 — BINDING AN INITIATION RESPONSE TRANSACTION TO A LOCAL LEG
// ============================================================================
//
// WHAT THIS REPLACES, AND WHY
//
// The payout-initiation path used to tie the provider's per-transaction response
// entries to local payout legs by the LAST NINE DIGITS of the destination
// account (`acct.endsWith(destination.replace(/\s+/g, '').slice(-9))`). That is
// not an identity. A finder's M-Pesa number and an agent's till number are both
// plain digit strings, and `find()` returns the FIRST entry that matches, so a
// shared suffix handed BOTH legs the same provider `transaction_id`.
//
// The damage is not a wrong payment — nothing in this module moves money — it is
// a WRONG provider transaction id recorded on a ledger leg, which then makes
// `matchPayoutTransactionToLegs()` unable to bind the provider's authoritative
// status report to the correct leg. That matcher's own docstring names this
// exact cause ("the submission path bound responses by recipient account instead
// of by position").
//
// WHAT IS USABLE, ON THE DOCUMENTED CONTRACT
//
// IntaSend documents that the initiation response (`POST
// /api/v1/send-money/initiate/`) carries, per submitted transaction, the
// `account` it was addressed to plus a provider-assigned `transaction_id`:
//
//   "transactions": [ { "transaction_id": "KQ9PLXR", "status": "Pending",
//                       "status_code": "TP101", "request_reference_id": "…",
//                       "name": "Jane Doe", "account": "254712345678",
//                       "amount": "150.00", "narrative": "Salary" } ]
//
// The documented response does NOT echo `idempotency_key`, and no ordering
// guarantee is documented for the transactions array, so NEITHER of those may be
// used as a correlation. The one value that is both documented in the response
// and chosen by us per leg is the exact `account` we submitted, so the
// correlation below is EXACT equality on it, with every ambiguity refused:
//
//   * accounts are compared after whitespace removal only — never by suffix,
//     never by amount, never by array position;
//   * a leg whose account is blank, or shared with another leg of the same
//     submission, is refused — every side of the collision, not just the later
//     one;
//   * a leg with zero matching provider transactions, or with more than one, is
//     refused;
//   * a matching provider transaction with no usable `transaction_id` is refused.
//
// A refusal returns `providerTransactionId: null`. That is deliberate and is not
// a financial decision: the ledger row stays unresolved, the provider batch id is
// still recorded, and only the authoritative status lookup plus the operator
// reconciliation surface can resolve it. NOTHING here can complete a payout.
//
// STATED ASSUMPTION (explicit, falsifiable, sandbox-verifiable): the initiation
// response echoes the submitted `account` verbatim. If a provider revision
// reformats it (e.g. answers `0712…` for a submitted `254712…`), the correlation
// simply finds no match — an inert feature, never a wrong binding. If IntaSend
// ever echoes the per-transaction `idempotency_key`, that would be a strictly
// stronger correlation and should replace the account comparison.

/** One local payout leg EXACTLY AS IT WAS SUBMITTED to the provider. */
export interface PayoutSubmittedLegIdentity {
  /**
   * An opaque local identity for this leg. It is echoed back in the result and
   * is never used for matching, so it may be a ledger row id or a recipient role.
   */
  id: string;
  /** The exact `account` value submitted for this leg. */
  account: string;
}

/** Why a provider transaction id was, or was not, bound to a local leg. */
export type PayoutBindingOutcome =
  | 'bound'
  | 'leg_account_missing'
  | 'duplicate_local_leg_account'
  | 'provider_transaction_not_found'
  | 'provider_transaction_ambiguous'
  | 'provider_transaction_id_missing';

export interface PayoutLegBinding {
  /** The `id` of the submitted leg this entry describes. */
  id: string;
  /** The provider's own transaction id, or null when nothing was bound. */
  providerTransactionId: string | null;
  outcome: PayoutBindingOutcome;
}

export interface PayoutBindingReport {
  /** One entry per SUBMITTED leg, in the same order. */
  bindings: PayoutLegBinding[];
  /**
   * How many provider transactions could not be tied to any submitted leg (an
   * unrecognised or blank account). Counted, never returned as values, so a
   * caller cannot log a third party's account by accident.
   */
  unmatchedProviderTransactions: number;
}

/**
 * Whitespace-free account form, or null when there is no account at all.
 * Accepts a numeric JSON value (some serializers emit digits as numbers) but not
 * booleans/objects/arrays, which are malformed rather than absent.
 */
function normalizeAccountValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const compact = String(value).replace(/\s+/g, '');
  return compact === '' ? null : compact;
}

/**
 * Resolve each SUBMITTED payout leg to at most ONE provider transaction from the
 * initiation response. Pure: no imports, no I/O, no side effects.
 *
 * Fail-closed by construction — see the block comment above for why exact account
 * equality is the only correlation the documented contract supports, and why
 * every ambiguity yields `providerTransactionId: null`.
 */
export function resolvePayoutTransactionBindings(
  legs: readonly PayoutSubmittedLegIdentity[] | null | undefined,
  providerTransactions: readonly unknown[] | null | undefined,
): PayoutBindingReport {
  const submitted = Array.isArray(legs) ? legs : [];

  const entries = (Array.isArray(providerTransactions) ? providerTransactions : []).map((entry) => {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    // ONLY the documented field names are read. Guessing at alternative spellings
    // (id / invoice / phone_number / destination) is the shape-guessing this
    // codebase refuses to do: an unreadable entry simply cannot be bound.
    return {
      account: normalizeAccountValue(record?.account),
      transactionId: record ? normalizeProviderRef(record.transaction_id) : null,
    };
  });

  const legAccounts = submitted.map((leg) => normalizeAccountValue(leg?.account));
  const knownAccounts = new Set(legAccounts.filter((account): account is string => account !== null));

  const bindings: PayoutLegBinding[] = submitted.map((leg, index) => {
    const id = String(leg?.id ?? '');
    const account = legAccounts[index];
    if (account === null) {
      return { id, providerTransactionId: null, outcome: 'leg_account_missing' };
    }
    if (legAccounts.filter((candidate) => candidate === account).length > 1) {
      // Two legs were addressed to the same account, so a provider transaction
      // for it is evidence about NEITHER of them. Refuse both.
      return { id, providerTransactionId: null, outcome: 'duplicate_local_leg_account' };
    }
    const matches = entries.filter((entry) => entry.account === account);
    if (matches.length === 0) {
      return { id, providerTransactionId: null, outcome: 'provider_transaction_not_found' };
    }
    if (matches.length > 1) {
      return { id, providerTransactionId: null, outcome: 'provider_transaction_ambiguous' };
    }
    const transactionId = matches[0].transactionId;
    if (transactionId === null) {
      return { id, providerTransactionId: null, outcome: 'provider_transaction_id_missing' };
    }
    return { id, providerTransactionId: transactionId, outcome: 'bound' };
  });

  return {
    bindings,
    unmatchedProviderTransactions: entries.filter(
      (entry) => entry.account === null || !knownAccounts.has(entry.account),
    ).length,
  };
}
