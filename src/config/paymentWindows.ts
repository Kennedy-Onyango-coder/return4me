// Canonical, server-authoritative payment timing policy for the claim lifecycle.
//
// WHY THIS MODULE EXISTS
//   The claim lifecycle and the individual M-Pesa (STK) attempt have TWO
//   DIFFERENT clocks, and conflating them was the defect this batch repairs.
//   Previously a single 15-minute number governed BOTH the CLAIM's payment
//   window and each payment session, so:
//     * a claimant who logged out, closed the browser, or simply took longer
//       than 15 minutes lost the claim, and
//     * nothing re-checked the provider after that short window, so a genuinely
//       completed M-Pesa payment (real money moved at IntaSend) could leave the
//       claim stuck in `pending_payment` forever.
//
//   Keeping both numbers in ONE module — imported by server.ts, the routes and
//   the DB-facing sweeps — is what stops a future edit from silently collapsing
//   the claim window back onto the per-attempt session window.
//
// THE TWO WINDOWS
//   CLAIM_PAYMENT_WINDOW_MS
//     The PRODUCT REQUIREMENT: once an Agent confirms a claimant in person, the
//     CLAIM stays in `pending_payment` for AT LEAST 24 hours. This is the source
//     of truth for checkClaimExpiry() (the lazy read-time check) and the expiry
//     sweep. It is NOT a browser timer and NOT the STK session window.
//
//   PAYMENT_SESSION_WINDOW_MS
//     A single STK attempt is short-lived: the customer must approve the prompt
//     on their handset within minutes. When one session expires the CLAIM is
//     untouched, and the claimant may open a FRESH session — as many times as
//     they need — for as long as the 24-hour CLAIM window remains open.

/** The claim-level payment window: 24 hours from `agent_confirmed_at`. */
export const CLAIM_PAYMENT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * The per-attempt STK/payment-session window. Deliberately far shorter than the
 * claim window: it bounds one M-Pesa prompt, not the claim's life.
 */
export const PAYMENT_SESSION_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * A duration in the two windows' own units, rendered for a HUMAN.
 *
 * WHY THIS EXISTS (E2-A)
 *   The UI has to tell the claimant which of the two clocks a sentence is about:
 *   the 24-hour CLAIM window, or the 15-minute PROMPT session. Typing "24 hours"
 *   and "15 minutes" by hand into each surface is how the two get conflated again
 *   — the exact drift this module was created to stop. Every user-facing duration
 *   is therefore derived from the constants above, so a future change to either
 *   number updates the copy instead of contradicting it.
 *
 * Whole hours are produced in HOURS, never collapsed into "1 day", because the
 * product states the claim window in hours ("within 24 hours of in-person
 * verification"): a copy that said "1 day" would be a different promise at a
 * boundary a claimant can see. Anything that is not a whole number of hours is
 * reported in whole minutes (both real windows are whole minutes).
 */
export function describePaymentWindow(ms: number): string {
  const minutes = Math.round(ms / (60 * 1000));
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** '24 hours' — the CLAIM window, spelled from CLAIM_PAYMENT_WINDOW_MS. */
export const CLAIM_PAYMENT_WINDOW_LABEL = describePaymentWindow(CLAIM_PAYMENT_WINDOW_MS);

/** '15 minutes' — ONE M-Pesa prompt, spelled from PAYMENT_SESSION_WINDOW_MS. */
export const PAYMENT_SESSION_WINDOW_LABEL = describePaymentWindow(PAYMENT_SESSION_WINDOW_MS);

/**
 * The authoritative deadline by which a `pending_payment` claim must be paid,
 * derived ONLY from the agent's in-person confirmation. Returns null when the
 * claim has not been agent-confirmed yet (so no window is open).
 */
export function claimPaymentDeadline(
  agentConfirmedAt: Date | string | null | undefined
): Date | null {
  if (!agentConfirmedAt) return null;
  const t = new Date(agentConfirmedAt).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + CLAIM_PAYMENT_WINDOW_MS);
}

/**
 * Has the claim's 24-hour payment window elapsed as of `now`? A claim with no
 * `agent_confirmed_at` has no open window and never counts as elapsed here.
 */
export function hasClaimPaymentWindowElapsed(
  agentConfirmedAt: Date | string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!agentConfirmedAt) return false;
  const t = new Date(agentConfirmedAt).getTime();
  if (Number.isNaN(t)) return false;
  return now - t > CLAIM_PAYMENT_WINDOW_MS;
}
