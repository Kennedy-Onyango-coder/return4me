// ============================================================================
// PAYMENT-CONFIRMATION OUTCOMES - what the canonical confirmation path ACTUALLY
// decided, in a shape its caller cannot misread.
// ============================================================================
//
// THE DEFECT THIS MODULE EXISTS TO PREVENT (Gate C, stage C1)
//
// `processClaimPaymentConfirmed` (server.ts) used to return `string | null`: the
// pickup code on success and `null` for ELEVEN different refusals - an unknown
// claim, a missing item, an invoice bound to another claim, a session amount
// mismatch, a session in no confirmable state, a claim amount mismatch, two
// distinct provider-verification failures, a provider amount mismatch, and a
// lost compare-and-swap. The IntaSend collection route then answered
//
//     200 {"status":"ok"}
//
// for EVERY call that did not throw, so a provider-confirmed KES 200 collection
// that the application REFUSED to reconcile was acknowledged to the provider as
// successfully handled. The callback was never retried, no operator was told,
// and the only recovery was the 60-second reconciliation sweep - which is
// exactly why a real payment sat unresolved for 17h46m in the audited window.
//
// A `null` that means eleven different things cannot be acknowledged truthfully:
// "already reconciled" must stay a silent, idempotent success, a provider
// outage must not be reported as a completed collection, and a permanent
// identity/amount mismatch must be neither. This module is that distinction.
//
// WHAT THIS MODULE IS
//
//   * ONE closed union of the three things the confirmation path can decide:
//     reconciled / already_reconciled (duplicate) / refused (with a stable code).
//   * ONE catalogue that says, per refusal code, whether repeating the SAME
//     delivery after a transient condition can ever help.
//   * ONE mapping from an outcome to the provider-facing HTTP status + body.
//
// WHAT THIS MODULE IS NOT
//
// It performs no I/O, calls no provider and writes nothing. It grants nothing:
// every financial decision still happens in `processClaimPaymentConfirmed` and
// in the database compare-and-swap. This module only NAMES what was decided so
// the webhook route can stop describing refusals as success.
//
// CHOICE OF STATUS CODES - READ BEFORE CHANGING
//
//   reconciled           200  {"status":"ok"}                  unchanged from
//                             before this stage, so nothing that already reads
//                             the success body has to change.
//   already_reconciled   200  {"status":"ok","outcome":...}    a duplicate
//                             delivery is an idempotent SUCCESS. The claim and
//                             the session were reconciled by an earlier
//                             delivery; repeating that verdict is correct and
//                             must never look like a failure.
//   refused (permanent)  409  identity / state / amount conflict. Repeating the
//                             same delivery cannot change the outcome: the
//                             verified facts disagree with local truth.
//   refused (transient)  424  the refusal depended on an authority that could
//                             not be reached or could not corroborate the event
//                             (the authoritative provider status lookup). It is
//                             deliberately NOT 2xx (that is the bug this stage
//                             fixes) and deliberately NOT 5xx: the application
//                             itself did not fail, and every other route in this
//                             codebase reserves 5xx for an unexpected internal
//                             error (sendServerError). Keeping refusals in 4xx
//                             also preserves the documented invariant that a
//                             financial refusal is never reported as a server
//                             error.
//
// WHY THE PROVIDER'S RETRY BEHAVIOUR IS NOT LOAD-BEARING HERE
//
// IntaSend's retry schedule and its treatment of a non-2xx collection callback
// are UNVERIFIED (see docs/intasend-provider-verification.md, Q14-Q15). Nothing
// in this design depends on them: a refused collection is recovered by the two
// local paths that already exist and are already authoritative - the 60-second
// `reconcilePendingPaymentSessions` sweep and the on-demand payment-session
// status route - both of which re-read the provider rather than trusting this
// callback. A provider retry, if it happens, is a harmless bonus: every write
// on this path is a compare-and-swap or a no-op.
//
// Pure: no I/O, no provider, no database.
// ============================================================================

/**
 * Every distinct reason the canonical confirmation path can refuse a
 * provider-confirmed collection. Stable machine codes; never user-facing.
 *
 * The set is deliberately FINER than "null": an operator triaging a stuck
 * payment has to be able to tell an unverifiable provider (wait / sweep will
 * retry) apart from a cross-claim invoice (a person must look).
 */
export type PaymentConfirmationRefusalCode =
  | 'claim_not_found'
  | 'item_not_found'
  | 'cross_claim_invoice'
  | 'session_amount_mismatch'
  | 'session_not_confirmable'
  | 'claim_amount_mismatch'
  | 'provider_amount_mismatch'
  | 'provider_verification_unavailable'
  | 'claim_not_payable';

