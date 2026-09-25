// Claim-status lifecycle vocabulary — pure data, importable by both the
// backend (server.ts, routes) and the frontend (components/claimStatus.ts).
//
// Kept out of components/ on purpose: the backend must not import a React-layer
// module, and the frontend must not invent its own copy of the lifecycle.

/**
 * The complete claims_status_check vocabulary, in the order the constraint
 * declares it. Keep in lockstep with:
 *   sql/schema.sql (claims.status CHECK)
 *   src/db/schema.ts (Claim["status"] union)
 *   src/db/index.ts   (claims_status_check, runtime DDL)
 *   src/components/claimStatus.ts (the human-readable label for each)
 */
export const CLAIM_STATUS_VALUES = [
  'pending_verification',
  'awaiting_agent_confirmation',
  'pending_payment',
  'payment_window_expired',
  'escrow_held',
  'pending_settlement',
  'releasing',
  'released',
  'disputed',
  'rejected',
  'refunding',
  'refunded',
] as const;

/**
 * A CLOSED, historical claim attempt — an audit record, NOT a live reservation
 * on the item. Used to split "Active" from "History" in the customer dashboard.
 *
 * This is the same definition server.ts uses to decide whether a claim counts
 * as a competing claimant during claim submission (payment expiry in
 * particular is abandonment, not a rival claim, and must never file a bogus
 * dispute). That definition previously lived inline inside startServer(); it
 * was moved here verbatim so the dashboard groups claims by exactly the same
 * rule instead of a second, drifting copy.
 *
 * NOTE ON `disputed`: a disputed claim is still a LIVE attempt (it is being
 * adjudicated), but it is deliberately treated as "not a live reservation"
 * here because the dispute workflow itself — not this predicate — prevents a
 * third claimant (see canCreateClaim()'s unresolved-dispute rule). Kept
 * unchanged from the original definition so the customer dashboard's
 * Active/History grouping does not shift.
 */
export const INACTIVE_CLAIM_STATUSES: ReadonlySet<string> = new Set<string>([
  'payment_window_expired', // abandoned/unpaid within the 15-minute window
  'disputed',               // already pulled into the dispute workflow
  'rejected',               // failed owner verification
  'refunded',               // money returned, claim finished
  'released',               // item handed over and settled
]);

export function isInactiveClaimStatus(status: string): boolean {
  return INACTIVE_CLAIM_STATUSES.has(status);
}

/**
 * Statuses in which a claim may still legitimately coordinate a PHYSICAL
 * PICKUP, i.e. where handing the claimant the assigned hub's operational
 * contact details, exact address and GPS coordinates is the fulfilment of the
 * product promise rather than an over-disclosure.
 *
 * This is a THIRD question, distinct from the two predicates above:
 *   INACTIVE_CLAIM_STATUSES      — "is this claim still a live ATTEMPT?"
 *   CLAIM_SLOT_EXCLUDED_STATUSES — "may these two claims coexist on one item?"
 *   this set                     — "is this claim still entitled to active
 *                                   pickup instructions?"
 *
 * It is DERIVED from CLAIM_STATUS_VALUES by subtracting the explicitly
 * ineligible statuses, so a status added to the CHECK constraint cannot
 * silently default into the eligible set: it lands here only if it is not on
 * the ineligible list, and a test pins the two sets as a partition of the
 * vocabulary.
 *
 * NOT eligible, and why:
 *   pending_verification     — OTP is not yet satisfied; the claimant has not
 *                              proven control of the registered phone.
 *   payment_window_expired   — abandoned attempt; the item is claimable again
 *                              and this claimant is no longer the live one.
 *   disputed                 — ownership is being adjudicated; a competing or
 *                              losing claimant must not receive the hub's live
 *                              coordinates.
 *   rejected                 — failed verification / lost dispute.
 *   refunding / refunded     — money is on its way back; the claim is closed.
 *
 * `released`/`pending_settlement`/`releasing` remain eligible: they are the
 * post-handover statuses of a claim that legitimately completed pickup, and
 * withholding the hub's own coordinates from the person who collected the item
 * would be a behaviour regression rather than a privacy gain.
 */
export const PICKUP_INELIGIBLE_CLAIM_STATUSES = [
  'pending_verification',
  'payment_window_expired',
  'disputed',
  'rejected',
  'refunding',
  'refunded',
] as const;

export const PICKUP_ELIGIBLE_CLAIM_STATUSES: ReadonlySet<string> = new Set<string>(
  CLAIM_STATUS_VALUES.filter(
    (status) => !(PICKUP_INELIGIBLE_CLAIM_STATUSES as readonly string[]).includes(status)
  )
);

export function isPickupEligibleClaimStatus(status: string): boolean {
  return PICKUP_ELIGIBLE_CLAIM_STATUSES.has(status);
}

