// ============================================================================
// COLLECTION FAILURE RECONCILIATION — what the server does when the provider
// says a collection attempt is DEAD.
// ============================================================================
//
// THE PROBLEM
//
// `state !== 'COMPLETE'` was a silent no-op. A provider `FAILED`/`CANCELLED`
// verdict therefore left the attempt's payment session sitting in `pending`
// until a short window elapsed, while the customer's screen kept promising an
// M-Pesa prompt that would never be answered. Nothing recorded WHY, so nobody
// — not the customer, not the operator — could tell "you declined it" from
// "the network ate it".
//
// WHY THIS IS NOT JUST "mark the session failed and return"
//
// A webhook is a HINT about money, never proof. The collection callback is
// authenticated with a shared challenge, but the payload is still a delivery
// over the network: a lost delivery, a redelivery, a provider-side bug or a
// mis-shaped event could all report a failure for an attempt that was in fact
// paid. Marking a session `failed` is a ONE-WAY DOOR in this codebase on
// purpose (`attemptClaimEscrowHold` and `attemptPaymentSessionConfirm` both
// refuse a `failed` session, so payment truth can never be stranded against an
// unconfirmable attempt). Walking through that door on a hint, before asking
// the provider, is how a real KES 200 becomes unclaimable money.
//
// So every failure event is RE-VERIFIED against the authoritative status
// lookup FIRST, and the local verdict is derived from that answer:
//
//   provider says COMPLETE   -> run the ONE canonical confirmation path. The
//                               money is real; the failure event was wrong.
//                               Nothing local is marked failed.
//   provider says FAILED/
//   CANCELLED                -> mark THIS session failed with a stable reason
//                               code, and audit both the reported and the
//                               authoritative state.
//   provider says PENDING    -> the prompt is still open. Write nothing.
//   provider cannot be asked -> write NOTHING and audit that the verdict is
//                               unverified. The session keeps its existing
//                               status and the ordinary expiry/reconciliation
//                               paths still own it. An unverifiable event is
//                               never allowed to become local truth.
//
// IDEMPOTENCY / CROSS-CLAIM
//
// The session is resolved by provider invoice and refused when it belongs to a
// different claim (the same isolation the canonical path enforces). A second
// delivery of the same failure event finds a session already `failed` and is a
// no-op. The session status write itself is a compare-and-swap in
// `db.markPaymentSessionFailed`, so a concurrent confirmation always wins.
//
// Everything here is injected (db, provider lookup, confirmation, audit) so the
// decision table is unit-testable without a database, a network or a webhook,
// and so server.ts keeps sole ownership of the financial rules it already has.

import {
  collectionFailureReasonCode,
  normalizeCollectionFailureState,
  type CollectionFailureKind,
} from '../config/collectionFailureStates';

/** The local session statuses that mean "this attempt is already settled". */
const SETTLED_SESSION_STATUSES: ReadonlySet<string> = new Set(['confirmed', 'failed']);

/** What the reconciliation decided. Stable, non-sensitive, log-only. */
export type CollectionFailureOutcome =
  | 'not_a_failure_state'
  | 'invalid_event_identity'
  | 'no_payment_session'
  | 'cross_claim_refused'
  | 'session_already_confirmed'
  | 'session_already_failed'
  | 'provider_reports_complete_confirmed'
  | 'provider_reports_complete_unconfirmed'
  | 'session_marked_failed'
  | 'session_not_markable'
  | 'provider_still_open'
  | 'provider_unverifiable';

/** The persisted session facts this decision reads. */
export interface CollectionFailureSessionFacts {
  id: string;
  claim_id: string;
  status: string;
  /** The amount the payer was actually prompted for, when known. */
  amount?: number | string | null;
}

/** The authoritative provider verdict (shape of fetchAuthoritativeCollectionStatus). */
export interface AuthoritativeCollectionVerdict {
  verified: boolean;
  reason: string;
  providerState?: string | null;
  providerAmount?: number | string | null;
}

