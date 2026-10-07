// =============================================================================
// BATCH 1 — CUSTOMER NOTIFICATION USER LAYER POLICY.
//
// PURE: no db, no react, no express. This is the single place a customer-facing
// notification's CATEGORY, ESSENTIAL/OPTIONAL status, plain-language COPY, and
// DERIVED business state are decided. Routes, service and UI all read from
// here, so the three layers cannot drift apart.
//
// WHAT THIS IS NOT
//   This is the USER layer. It does not deliver anything. The delivery ledger
//   (db.notification_events, services/notificationService.ts) is untouched by
//   this file and remains the only thing that talks to a provider.
//
// WHY A NEW TABLE RATHER THAN notification_events (schema decision)
//   notification_events CANNOT be extended to serve this layer, for three
//   concrete reasons found by reading the actual table, not assumed:
//     1. It has NO customer id. Its only identity column is
//        `recipient_reference`, which is deliberately a MASKED address or
//        hash. Customer isolation (the authorization requirement) cannot be
//        expressed against a masked value.
//     2. Its channel CHECK constraint admits only 'sms' and 'email'. The
//        in-app channel is required to be the delivery fallback, and adding
//        'in_app' would mean rewriting a constraint N7/N8 depend on.
//     3. It is a DELIVERY LEDGER with one row per logical notification per
//        channel attempt, carrying provider names, error strings and retry
//        counters. Requirement 2 forbids exposing exactly those fields to a
//        customer, so serving history from it would mean projecting around
//        most of every row.
//   So the user layer gets its own customer-keyed table, linked to the delivery
//   ledger by event type + business reference, never by copying delivery
//   internals.
// =============================================================================

import { CLAIM_STATUS_VALUES, INACTIVE_CLAIM_STATUSES } from './claimStatuses.ts';

// -----------------------------------------------------------------------------
// CATEGORIES
//
// Derived from the notification_events structure that already exists, not
// invented: every category below groups real event_type values by what the
// RECIPIENT must do next.
// -----------------------------------------------------------------------------
export type CustomerNotificationCategory =
  | 'claim_status'
  | 'payment_status'
  | 'document_verification'
  | 'lost_report'
  | 'found_item_report'
  | 'account_security'
  | 'terms_service';

export const CUSTOMER_NOTIFICATION_CATEGORIES: readonly CustomerNotificationCategory[] = [
  'claim_status',
  'payment_status',
  'document_verification',
  'lost_report',
  'found_item_report',
  'account_security',
  'terms_service',
];

/**
 * ESSENTIAL vs OPTIONAL (requirement 7).
 *
 * ESSENTIAL cannot be disabled by the customer. The rule is derived from need,
 * not from channel: an essential notification is one whose absence would leave
 * the customer unable to act, unable to protect the account, or unaware of a
 * change they agreed to.
 *
 *   claim_status / payment_status — the customer must know what is happening to
 *     money or a claim they are party to.
 *   account_security — login and recovery events. Opting out of "someone tried
 *     to access your account" is never permitted.
 *   terms_service — a material change to the terms the customer agreed to.
 *   document_verification — "we need a clearer photo" is an action only the
 *     customer can take, and it gates their own claim.
 *
 *   lost_report / found_item_report — genuinely OPTIONAL: these are progress and
 *     match updates about something already submitted, and suppressing the
 *     outbound message does not strand the customer (the report and its matches
 *     stay visible in the app).
 */
const ESSENTIAL_CATEGORIES: ReadonlySet<CustomerNotificationCategory> = new Set<CustomerNotificationCategory>([
  'claim_status',
  'payment_status',
  'document_verification',
  'account_security',
  'terms_service',
]);

export function isEssentialCategory(category: string): boolean {
  return ESSENTIAL_CATEGORIES.has(category as CustomerNotificationCategory);
}

/**
 * Channels the CUSTOMER can control. These are the channels the system really
 * has today — 'sms' and 'email' (both enforced by
 * notification_events_channel_check) plus 'in_app' (this layer itself). No
 * channel is offered that cannot actually deliver.
 */