/** What the canonical confirmation path decided. Closed union - no `null`. */
export type PaymentConfirmationOutcome =
  | {
      /** The claim moved (or was recovered) into escrow by THIS delivery. */
      readonly kind: 'reconciled';
      readonly claimId: string;
      readonly invoiceId: string;
      /**
       * The plaintext pickup code that was issued and emailed. Never logged,
       * never persisted in plaintext, and never returned by any production
       * route - it exists here only because the dev simulator echoes it.
       */
      readonly pickupCode: string;
      /** True only for the one gated `payment_window_expired` recovery edge. */
      readonly recoveredExpiredClaim: boolean;
    }
  | {
      /**
       * An earlier delivery already reconciled this collection. This is a
       * DUPLICATE, not a failure: the claim and the session were settled
       * together and this delivery wrote nothing.
       */
      readonly kind: 'already_reconciled';
      readonly claimId: string;
      readonly invoiceId: string;
    }
  | {
      /** Nothing was reconciled. `code` says why, `retryable` says if a retry helps. */
      readonly kind: 'refused';
      readonly claimId: string;
      readonly invoiceId: string;
      readonly code: PaymentConfirmationRefusalCode;
      /**
       * True only when the SAME delivery could succeed later without anyone
       * changing local or provider state - i.e. the provider could not be
       * asked, or could not corroborate the event yet.
       */
      readonly retryable: boolean;
      /** Short, non-sensitive operator context. Never a secret, never a payload. */
      readonly detail?: string;
    };

interface RefusalCatalogEntry {
  readonly retryable: boolean;
  readonly operator_message: string;
}

/**
 * The one place that decides whether a refusal is transient.
 *
 * `provider_verification_unavailable` is the ONLY retryable code: every other
 * refusal is a disagreement between verified facts and local state, and no
 * amount of redelivery changes a fact. A provider outage is different - the
 * provider may answer correctly a minute later.
 */
const REFUSAL_CATALOG: Readonly<Record<PaymentConfirmationRefusalCode, RefusalCatalogEntry>> = Object.freeze({
  claim_not_found: {
    retryable: false,
    operator_message:
      'The claim named by the callback does not exist locally, so nothing was reconciled.',
  },
  item_not_found: {
    retryable: false,
    operator_message:
      'The item behind the claim no longer exists, so the expected fee cannot be resolved. Nothing was reconciled.',
  },
  cross_claim_invoice: {
    retryable: false,
    operator_message:
      'The provider invoice belongs to a DIFFERENT claim. Cross-claim payment was refused; no claim was changed.',
  },
  session_amount_mismatch: {
    retryable: false,
    operator_message:
      'The callback amount disagreed with the amount the payer was prompted for on that session. Refused; escrow withheld.',
  },
  session_not_confirmable: {
    retryable: false,
    operator_message:
      'The payment session for this invoice is in a status that cannot be confirmed. Refused; nothing was written.',
  },
  claim_amount_mismatch: {
    retryable: false,
    operator_message:
      'The verified amount disagreed with the amount this claim owes. Refused pending manual review; escrow withheld.',
  },
  provider_amount_mismatch: {
    retryable: false,
    operator_message:
      'The authoritative provider amount disagreed with the expected amount. Refused; escrow withheld.',
  },
  provider_verification_unavailable: {
    retryable: true,
    operator_message:
      'The callback carried no usable amount and the authoritative provider lookup could not verify the collection. Nothing was reconciled; escrow is withheld until the provider can be asked.',
  },
  claim_not_payable: {
    retryable: false,
    operator_message:
      'The claim was no longer in a payable state when the confirmation compare-and-swap ran. Nothing was reconciled.',
  },
});

/** The catalogue entry for a refusal code (operator_message + retryability). */
export function describePaymentConfirmationRefusal(
  code: PaymentConfirmationRefusalCode
): RefusalCatalogEntry {
  return REFUSAL_CATALOG[code];
}

/** Is this code transient (a retry of the same delivery could succeed)? */
export function isRetryablePaymentConfirmationRefusal(code: PaymentConfirmationRefusalCode): boolean {
  return REFUSAL_CATALOG[code].retryable;
}

// ---------------------------------------------------------------------------
// CONSTRUCTORS. One per decision, so no call site can build a malformed or
// partially-populated outcome by hand.
// ---------------------------------------------------------------------------