export interface CollectionFailureReconciliationDeps {
  readonly getSessionByProviderInvoice: (
    invoiceId: string
  ) => Promise<CollectionFailureSessionFacts | null | undefined>;
  readonly fetchAuthoritativeStatus: (
    invoiceId: string,
    expectedAmount: number | string,
    expectedApiRef: string
  ) => Promise<AuthoritativeCollectionVerdict>;
  readonly confirmPayment: (
    claimId: string,
    invoiceId: string,
    confirmedAmount?: number | string | null
  ) => Promise<string | null>;
  readonly markSessionFailed: (sessionId: string, reasonCode: string) => Promise<boolean>;
  readonly audit: (action: string, message: string) => Promise<void>;
}

export interface CollectionFailureEvent {
  claimId: string;
  invoiceId: string;
  /** The provider state exactly as the callback reported it (any spelling). */
  reportedState: unknown;
}

export interface CollectionFailureReconciliationResult {
  outcome: CollectionFailureOutcome;
  kind: CollectionFailureKind | null;
  reasonCode?: string;
  providerState?: string | null;
}

/**
 * Decides what to do about a non-COMPLETE collection event.
 *
 * Never throws for a decision it can express as an outcome; a dependency that
 * throws propagates to the caller, which is correct — a webhook that could not
 * be reconciled must be surfaced as an error so the provider retries, and a
 * retried delivery is safe because every write here is a CAS or a no-op.
 */