export type CustomerNotificationChannel = 'sms' | 'email' | 'in_app';

export const CUSTOMER_NOTIFICATION_CHANNELS: readonly CustomerNotificationChannel[] = [
  'in_app',
  'sms',
  'email',
];

/**
 * Whether a channel MAY be switched off at all.
 *
 * Essential notifications are not merely defaulted-on; they are not
 * configurable. The service and the API both call this, so an essential channel
 * cannot be disabled by any code path, including a crafted request body.
 */
export function isChannelConfigurable(
  category: string,
  channel: CustomerNotificationChannel,
): boolean {
  if (!isEssentialCategory(category)) return true;
  // In-app is the durable record of the notification itself; a customer who
  // turns off optional channels still keeps their in-app history.
  return channel === 'in_app';
}

// -----------------------------------------------------------------------------
// USER-FACING STATES (requirement 4)
//
// A notification is NOT a source of truth. Its state is DERIVED at read time
// from the authoritative underlying claim/report/payment row. That is why this
// is a pure function over a status string rather than a stored column.
// -----------------------------------------------------------------------------
export type CustomerNotificationState =
  | 'informational'
  | 'action_required'
  | 'pending'
  | 'completed'
  | 'expired';

export function isCustomerNotificationState(v: string): v is CustomerNotificationState {
  return (
    v === 'informational' ||
    v === 'action_required' ||
    v === 'pending' ||
    v === 'completed' ||
    v === 'expired'
  );
}

/**
 * Derive the customer-facing state of a claim-related notification from the
 * AUTHORITATIVE claim status.
 *
 * `now` past the notification's expiry always wins and yields 'expired'
 * regardless of the claim, because an expired notification is history and must
 * not present an action (requirements 1 and 14).
 *
 * An unknown/absent claim status yields 'informational', NOT 'action_required':
 * if we cannot confirm an action is still needed, we must not prompt for it.
 */
export function deriveClaimNotificationState(
  claimStatus: string | null | undefined,
  now: Date,
  expiresAt: Date | null | undefined,
): CustomerNotificationState {
  if (expiresAt != null && new Date(expiresAt).getTime() <= now.getTime()) return 'expired';
  if (!claimStatus) return 'informational';

  switch (claimStatus) {
    // Waiting on us or a third party; nothing for the customer to do now.
    case 'pending_verification':
    case 'awaiting_agent_confirmation':
    case 'pending_settlement':
    case 'escrow_held':
    case 'releasing':
    case 'refunding':
      return 'pending';

    // The claim is parked and the customer must supply payment.
    case 'pending_payment':
      return 'action_required';

    // Terminal successes.
    case 'released':
    case 'refunded':
      return 'completed';

    // Terminal failures. 'informational', not 'action_required': the claim is
    // closed, so any old prompt to act is obsolete.
    case 'rejected':
    case 'payment_window_expired':
    case 'disputed':
      return 'informational';

    default:
      return 'informational';
  }
}

/**
 * Whether a notification may still OFFER its action (requirement 4).
 *
 * Once the underlying state has moved on, the notification must stop presenting
 * an obsolete action. Deliberately narrow: only 'action_required' has an action,
 * and an expired notification has none at all.
 */
export function hasCustomerAction(state: CustomerNotificationState): boolean {
  return state === 'action_required';
}

// -----------------------------------------------------------------------------
// GROUPING (requirement 5)
//
// Group keys come from the STABLE EXISTING references already on
// notification_events.business_reference (a claim id, an item id, a customer
// id). No new correlation identifier is invented and no time-window heuristic is
// used: two events are the same thread only if they name the same reference.
// -----------------------------------------------------------------------------
export type CustomerNotificationGroupKind = 'claim' | 'lost_report' | 'found_item_report' | 'payment_case';

export interface CustomerNotificationGroup {
  kind: CustomerNotificationGroupKind;
  /** The stable existing reference, e.g. a claim id. Never a new invented id. */
  reference: string;
}