/** The claim was reconciled (or recovered) by THIS delivery. */
export function reconciledPaymentConfirmation(args: {
  claimId: string;
  invoiceId: string;
  pickupCode: string;
  recoveredExpiredClaim: boolean;
}): PaymentConfirmationOutcome {
  return {
    kind: 'reconciled',
    claimId: args.claimId,
    invoiceId: args.invoiceId,
    pickupCode: args.pickupCode,
    recoveredExpiredClaim: args.recoveredExpiredClaim === true,
  };
}

/** An earlier delivery already reconciled this collection (duplicate). */
export function alreadyReconciledPaymentConfirmation(
  claimId: string,
  invoiceId: string
): PaymentConfirmationOutcome {
  return { kind: 'already_reconciled', claimId, invoiceId };
}

/** Nothing was reconciled; `code` is the stable reason. */
export function refusePaymentConfirmation(
  claimId: string,
  invoiceId: string,
  code: PaymentConfirmationRefusalCode,
  detail?: string | null
): PaymentConfirmationOutcome {
  const entry = REFUSAL_CATALOG[code];
  return detail
    ? { kind: 'refused', claimId, invoiceId, code, retryable: entry.retryable, detail }
    : { kind: 'refused', claimId, invoiceId, code, retryable: entry.retryable };
}

// ---------------------------------------------------------------------------
// PREDICATES / ADAPTERS.
// ---------------------------------------------------------------------------

/** Exactly one delivery per collection wins this. */
export function isReconciledPaymentConfirmation(outcome: PaymentConfirmationOutcome): boolean {
  return outcome.kind === 'reconciled';
}

/**
 * Reconciled now OR already reconciled by an earlier delivery - the two states
 * in which the collection is, as far as local truth is concerned, settled.
 */
export function isSettledPaymentConfirmation(outcome: PaymentConfirmationOutcome): boolean {
  return outcome.kind === 'reconciled' || outcome.kind === 'already_reconciled';
}

/**
 * COMPATIBILITY ADAPTER for the older call sites (`string | null`).
 *
 * The collection-failure service and the dev simulator were written against the
 * pre-C1 `string | null` contract. They are NOT financial authority: they ask
 * "did a confirmation happen, and what was the code?" and nothing else. This
 * adapter answers exactly that, so their own contracts and tests stay intact
 * while every caller that must distinguish a refusal uses the union directly.
 *
 * Deliberately NOT used by the IntaSend webhook route: collapsing the union
 * back to `string | null` there would re-create the defect this stage fixes.
 */
export function pickupCodeFromOutcome(outcome: PaymentConfirmationOutcome): string | null {
  return outcome.kind === 'reconciled' ? outcome.pickupCode : null;
}

/**
 * One non-sensitive line for an operator log. NEVER includes the pickup code,
 * an amount, a phone number or any part of the provider payload.
 */
export function describePaymentConfirmationOutcome(outcome: PaymentConfirmationOutcome): string {
  switch (outcome.kind) {
    case 'reconciled':
      return outcome.recoveredExpiredClaim
        ? 'reconciled (late payment recovered from payment_window_expired)'
        : 'reconciled';
    case 'already_reconciled':
      return 'already reconciled by an earlier delivery (duplicate; nothing written)';
    case 'refused':
      return `refused: ${outcome.code} (${outcome.retryable ? 'transient' : 'permanent'})`;
  }
}

// ---------------------------------------------------------------------------
// PROVIDER-FACING ENCODING.
// ---------------------------------------------------------------------------

/** The status + body the IntaSend callback route answers for an outcome. */
export interface PaymentConfirmationHttpResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * 200 for a settled collection (including a duplicate), 409 for a permanent
 * conflict, 424 for a refusal that depended on an unreachable authority.
 *
 * The bodies carry a stable machine code and a `retryable` flag and NOTHING
 * else: no amount, no claim status, no phone number, no payload echo. A caller
 * that was not supposed to know about a claim learns nothing from them.
 */
export function paymentConfirmationHttpResult(
  outcome: PaymentConfirmationOutcome
): PaymentConfirmationHttpResult {
  if (outcome.kind === 'reconciled') {
    // Unchanged success body: the pre-C1 contract for a real confirmation, so
    // no existing consumer or test of the success path has to move.
    return { status: 200, body: { status: 'ok' } };
  }
  if (outcome.kind === 'already_reconciled') {
    return { status: 200, body: { status: 'ok', outcome: 'already_reconciled' } };
  }
  return {
    status: outcome.retryable ? 424 : 409,
    body: { status: 'refused', outcome: 'refused', code: outcome.code, retryable: outcome.retryable },
  };
}
