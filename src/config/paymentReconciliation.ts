// ============================================================================
// PAYMENT-RECONCILIATION SELECTION — the ONE predicate that decides whether a
// payment session is worth asking the provider about.
// ============================================================================
//
// THE DEFECT THIS MODULE EXISTS TO PREVENT
//
// There are two server-side entry points that recover a payment the webhook
// missed: the on-demand `GET /api/claims/:id/payment-session/:sessionId/status`
// route, and the background `reconcilePendingPaymentSessions()` sweep. Both used
// to hand-write the same allow-list of session statuses:
//
//     session.status === 'pending' || session.status === 'expired'
//
// A `confirmed` session was therefore INVISIBLE to both. That is safe for the
// ordinary case — the canonical path confirms the session only in the same
// transaction that moves the claim (db.attemptClaimEscrowHold), so a
// `confirmed` session normally co-exists with a PAID claim. But it is not safe
// for the legacily-stranded case: a session can exist as `confirmed` while its
// claim is still unpaid and has already been swept to `payment_window_expired`.
// Such a claim could never be recovered, because no entry point would ever
// select its session again — the money was real and provider-verified, and the
// claim was permanently orphaned. Because the two call sites each carried their
// OWN copy of the list, a future fix would also have had to be applied twice.
//
// WHAT THIS MODULE IS
//
// The single source of truth for that selection decision, imported by BOTH
// entry points so they cannot drift apart.
//
// WHAT THIS MODULE IS NOT — READ THIS BEFORE CHANGING IT
//
// This is a SELECTION predicate, not an AUTHORISATION. It answers only "is it
// worth spending a provider lookup on this session?", and it is deliberately
// permissive: widening it can never confirm anything on its own, because every
// selected session is then handed to the ONE canonical confirmation path
// (server.ts `processClaimPaymentConfirmed`), which independently:
//
//   * re-resolves the session by provider invoice and refuses a cross-claim
//     binding (db.getPaymentSessionByProviderInvoice);
//   * refuses a session in no confirmable state;
//   * requires a POSITIVELY reconciled amount, escalating to the authoritative
//     provider lookup (PaymentService.fetchAuthoritativeCollectionStatus) when
//     the callback carried no usable amount;
//   * evaluates `canRecoverExpiredClaimPayment` (config/claimStatuses.ts) before
//     it may use the ONE gated terminal-claim edge, on facts freshly re-read
//     immediately before the CAS; and
//   * wins the claim CAS and the session CAS as ONE atomic transaction
//     (db.attemptClaimEscrowHold), which is the only writer of `paid_at` and the
//     only producer of a `confirmed` session.
//
// So a session selected here that is NOT genuinely, provider-verified paid is
// refused downstream and changes nothing. Authorisation lives in the canonical
// path and the CAS, never here.
//
// IDEMPOTENCY
//
// Selecting a session repeatedly is safe by construction: the canonical path's
// CASes produce exactly one winner, so a re-selected already-recovered session
// is a no-op that returns null and books nothing. A claim that is already paid
// is excluded here as well (`paidAt`), so an ordinary polling cycle cannot even
// ask the provider about it.
/**
 * The claim statuses from which a payment may still be reconciled.
 *
 * `pending_payment` is the ordinary in-window state. `payment_window_expired` is
 * the 60-second expiry sweep's terminal-ish state; it is included because the
 * claim window (24h) outlives a single M-Pesa prompt, so a genuine approval can
 * land after the sweep moved the claim. The canonical path's gated predicate —
 * not this list — decides whether such a late payment is honoured.
 */
export const RECONCILABLE_CLAIM_STATUSES = [
  'pending_payment',
  'payment_window_expired',
] as const;

/**
 * The payment-session statuses from which a claim may still be reconciled.
 *
 *   pending   — the STK prompt is out and the customer may still approve it.
 *   expired   — this PROCESS gave up on the prompt (a short per-attempt window),
 *               but the provider may authoritatively report COMPLETE anyway.
 *   confirmed — the session's single confirmation was already consumed. It is
 *               selected ONLY so a session stranded against an unpaid claim (a
 *               state the pre-atomic confirmation path could produce, and which
 *               the canonical path explicitly tolerates as "already won on an
 *               earlier delivery") remains reachable by recovery. The claim
 *               CAS still has to win on its own, and it refuses a claim that is
 *               not in a reconcilable status or that already carries `paid_at`.
 */
export const RECONCILABLE_SESSION_STATUSES = [
  'pending',
  'expired',
  'confirmed',
] as const;

const RECONCILABLE_CLAIM_STATUS_SET: ReadonlySet<string> = new Set(RECONCILABLE_CLAIM_STATUSES);
const RECONCILABLE_SESSION_STATUS_SET: ReadonlySet<string> = new Set(RECONCILABLE_SESSION_STATUSES);

/** The facts this predicate reads. All are read from PERSISTED rows, never input. */
export interface PaymentReconciliationFacts {
  /** The claim's current status. */
  claimStatus: string | null | undefined;
  /**
   * `claims.paid_at` — the authoritative payment marker. Non-null means the
   * claim is already paid, so there is nothing left to reconcile.
   */
  paidAt: string | Date | null | undefined;
  /** The payment session's status. */
  sessionStatus: string | null | undefined;
  /**
   * Whether the session carries a provider invoice. Without one there is no
   * provider identity to verify against, so no reconciliation is possible.
   */
  hasProviderInvoice: boolean;
}

/** Stable, non-sensitive refusal codes for structured logging. Never user-facing. */
export type PaymentReconciliationRefusal =
  | 'no_provider_invoice'
  | 'claim_already_paid'
  | 'claim_status_not_reconcilable'
  | 'session_status_not_reconcilable';

/**
 * Is this session worth a provider lookup through the canonical confirmation
 * path? Evaluated on freshly-read rows only.
 *
 * Every condition is a POSITIVE fact, so a missing/unknown value falls through
 * to "not eligible" rather than to an attempt.
 */
export function isPaymentReconciliationEligible(facts: PaymentReconciliationFacts): boolean {
  return paymentReconciliationRefusal(facts) === null;
}

/**
 * WHY a session was not selected, or null when it was.
 *
 * Exists so the two entry points can log a non-sensitive reason instead of
 * guessing, and so the predicate above has exactly one implementation.
 *
 * The check order is cheapest-and-most-decisive first, and mirrors the order the
 * sweep already used: no invoice to ask about, then a claim that is already
 * settled, then the two status dimensions.
 */
export function paymentReconciliationRefusal(
  facts: PaymentReconciliationFacts
): PaymentReconciliationRefusal | null {
  if (facts.hasProviderInvoice !== true) return 'no_provider_invoice';
  if (facts.paidAt !== null && facts.paidAt !== undefined) return 'claim_already_paid';
  if (!RECONCILABLE_CLAIM_STATUS_SET.has(String(facts.claimStatus))) {
    return 'claim_status_not_reconcilable';
  }
  if (!RECONCILABLE_SESSION_STATUS_SET.has(String(facts.sessionStatus))) {
    return 'session_status_not_reconcilable';
  }
  return null;
}

