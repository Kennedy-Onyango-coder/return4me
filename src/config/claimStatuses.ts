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
