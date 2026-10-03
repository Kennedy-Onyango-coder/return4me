/**
 * N9 — NOTIFICATION FAILURE RECOVERY.
 *
 * Retry of a failed notification, kept STRICTLY separate from the original
 * dispatch path in notificationService.ts.
 *
 * WHY NOT `NotificationService.notify()`
 *   `notify()` returns early on an existing idempotency key, before rendering and
 *   before dispatching. That guard is what makes N5/N6/N7/N8 duplicate
 *   suppression correct, and retrying through it would simply be reported as a
 *   duplicate. So retry is a SEPARATE, explicitly-invoked operation that reuses
 *   the same durable row, the same provider boundary and the same template
 *   builders, while leaving the original idempotency key untouched.
 *
 * WHAT RETRY DELIBERATELY DOES NOT DO
 *   It re-renders and re-dispatches a MESSAGE. It never re-runs the business
 *   transaction that produced the notification — no payment confirmation, no
 *   handover settlement, no claim transition, no reassignment. Those already
 *   happened and are already guarded by their own compare-and-swap claims
 *   (attemptClaimEscrowHold, attemptSettlementRelease); re-running one because an
 *   email failed is precisely the duplication those CAS updates prevent.
 *
 * WHAT RETRY DELIBERATELY CANNOT DO
 *   Nothing here can produce a secret. Every template in this registry was proven
 *   to need no one-time secret, and the nine secret-bearing events are refused
 *   before any database or provider call. Recipient and content are both
 *   re-derived from the authoritative domain record, so neither a plaintext
 *   address nor a rendered body is ever persisted or logged.
 */
import { db } from '../db/database.ts';
import { getNotificationPolicy, type NotificationRetryClass } from '../config/notificationEvents.ts';
import { getAdminNotificationEmail } from '../config/adminNotificationEmail.ts';
import {
  NOTIFICATION_RETRY_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_SWEEP_BATCH,
  nextNotificationRetryAt,
} from '../config/notificationRetryPolicy.ts';
import {
  renderSendAgentPaymentConfirmedEmail,
  renderSendItemHandedOverEmail,
  renderSendFinderItemCollectedEmail,
  renderSendAdminTransactionLogEmail,
  renderSendAdminNewReassignmentRequestEmail,
} from './email.ts';
import {
  sanitizeProviderError,
  type ProviderDeliveryResult,
} from './notificationProviders.ts';
import { __getEmailProviderForRetry } from './notificationService.ts';

// ---------------------------------------------------------------------------
// THE ALLOW-LIST.
//
// Five events. A closed, statically-typed set — NOT a callback map, NOT
// something serializable, and NOT derived from a caller-supplied flag. A request
// for any other event type is refused here, before any database or provider call.
// ---------------------------------------------------------------------------

export type RetryableEventType =
  | 'AGENT_PAYMENT_CONFIRMED'
  | 'ITEM_HANDED_OVER'
  | 'FINDER_ITEM_COLLECTED'
  | 'ADMIN_TRANSACTION_LOG'
  | 'ADMIN_REASSIGNMENT';

export const RETRYABLE_EVENT_TYPES: readonly RetryableEventType[] = [
  'AGENT_PAYMENT_CONFIRMED',
  'ITEM_HANDED_OVER',
  'FINDER_ITEM_COLLECTED',
  'ADMIN_TRANSACTION_LOG',
  'ADMIN_REASSIGNMENT',
];