const CATEGORY_GROUP_KIND: Record<CustomerNotificationCategory, CustomerNotificationGroupKind> = {
  claim_status: 'claim',
  payment_status: 'payment_case',
  document_verification: 'claim',
  lost_report: 'lost_report',
  found_item_report: 'found_item_report',
  account_security: 'claim',
  terms_service: 'claim',
};

/**
 * The group a notification belongs to, or null when it has no stable reference
 * and must therefore stay standalone.
 */
export function notificationGroup(
  category: string,
  businessReference: string | null | undefined,
): CustomerNotificationGroup | null {
  if (!businessReference) return null;
  const kind = CATEGORY_GROUP_KIND[category as CustomerNotificationCategory];
  if (!kind) return null;
  return { kind, reference: businessReference };
}

export function groupKey(group: CustomerNotificationGroup): string {
  return `${group.kind}:${group.reference}`;
}

/**
 * Categories that remain individually visible even when they share a group,
 * because collapsing them would hide something the customer must act on or is
 * entitled to see on its own (requirement 5).
 */
const ALWAYS_INDIVIDUAL: ReadonlySet<CustomerNotificationCategory> = new Set<CustomerNotificationCategory>([
  'account_security',
  'terms_service',
]);

export function staysIndividual(category: string): boolean {
  return ALWAYS_INDIVIDUAL.has(category as CustomerNotificationCategory);
}

/**
 * Collapse a list of notifications into display groups WITHOUT losing anything.
 *
 * Grouping here is a PRESENTATION concern only: every input appears in exactly
 * one output bucket, and the individual entries are carried through intact, so
 * Notification History is unaffected. A group is only formed when at least two
 * entries share a group key; a lone entry stays standalone so the list does not
 * acquire folders containing one item.
 */
export interface CustomerNotificationGroupBucket<T = unknown> {
  key: string;
  kind: CustomerNotificationGroupKind;
  reference: string;
  notifications: T[];
}

export function groupNotifications<T extends { category: string; businessReference: string | null }>(
  items: readonly T[],
): Array<T | CustomerNotificationGroupBucket<T>> {
  const buckets = new Map<string, CustomerNotificationGroupBucket<T>>();
  const out: Array<T | CustomerNotificationGroupBucket<T>> = [];

  for (const item of items) {
    // An always-individual or ungrouped entry is emitted on its own, never
    // absorbed into a folder.
    if (staysIndividual(item.category)) {
      out.push(item);
      continue;
    }
    const group = notificationGroup(item.category, item.businessReference);
    if (!group) {
      out.push(item);
      continue;
    }
    const key = groupKey(group);
    const existing = buckets.get(key);
    if (existing) {
      existing.notifications.push(item);
    } else {
      const bucket: CustomerNotificationGroupBucket<T> = {
        key,
        kind: group.kind,
        reference: group.reference,
        notifications: [item],
      };
      buckets.set(key, bucket);
      out.push(bucket);
    }
  }

  // A single-member "group" is not a group; unwrap it so a case with one
  // notification is not hidden behind a folder heading.
  const flattened: Array<T | CustomerNotificationGroupBucket<T>> = [];
  for (const entry of out) {
    if (isBucket<T>(entry) && entry.notifications.length === 1) {
      flattened.push(entry.notifications[0]);
    } else {
      flattened.push(entry as T | CustomerNotificationGroupBucket<T>);
    }
  }
  return flattened;
}

function isBucket<T>(
  entry: T | CustomerNotificationGroupBucket<T>,
): entry is CustomerNotificationGroupBucket<T> {
  return typeof entry === 'object' && entry !== null && 'notifications' in entry;
}

// -----------------------------------------------------------------------------
// PLAIN-LANGUAGE COPY (requirement 10)
//
// Every customer-facing string lives here, using the repository's existing
// service vocabulary. The forbidden-term guard below is what keeps API, webhook,
// provider, retry and AI-model wording out of the UI; a test asserts every
// string this module can emit passes it.
// -----------------------------------------------------------------------------