/**
 * Statuses EXEMPT from the "at most one active claim per item" database rule
 * (`uq_claims_one_active_per_item`).
 *
 * WHY THIS IS A DIFFERENT SET FROM INACTIVE_CLAIM_STATUSES
 * --------------------------------------------------------
 * The two predicates answer genuinely different questions and MUST NOT be
 * forced to be equal:
 *
 *   INACTIVE_CLAIM_STATUSES  — "is this claim still a live ATTEMPT?" (a closed
 *                              historical attempt must not block or dispute)
 *
 *   this set                 — "which statuses must be able to COEXIST on the
 *                              same item?" (so the partial unique index must
 *                              exclude them)
 *
 * `disputed` and `refunding` are the reason the sets differ:
 *   - A dispute legitimately puts TWO claims on one item, both `disputed`.
 *     If `disputed` occupied the single slot, filing a dispute would violate
 *     the index outright.
 *   - A refunding loser legitimately coexists with the winning claim while the
 *     real M-Pesa refund is in flight.
 * Neither is "inactive" in the dashboard sense, and neither may occupy the
 * slot. Conversely `released` is inactive for the dashboard but still occupies
 * the slot — a completed handover is an achieved outcome, and the item itself
 * is `claimed` at that point so no new claim can be filed regardless.
 *
 * THE ACTUAL DEFECT THIS CONSTANT FIXES (SC-7): the predicate was hand-copied
 * into three places (sql/schema.sql, src/db/schema.ts, src/db/index.ts) with
 * no single source of truth, so any future status addition could silently
 * drift them apart. This export is now that single source; a test asserts all
 * three declarations agree with it.
 */
export const CLAIM_SLOT_EXCLUDED_STATUSES = [
  'disputed',
  'rejected',
  'refunding',
  'refunded',
  'payment_window_expired',
] as const;

/** The exact SQL predicate fragment used by uq_claims_one_active_per_item. */
export const CLAIM_SLOT_EXCLUDED_SQL_LIST = CLAIM_SLOT_EXCLUDED_STATUSES
  .map((s) => `'${s}'`)
  .join(', ');

/** Statuses from which no ordinary transition is permitted. */
export const TERMINAL_CLAIM_STATUSES: ReadonlySet<string> = new Set<string>([
  'payment_window_expired',
  'released',
  'rejected',
  'refunded',
]);

/**
 * The ONLY legal claim-status edges. Anything not listed here is rejected by
 * transitionClaimStatus() — including every backward move out of a terminal
 * status. `'*'` as a source means "any status that is not terminal".
 *
 * Derived from the Phase 6A/6B transition audit of the real repository, not
 * invented: each edge below has exactly one real producer.
 */
export const CLAIM_ALLOWED_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  '*': ['disputed'],                          // createDispute() — a second claimant arrives
  pending_verification: ['awaiting_agent_confirmation', 'rejected'],
  awaiting_agent_confirmation: ['pending_payment', 'rejected'],
  pending_payment: ['escrow_held', 'payment_window_expired', 'rejected'],
  escrow_held: ['pending_settlement', 'disputed'],
  pending_settlement: ['releasing', 'disputed'],
  releasing: ['released', 'pending_settlement'],
  disputed: ['pending_verification', 'escrow_held', 'refunding', 'rejected'],
  refunding: ['refunded', 'rejected'],
  // terminal: no outgoing edges
  released: [],
  refunded: [],
  rejected: [],
  payment_window_expired: [],
};

/**
 * Is `from -> to` a legal claim-status edge? A terminal `from` never is.
 * `'*'` is honoured ONLY as a source (never as a destination).
 */
export function isAllowedClaimTransition(from: string, to: string): boolean {
  if (TERMINAL_CLAIM_STATUSES.has(from)) return false;
  if (from === to) return true; // explicit no-op (idempotent re-assert)
  const explicit = CLAIM_ALLOWED_TRANSITIONS[from];
  if (explicit && explicit.includes(to)) return true;
  const wildcard = CLAIM_ALLOWED_TRANSITIONS['*'];
  return Boolean(wildcard && wildcard.includes(to));
}

/**
 * ONE body, used for EVERY claim-ownership failure on the claim-ID-keyed
 * routes that take the owner's registered phone:
 *
 *   POST /api/claims/:id/request-otp
 *   POST /api/claims/:id/payment-auth
 *   POST /api/claims/:id/payment-session
 *   POST /api/claims/:id/pay
 *
 * (POST /api/claims/lookup keeps its own local copy of this same wording — see
 * claimTrackingDisclosure.test.ts, which pins that route's two
 * `res.status(404).json(claimUnavailable)` branches by name.)
 *
 * WHY THIS IS AN EXPORTED CONSTANT (Phase 16.1 Batch 2A)
 * ------------------------------------------------------
 * A caller must not be able to distinguish "this claim ID does not exist" from
 * "this claim ID exists, but the phone number you guessed is not its owner".
 * Those used to be two DIFFERENT responses (404 with one message vs 403 with a
 * different one), which turned an unauthenticated, ~900,000-combination
 * claim-ID space (CLM-100000..CLM-999999) into a claim-EXISTENCE and
 * owner-phone-confirmation oracle. That is the same defect Phase 7C.7 (R2)
 * closed on /lookup and F4 closed on POST /api/claims/:id/pickup-details, whose
 * single-response contract is already pinned by tests.
 *
 * Keeping one literal here is what stops the routes drifting apart again: a
 * future edit cannot make one of them say something subtly different without
 * changing this shared value.
 */
export const CLAIM_UNAVAILABLE_MESSAGE =
  'Claim haikupatikana au nambari ya simu hailingani. / Claim not found, or the phone number does not match.';
