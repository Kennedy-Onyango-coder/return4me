// =============================================================================
// BATCH 3 â€” CUSTOMER NOTIFICATION PRODUCERS.
//
// WHAT THIS IS
//   The call sites that connect genuine, authoritative business transitions in
//   the claims/payments lifecycle to the Batch 1 customer notification user
//   layer, so the Notification Centre stops being permanently empty.
//
// WHY A SEPARATE MODULE
//   Every producer below answers the same two questions in the same way â€”
//   "who is the customer entitled to this?" and "must this still be attempted
//   if the notification itself fails?".  Having eight copies of those answers
//   spread across server.ts and the route modules is how one of them ends up
//   matching a phone number instead of an ownership row.  So the rules live
//   here, once, and each producer is a two-line call site.
//
// WHAT THIS IS NOT
//   * NOT a second notification abstraction.  Every producer calls the existing
//     `recordCustomerNotification` from services/customerNotifications.ts.  No
//     new table, no new writer, no new API.
//   * NOT a delivery path.  Nothing here calls NotificationService.notify, an SMS
//     provider, an email provider, sendCodeViaSms or any send helper.  These are
//     in-app records only, so there is no import to leak a delivery concept into
//     and a delivery outage cannot affect a business outcome.
//   * NOT an owner of business truth.  A producer runs AFTER the authoritative
//     transition has already committed, and can only ever add a row.  It cannot
//     move a claim, move money, or make a payment, claim, refund or handover
//     fail â€” see `produce()` below.
//
// -----------------------------------------------------------------------------
// RECIPIENT RESOLUTION â€” THE RULE THAT MATTERS MOST (section 12)
// -----------------------------------------------------------------------------
// A customer's identity comes from EXACTLY ONE source: the explicit
// `customer_claim_links` row that an authenticated customer creates by proving
// control of one specific claim (a fresh claim OTP plus that claim's own stored
// security answers).
//
// It is deliberately NEVER resolved from:
//   * claim.owner_phone   â€” a phone number is not an account. Matching it would
//                           let anyone who knows a number read another
//                           person's claim notifications.
//   * claim.owner_email   â€” same, and frequently absent.
//   * anything client-supplied (body / query / header / local storage).
//
// `getCustomerClaimLinkForClaim` reads at most one row, and
// `uq_customer_claim_links_claim UNIQUE (claim_id)` makes "a claim belongs to at
// most one customer" a database invariant rather than an application check â€” so
// this holds under a race too, not just in the common case.
//
// If no link exists, the producer returns null and writes NOTHING.  That is
// intentional fail-closed behaviour, not a gap to be filled later: the claim
// journey is legitimately anonymous-first (see customerClaimJourneyLink.test.ts,
// which pins that claim submit and verify-otp never require customer auth), so
// a claim can genuinely have no owning account, and a customer must never
// receive a notification for a claim they do not own.
// =============================================================================

import { db } from '../db/database.ts';
import { recordCustomerNotification } from './customerNotifications.ts';
import { containsForbiddenCustomerTerm } from '../config/customerNotifications.ts';

/**
 * The ownership gate.  claimId -> customerId, or null when the claim is not
 * linked to any customer account.
 *
 * Fails CLOSED on every path: an unreadable link table, a malformed row or a
 * thrown error all resolve to null, which means "write nothing".
 */
async function resolveClaimCustomerId(claimId: string): Promise<string | null> {
  try {
    const link = await db.getCustomerClaimLinkForClaim(claimId);
    const customerId = link?.customer_id;
    if (typeof customerId !== 'string' || customerId.trim() === '') return null;
    return customerId;
  } catch (error) {
    console.error('[CUSTOMER_NOTIFICATION_PRODUCER] Ownership lookup failed; writing nothing:', claimId, error);
    return null;
  }
}

interface ClaimProducerInput {
  claimId: string;
  category: 'claim_status' | 'payment_status';
  title: string;
  body: string;
}



/**
 * The single write path for every producer below.
 *
 * Three guarantees, in order:
 *
 *  1. FORBIDDEN-TERM GUARD (section 17).  Customer-facing copy is checked against
 *     the existing Batch 1 `containsForbiddenCustomerTerm` BEFORE it can be
 *     stored, so no provider name, transport word, internal-model term or status
 *     code can reach a customer even if a future edit introduces one.  Failing
 *     closed here means a bad string is dropped and logged rather than recorded.
 *
 *  2. OWNERSHIP (section 12).  Resolved from the explicit claim link alone.
 *     No link -> null -> nothing written.
 *
 *  3. NOTIFICATION FAILURE NEVER BECOMES BUSINESS FAILURE (section 14).  The
 *     catch block logs and returns null.  It does not throw, so a caller cannot
 *     roll back â€” or be made to look like it rolled back â€” a committed payment,
 *     handover, refund or claim transition because a row could not be inserted.
 *
 * Returns the new notification id, or null when nothing was written.
 */