export function isRetryableEventType(eventType: string): eventType is RetryableEventType {
  return (RETRYABLE_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * PAYMENT_RECEIVED earns its own refusal constant because it is the most
 * operationally important email in the product and is still NOT retryable: the
 * pickup code it exists to deliver is persisted only as a hash, so the message
 * cannot be rebuilt. Regenerating that code is expressly out of scope — it would
 * invalidate a code the owner is on their way to use.
 */
export const PAYMENT_RECEIVED_NOT_RETRYABLE =
  'payment_received_carries_a_one_time_pickup_code_that_is_not_reconstructable';
export const EVENT_NOT_RETRYABLE = 'event_type_is_not_retryable';

/** What a resolver must return. Recipient and content are BOTH re-derived. */
export interface ReconstructedNotification {
  recipient: string;
  subject: string;
  body: string;
}

type Resolver = (businessReference: string) => Promise<ReconstructedNotification | null>;

/**
 * The item's display name, derived exactly as every existing call site does:
 * the category's English name, else the same literal. Categories are read live,
 * matching current behaviour.
 */
async function resolveItemName(itemId: string): Promise<string> {
  const item = await db.getItem(itemId);
  if (!item) return 'Found Document / Item';
  if (item.category_id) {
    const categories = await db.getCategories();
    const category = categories.find((c: any) => c.id === item.category_id);
    if (category) return category.name_en;
  }
  return 'Found Document / Item';
}

/**
 * The amount shown in an admin transaction log, derived from the SAME durable
 * sources the live call sites use: the item's locked fee if set, else the
 * category's current fee, else '0.00'. Preserved exactly.
 */
async function resolveTransactionLogAmount(itemId: string): Promise<string> {
  const item = await db.getItem(itemId);
  if (!item) return '0.00';
  if (item.locked_total_fee !== undefined && item.locked_total_fee !== null) {
    return String(item.locked_total_fee);
  }
  if (item.category_id) {
    const categories = await db.getCategories();
    const category = categories.find((c: any) => c.id === item.category_id);
    if (category) return String(category.total_fee);
  }
  return '0.00';
}
async function resolveAgentPaymentConfirmed(businessReference: string): Promise<ReconstructedNotification | null> {
  const claim = await db.getClaim(businessReference);
  if (!claim || !claim.item_id) return null;
  const item = await db.getItem(claim.item_id);
  if (!item) return null;
  const agent = item.assigned_agent_id ? await db.getAgent(item.assigned_agent_id) : null;
  const recipient = agent?.contact_email;
  if (!recipient || recipient.trim() === '') return null;
  const itemName = await resolveItemName(item.id);
  const rendered = renderSendAgentPaymentConfirmedEmail(
    recipient,
    agent!.business_name,
    itemName,
    item.id,
    claim.id,
  );
  return { recipient, subject: rendered.subject, body: rendered.body };
}

async function resolveItemHandedOver(businessReference: string): Promise<ReconstructedNotification | null> {
  const claim = await db.getClaim(businessReference);
  if (!claim || !claim.item_id) return null;
  const recipient = claim.owner_email;
  if (!recipient || recipient.trim() === '') return null;
  const itemName = await resolveItemName(claim.item_id);
  // Render-time date, exactly as the live call site computes it. A retry can
  // therefore differ from the original email by the displayed date — accepted
  // cosmetic drift, documented here rather than hidden.
  const dateStr = new Date().toLocaleDateString('en-KE', {
    timeZone: 'Africa/Nairobi',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const rendered = renderSendItemHandedOverEmail(
    recipient,
    claim.owner_phone,
    itemName,
    claim.item_id,
    dateStr,
  );
  return { recipient, subject: rendered.subject, body: rendered.body };
}

async function resolveFinderItemCollected(businessReference: string): Promise<ReconstructedNotification | null> {
  const claim = await db.getClaim(businessReference);
  if (!claim || !claim.item_id) return null;
  const item = await db.getItem(claim.item_id);
  if (!item || !item.finder_email || item.finder_email.trim() === '') return null;
  const itemName = await resolveItemName(item.id);
  const rendered = renderSendFinderItemCollectedEmail(item.finder_email, itemName, item.id);
  return { recipient: item.finder_email, subject: rendered.subject, body: rendered.body };
}

/**
 * ADMIN_TRANSACTION_LOG carries a SUBTYPE inside its business reference
 * (`<subtype>:<claimId>`). Both subtypes are reconstructable and must not be
 * collapsed, or a handover log would be resent as a payment log.
 */
async function resolveAdminTransactionLog(businessReference: string): Promise<ReconstructedNotification | null> {
  const recipient = getAdminNotificationEmail();
  if (!recipient) return null;

  const sep = businessReference.indexOf(':');
  if (sep <= 0) return null;
  const subtype = businessReference.slice(0, sep);
  if (subtype !== 'PAYMENT_CONFIRMED' && subtype !== 'HANDOVER_CONFIRMED_PENDING_SETTLEMENT') {
    return null;
  }
  const claimId = businessReference.slice(sep + 1);
  const claim = await db.getClaim(claimId);
  if (!claim || !claim.item_id) return null;
  const item = await db.getItem(claim.item_id);
  if (!item) return null;
  const agent = item.assigned_agent_id ? await db.getAgent(item.assigned_agent_id) : null;
  const amount = await resolveTransactionLogAmount(item.id);
  const rendered = renderSendAdminTransactionLogEmail(
    subtype as 'PAYMENT_CONFIRMED' | 'HANDOVER_CONFIRMED_PENDING_SETTLEMENT',
    claim.id,
    item.id,
    amount,
    agent ? agent.business_name : 'Unknown Agent',
  );
  return { recipient, subject: rendered.subject, body: rendered.body };
}

/**
 * Reconstructed purely from the item: its own id is the drop-off code shown in
 * the subject, and both the location description and the finder phone are NOT
 * NULL columns persisted from the very same variables the live call site renders.
 * Nothing here is a secret.
 */
async function resolveAdminReassignment(businessReference: string): Promise<ReconstructedNotification | null> {
  const recipient = getAdminNotificationEmail();
  if (!recipient) return null;
  const item = await db.getItem(businessReference);
  if (!item) return null;
  if (!item.location_description || !item.finder_phone) return null;
  const rendered = renderSendAdminNewReassignmentRequestEmail(
    item.id,
    item.location_description,
    item.finder_phone,
  );
  return { recipient, subject: rendered.subject, body: rendered.body };
}

/**
 * THE CLOSED REGISTRY. Five entries, statically named. No generic callback
 * escape hatch and nothing serialized: neither an operator nor a corrupted row
 * can cause arbitrary code to run.
 */
const RESOLVERS: Readonly<Record<RetryableEventType, Resolver>> = {
  AGENT_PAYMENT_CONFIRMED: resolveAgentPaymentConfirmed,
  ITEM_HANDED_OVER: resolveItemHandedOver,
  FINDER_ITEM_COLLECTED: resolveFinderItemCollected,
  ADMIN_TRANSACTION_LOG: resolveAdminTransactionLog,
  ADMIN_REASSIGNMENT: resolveAdminReassignment,
};
export type NotificationRetryOutcome =
  | 'sent'
  | 'not_retryable_event'
  | 'not_a_retryable_state'
  | 'not_due_yet'
  | 'claim_lost'
  | 'missing_business_reference'
  | 'reconstruction_unavailable'
  | 'retry_budget_exhausted'
  | 'dispatch_failed'
  | 'dispatch_unknown';

export interface NotificationRetryResult {
  ok: boolean;
  outcome: NotificationRetryOutcome;
  eventId: string | null;
  /** Safe, bounded, never a provider payload. */
  detail?: string | null;
}

/**
 * Retry ONE already-recorded notification.
 *
 * `alreadyClaimed` is set by the sweep, which has ALREADY performed the
 * compare-and-swap; the operator path lets this function perform it. Either way
 * exactly one caller reaches the provider for a given row.
 */
export async function retryNotificationEvent(
  eventId: string,
  options: { alreadyClaimed?: boolean } = {},
): Promise<NotificationRetryResult> {
  // --- 1. Load the durable row ------------------------------------------------
  const event = await db.getNotificationEventById(eventId);
  if (!event) {
    return { ok: false, outcome: 'not_a_retryable_state', eventId, detail: 'no_such_notification' };
  }

  // --- 2. Eligibility, BEFORE any database write or provider call -------------
  //
  // Three independent guards, because each closes a different hole:
  //   (a) the catalogue policy — the single source of truth;
  //   (b) the retry_class frozen onto THIS row when it was created;
  //   (c) the static allow-list — what code actually exists to rebuild it.
  const policy = getNotificationPolicy(event.event_type);
  const catalogueClass: NotificationRetryClass | null = policy?.retryClass ?? null;
  const rowClass = event.retry_class ?? null;
  if (!isRetryableEventType(event.event_type)) {
    return {
      ok: false,
      outcome: 'not_retryable_event',
      eventId,
      detail: event.event_type === 'PAYMENT_RECEIVED'
        ? PAYMENT_RECEIVED_NOT_RETRYABLE
        : EVENT_NOT_RETRYABLE,
    };
  }
  if (catalogueClass !== 'reconstructable' || rowClass !== 'reconstructable') {
    return { ok: false, outcome: 'not_retryable_event', eventId, detail: EVENT_NOT_RETRYABLE };
  }

  // --- 3. State and due-time -------------------------------------------------
  //
  // The sweep claims a row by moving it to 'sending' and THEN calls us with
  // alreadyClaimed, so the state this caller legitimately owns is 'sending'.
  // Requiring 'retryable_failure' here would make every sweep-dispatched retry
  // refuse itself and leave the row stranded mid-flight forever.
  const ownsClaim = options.alreadyClaimed === true;
  const acceptableStatus = ownsClaim ? 'sending' : 'retryable_failure';
  if (event.status !== acceptableStatus) {
    return { ok: false, outcome: 'not_a_retryable_state', eventId, detail: `status_${event.status}` };
  }
  const nextAttemptAt = event.next_attempt_at ? new Date(event.next_attempt_at) : null;
  if (!nextAttemptAt || Number.isNaN(nextAttemptAt.getTime())) {
    return { ok: false, outcome: 'not_due_yet', eventId, detail: 'no_scheduled_attempt' };
  }
  if (nextAttemptAt.getTime() > Date.now()) {
    return { ok: false, outcome: 'not_due_yet', eventId, detail: 'scheduled_in_future' };
  }

  // --- 4. Budget -------------------------------------------------------------
  const attemptsSoFar = Number(event.retry_attempt_count ?? 0);
  if (attemptsSoFar >= NOTIFICATION_RETRY_MAX_ATTEMPTS) {
    await db.markNotificationEventFailedWithClass(event.id, 'retry_budget_exhausted', 'permanent_failure', null);
    return { ok: false, outcome: 'retry_budget_exhausted', eventId };
  }

  // --- 5. Claim (compare-and-swap) -------------------------------------------
  // Skipped when the sweep already won the claim on our behalf.
  if (!ownsClaim) {
    const claimed = await db.claimNotificationRetry(event.id);
    if (!claimed) return { ok: false, outcome: 'claim_lost', eventId };
  }
// --- 6. Reconstruct from the authoritative domain record -------------------
  const businessReference: string | null = event.business_reference ?? null;
  if (!businessReference || businessReference.trim() === '') {
    // Fail CLOSED and terminate: a row with no domain reference can never be
    // rebuilt, so it becomes permanent rather than being guessed at.
    await db.markNotificationEventFailedWithClass(event.id, 'missing_business_reference', 'permanent_failure', null);
    return { ok: false, outcome: 'missing_business_reference', eventId };
  }

  let reconstructed: ReconstructedNotification | null;
  try {
    reconstructed = await RESOLVERS[event.event_type as RetryableEventType](businessReference);
  } catch (error) {
    await db.markNotificationEventFailedWithClass(event.id, sanitizeProviderError(error), 'permanent_failure', null);
    return { ok: false, outcome: 'reconstruction_unavailable', eventId, detail: 'resolver_threw' };
  }
  if (!reconstructed) {
    // The underlying record is gone or incomplete. Never fabricate content.
    await db.markNotificationEventFailedWithClass(event.id, 'reconstruction_unavailable', 'permanent_failure', null);
    return { ok: false, outcome: 'reconstruction_unavailable', eventId };
  }

  // --- 7. Dispatch through the SAME provider boundary ------------------------
  let result: ProviderDeliveryResult;
  try {
    result = await __getEmailProviderForRetry().send(
      reconstructed.recipient, reconstructed.subject, reconstructed.body,
    );
  } catch (error) {
    result = {
      accepted: false,
      providerMessageId: null,
      error: sanitizeProviderError(error),
      failureClass: 'unknown',
    };
  }

  if (result.accepted) {
    await db.recordNotificationRetryOutcome({
      id: event.id, accepted: true, providerMessageId: result.providerMessageId ?? null, nextAttemptAt: null,
    });
    return { ok: true, outcome: 'sent', eventId };
  }

  // --- 8. Record the outcome -------------------------------------------------
  //
  // An ambiguous outcome is TERMINAL. Resending could duplicate a message the
  // provider may already have accepted, and for an owner that means two handover
  // or payment emails. 'unknown' is exactly the state that says a human must
  // decide, and it is never scheduled.
  const failureClass = result.failureClass ?? 'unknown';
  if (failureClass !== 'retryable_failure') {
    await db.markNotificationEventFailedWithClass(
      event.id, sanitizeProviderError(result.error ?? 'retry_failed'), 'permanent_failure', null,
    );
    return {
      ok: false,
      outcome: failureClass === 'unknown' ? 'dispatch_unknown' : 'dispatch_failed',
      eventId,
    };
  }

  const attemptNumber = attemptsSoFar + 1;
  const exhausted = attemptNumber >= NOTIFICATION_RETRY_MAX_ATTEMPTS;
  await db.recordNotificationRetryOutcome({
    id: event.id,
    accepted: false,
    error: sanitizeProviderError(result.error ?? 'retry_failed'),
    nextAttemptAt: exhausted ? null : nextNotificationRetryAt(attemptNumber),
  });
  if (exhausted) return { ok: false, outcome: 'retry_budget_exhausted', eventId };
  return { ok: false, outcome: 'dispatch_failed', eventId };
}

/**
 * The retry sweep. Work is DISCOVERED BY THE DATABASE — a single
 * compare-and-swap that returns only the rows THIS caller won — then processed
 * one at a time with per-row isolation, so one poisonous row cannot stop the
 * rest and can never crash the server process.
 */
export async function runNotificationRetrySweep(): Promise<{ claimed: number; sent: number }> {
  let claimedIds: string[] = [];
  try {
    claimedIds = await db.claimDueNotificationRetries(NOTIFICATION_RETRY_SWEEP_BATCH);
  } catch (error) {
    console.error('[NOTIFICATION RETRY SWEEP] Failed to claim work:', error);
    return { claimed: 0, sent: 0 };
  }

  let sent = 0;
  for (const id of claimedIds) {
    try {
      const result = await retryNotificationEvent(id, { alreadyClaimed: true });
      if (result.ok) sent += 1;
    } catch (error) {
      console.error(`[NOTIFICATION RETRY SWEEP] Unexpected error retrying ${id}:`, error);
    }
  }
  return { claimed: claimedIds.length, sent };
}