const CATEGORY_LABEL: Record<CustomerNotificationCategory, string> = {
  claim_status: 'Claim update',
  payment_status: 'Payment update',
  document_verification: 'Document verification',
  lost_report: 'Lost item report',
  found_item_report: 'Found item report',
  account_security: 'Account security',
  terms_service: 'Terms and service',
};

export function categoryLabel(category: string): string {
  const entry = CATEGORY_LABEL[category as CustomerNotificationCategory];
  return entry ?? '';
}

const STATE_LABEL: Record<CustomerNotificationState, string> = {
  informational: 'Update',
  action_required: 'Action required',
  pending: 'In progress',
  completed: 'Completed',
  expired: 'Expired',
};

export function stateLabel(state: CustomerNotificationState): string {
  const entry = STATE_LABEL[state];
  return entry ?? '';
}

/**
 * Requirement 6's mandated wording for an unconfirmed payment.
 *
 * The critical product point is the SECOND sentence: while the outcome is
 * uncertain we must NOT tell the customer to pay again, because that risks a
 * double payment. It states what is true (confirmation not yet received) and
 * what not to do.
 */
export const PAYMENT_AWAITING_CONFIRMATION_MESSAGE = "Payment confirmation is pending. We haven't received confirmation yet. Please don't pay again.";

/**
 * Neutral fallback used when a delivery attempt failed but the business outcome
 * is still genuinely unknown. It states the position without blaming the
 * customer, without naming any provider, and without implying the payment or
 * claim itself failed.
 */
export const DELIVERY_FALLBACK_MESSAGE = "We're waiting to confirm an update. You can always see its current status here.";

/**
 * Requirement 10's forbidden-term guard.
 *
 * Transport, provider, infrastructure and internal-model vocabulary that must
 * never reach a customer. Deliberately checks word-ish substrings with spaces
 * where a bare word would false-positive on ordinary English ("provider" in
 * "providers", "api" inside "rapid" — guarded by requiring a boundary).
 */
const FORBIDDEN_CUSTOMER_TERMS: readonly string[] = [
  'api',
  'webhook',
  'provider',
  'retry',
  'ocr',
  'gemini',
  'ai ',
  'database',
  'token',
  'idempotency',
  'sms gateway',
  'resend',
  'africa',
  'intasend',
  'exception',
  'stack trace',
  'http',
  'endpoint',
  'payload',
];

export function containsForbiddenCustomerTerm(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = ` ${text.toLowerCase()} `;
  return FORBIDDEN_CUSTOMER_TERMS.some((term) => {
    const needle = term.trim();
    // Require a word boundary so "rapid" is not flagged for "api".
    const pattern = new RegExp(`(^|[^a-z])${needle}([^a-z]|$)`, 'i');
    return pattern.test(lower);
  });
}

// -----------------------------------------------------------------------------
// EXPIRY (requirement 1)
// -----------------------------------------------------------------------------

/** Active notifications stop being active after five days. */
export const CUSTOMER_NOTIFICATION_ACTIVE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

export function customerNotificationExpiresAt(createdAt: Date = new Date()): Date {
  return new Date(createdAt.getTime() + CUSTOMER_NOTIFICATION_ACTIVE_WINDOW_MS);
}

/**
 * Whether a notification is still ACTIVE at `now`.
 *
 * Deliberately independent of every retry field: an in-app notification can have
 * a pending redelivery scheduled and still be long past its active window, and a
 * fresh one can have no retry scheduled at all. Those are different facts, and
 * coupling them would let a delivery schedule change a customer's notification
 * list.
 *
 * A NULL expiry means "not expired by anything", which keeps notifications
 * created before the column existed visible rather than silently hidden.
 */
export function isActiveNotification(expiresAt: Date | null | undefined, now: Date): boolean {
  if (expiresAt == null) return true;
  return new Date(expiresAt).getTime() > now.getTime();
}

/** The closed claim-status vocabulary, re-exported so UI and tests agree. */
export const NOTIFICATION_CLAIM_STATUSES = CLAIM_STATUS_VALUES;
export const NOTIFICATION_INACTIVE_CLAIM_STATUSES = INACTIVE_CLAIM_STATUSES;