async function produce(input: ClaimProducerInput): Promise<string | null> {
  const { claimId, category, title, body } = input;

  if (containsForbiddenCustomerTerm(title) || containsForbiddenCustomerTerm(body)) {
    console.error(
      '[CUSTOMER_NOTIFICATION_PRODUCER] Refusing to record a notification containing a forbidden customer-facing term.',
      { claimId, category, title },
    );
    return null;
  }

  const customerId = await resolveClaimCustomerId(claimId);
  if (!customerId) return null; // anonymous journey: fail closed.

  try {
    const { id } = await recordCustomerNotification({
      customerId,
      category,
      title,
      body,
      // The stable existing domain reference. Batch 1 groups on this and the
      // locked claim/payment split holds automatically: `claim_status` groups as
      // `claim` and `payment_status` as `payment_case`, so the same claim id
      // never merges a claim thread into a payment thread.
      businessReference: claimId,
    });
    return id;
  } catch (error) {
    // The business transition has ALREADY committed.  Log and move on: a
    // missing in-app row must never be reported as a failed payment, claim,
    // refund or handover.
    console.error('[CUSTOMER_NOTIFICATION_PRODUCER] Failed to record notification:', claimId, category, error);
    return null;
  }
}



// -----------------------------------------------------------------------------
// THE PRODUCERS
//
// Every one of these is called ONLY from a site that has already established
// that a REAL transition happened â€” a compare-and-swap that returned true, a
// guarded transition that reported `alreadyInState: false`, or a settlement that
// reported success.  None of them re-reads claim status to decide, and none of
// them may be moved to a generic "after transitionClaimStatus()" call site,
// because that method performs an explicit idempotent no-op when the claim is
// already in the target state.
// -----------------------------------------------------------------------------

/**
 * P1 â€” the claim's verification code was accepted and the claim is now awaiting
 * the agent's in-person confirmation.
 *
 * MUST be called after the claim/customer link has been attempted: the link is
 * created (or declined) later in the verify-otp flow than the transition
 * itself, so a producer placed next to the transition would run before the
 * customer it is notifying is resolvable and would write nothing.
 */
export function produceClaimVerificationAccepted(claimId: string): Promise<string | null> {
  return produce({
    claimId,
    category: 'claim_status',
    title: 'Verification successful',
    body: 'Your verification code was accepted. An agent will confirm the item before you continue with payment.',
  });
}

/** P2 â€” the agent confirmed in person that the item belongs to the claimant. */
export function produceAgentConfirmedViewing(claimId: string): Promise<string | null> {
  return produce({
    claimId,
    category: 'claim_status',
    title: 'Item confirmed',
    body: 'The agent confirmed your item. You can now continue with payment.',
  });
}

/**
 * P3 â€” this claim lost the race: another claimant completed payment for the same
 * item first, so this claim was auto-rejected.
 *
 * Deliberately NOT a generic "the claim is rejected" notification.  The caller
 * passes the specific claim that transitionClaimStatus actually moved, so a
 * claim that was skipped because it was already terminal, escrowed or disputed
 * produces nothing.
 */
export function produceClaimAutoRejectedFirstPayment(claimId: string): Promise<string | null> {
  return produce({
    claimId,
    category: 'claim_status',
    title: 'Claim closed',
    body: 'Another claimant completed payment for this item first. Your claim for this item is now closed.',
  });
}

/**
 * P5 â€” payment was confirmed and the funds are being held while the claim is
 * completed.
 *
 * Says "held safely" rather than naming the internal escrow concept, and carries
 * NO pickup code, transaction code, provider name, gateway code or error text.
 * The secret pickup code remains solely in the existing transient outbound
 * render(), exactly as before.
 */
export function producePaymentReceived(claimId: string): Promise<string | null> {
  return produce({
    claimId,
    category: 'payment_status',
    title: 'Payment received',
    body: 'Your payment was received and is being held safely while the claim is completed.',
  });
}

/** P6 â€” the physical handover completed and the claim entered settlement. */
export function produceItemHandedOver(claimId: string): Promise<string | null> {
  return produce({
    claimId,
    category: 'claim_status',
    title: 'Item handed over',
    body: 'Your item was handed over successfully.',
  });
}

/** P7 â€” settlement finalised and the claim is complete. */
export function produceClaimComplete(claimId: string): Promise<string | null> {
  return produce({
    claimId,
    category: 'claim_status',
    title: 'Claim complete',
    body: 'Your claim is complete.',
  });
}

/**
 * P8 - a dispute was resolved against this claim, and because the claimant had
 * already paid, their money is being returned to them.
 *
 * Emitted after resolveDispute() has committed, never inside its transaction,
 * so notification success cannot determine whether the dispute commits.
 */
export function produceClaimNotSuccessful(claimId: string): Promise<string | null> {
  return produce({
    claimId,
    category: 'payment_status',
    title: 'Claim not successful',
    body: 'Your claim was not successful. Your payment is being returned to you.',
  });
}

/** P9 - the refund was confirmed executed and the claim is finalised. */
export function produceRefundComplete(claimId: string): Promise<string | null> {
  return produce({
    claimId,
    category: 'payment_status',
    title: 'Refund complete',
    body: 'Your refund is complete.',
  });
}