export async function reconcileCollectionFailureEvent(
  event: CollectionFailureEvent,
  deps: CollectionFailureReconciliationDeps
): Promise<CollectionFailureReconciliationResult> {
  const kind = normalizeCollectionFailureState(event.reportedState);
  if (!kind) {
    // Not a terminal failure (PENDING, COMPLETE, absent, unrecognised). The
    // caller keeps its pre-existing "ignore this event" behaviour.
    return { outcome: 'not_a_failure_state', kind: null, providerState: null };
  }

  const claimId = String(event.claimId ?? '').trim();
  const invoiceId = String(event.invoiceId ?? '').trim();
  if (!claimId || !invoiceId) {
    // Without both halves of the identity there is no attempt to reconcile and
    // no session to resolve. The route refuses these before calling, so this is
    // defence in depth rather than a reachable production state.
    return { outcome: 'invalid_event_identity', kind };
  }

  const reasonCode = collectionFailureReasonCode(kind);

  // -------------------------------------------------------------------------
  // 1. RESOLVE THE ATTEMPT. The invoice is the only identity that binds a
  //    provider event to a local attempt; with no session there is nothing this
  //    module owns (the claim may be on the legacy direct-payment path, whose
  //    truth is the canonical confirmation path's business, not ours).
  // -------------------------------------------------------------------------
  const session = await deps.getSessionByProviderInvoice(invoiceId);
  if (!session) {
    return { outcome: 'no_payment_session', kind, reasonCode };
  }

  // -------------------------------------------------------------------------
  // 2. CROSS-CLAIM ISOLATION. An invoice bound to another claim is not evidence
  //    about THIS claim and must never be allowed to change either one's state.
  // -------------------------------------------------------------------------
  if (String(session.claim_id) !== claimId) {
    await deps.audit(
      'COLLECTION_FAILURE_CROSS_CLAIM_REFUSED',
      `Invoice ${invoiceId} reported state ${String(event.reportedState)} for claim ${claimId}, but it belongs to session ${session.id} of claim ${session.claim_id}. Refused; nothing changed.`
    );
    return { outcome: 'cross_claim_refused', kind, reasonCode };
  }

  const sessionStatus = String(session.status);

  // -------------------------------------------------------------------------
  // 3. A SETTLED SESSION IS NEVER RE-INTERPRETED.
  //
  //    `confirmed` means a verified payment consumed this session's single
  //    confirmation. A later failure event cannot un-pay money, so it must not
  //    touch it. `failed`/`cancelled` mean an earlier delivery already recorded
  //    the same verdict: this is a redelivery, and returning early keeps a
  //    provider request out of it.
  // -------------------------------------------------------------------------
  if (sessionStatus === 'confirmed') {
    return { outcome: 'session_already_confirmed', kind, reasonCode };
  }
  if (SETTLED_SESSION_STATUSES.has(sessionStatus)) {
    return { outcome: 'session_already_failed', kind, reasonCode };
  }

  // -------------------------------------------------------------------------
  // 4. RE-VERIFY BEFORE ANY WRITE. This is the guard that protects money: a
  //    failure hint is never allowed to close an attempt the provider may have
  //    collected. An `expired` session is verified too — a late approval is
  //    exactly the case the confirmable-`expired` rule exists for.
  // -------------------------------------------------------------------------
  const verdict = await deps.fetchAuthoritativeStatus(invoiceId, session.amount ?? '', claimId);

  if (verdict.verified) {
    // The provider says the money arrived. The canonical path performs the
    // claim CAS, the session CAS and pickup-code issuance; this module only
    // decides that it must run.
    const pickupCode = await deps.confirmPayment(claimId, invoiceId, verdict.providerAmount ?? null);
    await deps.audit(
      'COLLECTION_FAILURE_RECOVERED',
      `Claim ${claimId} invoice ${invoiceId}: callback reported ${String(event.reportedState)}, but the authoritative provider status reports COMPLETE with amount ${String(verdict.providerAmount)}. Confirmation ${pickupCode ? 'succeeded' : 'did not win the claim CAS (already settled or refused)'}. Nothing was marked failed.`
    );
    return {
      outcome: pickupCode ? 'provider_reports_complete_confirmed' : 'provider_reports_complete_unconfirmed',
      kind,
      reasonCode,
      providerState: verdict.providerState ?? null,
    };
  }

  if (verdict.reason === 'provider_state_not_complete') {
    const providerKind = normalizeCollectionFailureState(verdict.providerState);
    if (!providerKind) {
      // The provider answered about this invoice and its state is NOT terminal
      // (PENDING/PROCESSING, or a spelling this codebase does not recognise).
      // The prompt may still be approved, so nothing is written and nothing is
      // escalated: the ordinary expiry/reconciliation paths own it.
      return {
        outcome: 'provider_still_open',
        kind,
        reasonCode,
        providerState: verdict.providerState ?? null,
      };
    }

    // Both the callback and the provider agree the attempt is dead. The reason
    // code is derived from the AUTHORITATIVE provider state, not from the
    // (possibly differently worded) callback report, so a stored reason always
    // describes the reconciled outcome.
    const authoritativeReasonCode = collectionFailureReasonCode(providerKind);

    // Both the callback and the provider agree the attempt is dead. This is the
    // only branch that may mark a session failed, and the write is a CAS that
    // refuses a session that has meanwhile been confirmed or expired.
    const marked = await deps.markSessionFailed(session.id, authoritativeReasonCode);
    if (!marked) {
      return {
        outcome: 'session_not_markable',
        kind: providerKind,
        reasonCode: authoritativeReasonCode,
        providerState: verdict.providerState ?? null,
      };
    }
    await deps.audit(
      'COLLECTION_FAILURE_CONFIRMED',
      `Claim ${claimId} session ${session.id} invoice ${invoiceId}: callback state ${String(event.reportedState)} and authoritative provider state ${String(verdict.providerState)} both report a terminal failure. Session marked failed (${authoritativeReasonCode}). No money was collected for this attempt.`
    );
    return {
      outcome: 'session_marked_failed',
      kind: providerKind,
      reasonCode: authoritativeReasonCode,
      providerState: verdict.providerState ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // 5. UNVERIFIABLE. No credentials, a network failure, an unexpected response
  //    shape, an identity mismatch — the provider could not corroborate the
  //    event. The attempt keeps its status; the fact that a failure claim went
  //    uncorroborated is recorded for an operator instead of being guessed at.
  // -------------------------------------------------------------------------
  await deps.audit(
    'COLLECTION_FAILURE_UNVERIFIED',
    `Claim ${claimId} session ${session.id} invoice ${invoiceId}: callback reported ${String(event.reportedState)} but the authoritative provider lookup could not verify it (${verdict.reason}). Session left '${sessionStatus}'; nothing marked failed.`
  );
  return {
    outcome: 'provider_unverifiable',
    kind,
    reasonCode,
    providerState: verdict.providerState ?? null,
  };
}
