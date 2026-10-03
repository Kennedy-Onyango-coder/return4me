// RE-EXPORTED from the repository's canonical owner of phone normalization, not
// reimplemented. Importing (rather than copying the rules) is what guarantees
// strike identity cannot diverge from every other phone-keyed subsystem.
import { toE164Kenyan } from '../services/auth.ts';
export { toE164Kenyan };

// A1 — PAYMENT-STRIKE POLICY
//
// The single place the 5-day window is defined. Both the legacy aggregate
// transition and the individual strike records use this exact constant, so the
// two halves of the active-strike calculation can never drift apart.

/**
 * Each payment strike expires INDIVIDUALLY this long after it was created.
 *
 * Used for:
 *   - individual strike `expires_at` (created_at + this), and
 *   - the legacy aggregate transition window (last_strike_at + this).
 *
 * Neither side ever deletes a row when this elapses. Individual rows are simply
 * no longer counted; the legacy aggregate stops contributing but is preserved
 * verbatim as the historical record of pre-migration strikes.
 */
export const PAYMENT_STRIKE_ACTIVE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

/** The >=3 threshold at which a customer is restricted from filing claims. */
export const PAYMENT_STRIKE_RESTRICTION_THRESHOLD = 3;

/**
 * The canonical identity a strike is filed and counted under.
 *
 * This RE-EXPORTS the repository's existing normalization rather than adding a
 * second implementation. Every strike path — creation, the legacy aggregate
 * lookup, the individual lookup, the active count, and the admin clear — routes
 * through this one function, so "0712345678", "254712345678" and
 * "+254712345678" can never split into two separate strike histories.
 *
 * `auth.ts` is the canonical owner of that logic; importing it here (rather
 * than copying the rules) is what guarantees the two cannot diverge.
 */

/**
 * `expires_at` for a strike created at `createdAt`.
 *
 * Returns an ISO-compatible Date. Passing the creation time explicitly (rather
 * than reading the clock twice) keeps created_at and expires_at provably
 * consistent even if the two statements straddle a millisecond boundary.
 */
export function paymentStrikeExpiresAt(createdAt: Date = new Date()): Date {
  return new Date(createdAt.getTime() + PAYMENT_STRIKE_ACTIVE_WINDOW_MS);
}

/**
 * Whether a timestamp is still inside the active window.
 *
 * Strict `>`: at exactly the expiry instant the strike is no longer active, so
 * it stops contributing to the >=3 gate on the boundary, not one millisecond
 * later. A null timestamp (a legacy row that never recorded one) is NOT active,
 * because "we do not know when this happened" must not become "count this
 * forever" nor "silently count it now".
 */
export function isWithinActiveWindow(stamp: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!stamp) return false;
  const t = stamp instanceof Date ? stamp.getTime() : new Date(stamp).getTime();
  if (Number.isNaN(t)) return false;
  return t + PAYMENT_STRIKE_ACTIVE_WINDOW_MS > now.getTime();
}
