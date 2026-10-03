// =============================================================================
// BATCH 1 — CUSTOMER NOTIFICATION USER LAYER (service).
//
// WHAT THIS IS
//   The customer-facing projection of "something happened that concerns you".
//   It reads and writes the three customer_notifications* tables and derives
//   every user-facing state from the AUTHORITATIVE domain record at read time.
//
// WHAT THIS IS NOT — the boundary that matters most in this batch
//   This service NEVER touches notification_events, never dispatches anything,
//   never retries anything, and never reports delivery. It has no provider
//   import and cannot send a message even if asked to.
//
// WHY DELIVERY FAILURE IS NOT BUSINESS FAILURE (requirement 6)
//   Two completely separate records exist:
//     * notification_events  — DELIVERY. status/last_error/next_attempt_at.
//     * customer_notifications — BUSINESS. What the customer is told happened.
//   A failed SMS writes `retryable_failure` to the FIRST and nothing at all to
//   the second. There is therefore no code path by which a provider error can
//   mark a payment, claim, refund or verification as failed — the fields that
//   would say so live in different tables and are written by different code.
//   `recordDeliveryFallback` is the only bridge, and it creates an in-app
//   notification from the BUSINESS fact the caller already holds; it never
//   receives, stores or renders an error string.
// =============================================================================

import { and, desc, eq, gt, isNull } from 'drizzle-orm';
// The Drizzle handle is exported as `db` from src/db/index.ts — a DIFFERENT
// binding from the data-access class in db/database.ts. Aliased so both stay
// readable and cannot be confused for one another.
import { db as drizzleDb } from '../db/index.ts';
import {
  customer_notifications as customerNotificationsTable,
  customer_notification_prefs as customerNotificationPrefsTable,
  customer_notification_pref_audit as customerNotificationPrefAuditTable,
  claims as claimsTable,
  customer_claim_links as customerClaimLinksTable,
} from '../db/schema.ts';
import {
  CUSTOMER_NOTIFICATION_CATEGORIES,
  CUSTOMER_NOTIFICATION_CHANNELS,
  customerNotificationExpiresAt,
  deriveClaimNotificationState,
  hasCustomerAction,
  isActiveNotification,
  isChannelConfigurable,
  isEssentialCategory,
  isCustomerNotificationState,
  type CustomerNotificationCategory,
  type CustomerNotificationChannel,
  type CustomerNotificationState,
} from '../config/customerNotifications.ts';
import { generateSecureId } from './customerAuth.ts';

/** A customer notification as the API and UI see it. Contains no internals. */
export interface CustomerNotificationView {
  id: string;
  category: string;
  title: string;
  body: string | null;
  /** The customer's own case/report reference, or null. */
  reference: string | null;
  /** Derived at read time from the authoritative domain record. */
  state: CustomerNotificationState;
  /** True only while an action is genuinely still valid. */
  actionAvailable: boolean;
  /** Where "act" should take the customer, when an action is available. */
  actionPath: string | null;
  read: boolean;
  readAt: string | null;
  expired: boolean;
  createdAt: string;
  expiresAt: string;
  /** True when this arrived in-app because an outbound message did not. */
  viaFallback: boolean;
}

function isKnownCategory(v: string): v is CustomerNotificationCategory {
  return (CUSTOMER_NOTIFICATION_CATEGORIES as readonly string[]).includes(v);
}

function isKnownChannel(v: string): v is CustomerNotificationChannel {
  return (CUSTOMER_NOTIFICATION_CHANNELS as readonly string[]).includes(v);
}

// -----------------------------------------------------------------------------
// CREATION
// -----------------------------------------------------------------------------

export interface RecordCustomerNotificationInput {
  customerId: string;
  category: string;
  title: string;
  body?: string | null;
  businessReference?: string | null;
  /**
   * Whether this row exists because an outbound DELIVERY fell back to in-app.
   * Recorded so the UI can be honest without ever revealing why delivery failed.
   */
  viaFallback?: boolean;
  /** Explicit expiry, for tests and for reproducing a historical window. */
  createdAt?: Date;
}

/**
 * Record a notification for a customer. ALWAYS writes the in-app row.
 *
 * In-app is unconditional for an ESSENTIAL category and is the delivery fallback
 * for everything else, so the in-app record of an essential notification exists
 * even if every outbound channel is unavailable. Preferences gate OUTBOUND
 * delivery only and are never consulted here — see applyPreference.
 */
export async function recordCustomerNotification(
  input: RecordCustomerNotificationInput,
): Promise<{ id: string }> {
  if (!isKnownCategory(input.category)) {
    throw new Error(`Unknown customer notification category: ${input.category}`);
  }
  const createdAt = input.createdAt ?? new Date();
  const id = generateSecureId('CN');
  await drizzleDb.insert(customerNotificationsTable).values({
    id,
    customer_id: input.customerId,
    category: input.category,
    title: input.title,
    body: input.body ?? null,
    business_reference: input.businessReference ?? null,
    read_at: null,
    expires_at: customerNotificationExpiresAt(createdAt),
    created_via_fallback: input.viaFallback ?? false,
    created_at: createdAt,
  });
  return { id };
}

/**
 * The ONLY bridge from delivery back into the user layer.
 *
 * Deliberately takes no error, no provider, no status code and no attempt
 * count — the caller passes the BUSINESS fact it already holds, and nothing
 * about the failure reaches this function's arguments. That is what makes it
 * structurally impossible for a delivery error to become customer-visible text
 * or to alter a business outcome.
 */
export async function recordDeliveryFallback(input: RecordCustomerNotificationInput) {
  return recordCustomerNotification({ ...input, viaFallback: true });
}
// -----------------------------------------------------------------------------
// READING
//
// EVERY read in this file is scoped by customer_id. That is the whole of the
// authorization model for the layer: there is no query that can return a row
// without naming its owner, so a caller who passes the wrong customer id gets
// an empty result rather than someone else's data. Hiding a button in the UI is
// never the control — `markNotificationRead` re-checks ownership in its WHERE
// clause for the same reason.
// -----------------------------------------------------------------------------

/** Where a notification's action sends the customer. Never an external URL. */
function actionPathFor(category: string, reference: string | null): string | null {
  if (!reference) return null;
  switch (category) {
    case 'payment_status':
      return `/account/claims/${reference}`;
    case 'claim_status':
    case 'document_verification':
      return `/account/claims/${reference}`;
    case 'lost_report':
      return `/account/lost-reports/${reference}`;
    case 'found_item_report':
      return `/account/found-reports/${reference}`;
    default:
      return null;
  }
}

/**
 * Look up the AUTHORITATIVE claim status for a claim reference, but ONLY where
 * this customer is the linked claimant.
 *
 * The join through customer_claim_links is the security control, and it is in
 * the SQL rather than in application logic: a claim belonging to someone else
 * produces NO ROW, not a row the caller might forget to filter. Combined with the
 * caller always passing the reference off one of THIS customer's own
 * notifications, this cannot be used to probe for another customer's claim
 * existence. An unlinked or unknown reference yields null, which downgrades the
 * state to 'informational' and removes the action — fail-closed, never fail-open.
 */
async function authoritativeClaimStatus(
  customerId: string,
  reference: string | null,
): Promise<string | null> {
  if (!reference) return null;
  try {
    // TWO STEPS, not one joined query, and the reason is worth recording.
    //
    // The obvious `claims INNER JOIN customer_claim_links ON ... WHERE
    // claims.id = ? AND customer_claim_links.customer_id = ?` returns NO ROWS on
    // the project's in-memory test database whenever the WHERE clause constrains
    // the joined table — verified directly, not assumed: the same join with no
    // WHERE returns the row, and a WHERE on either side alone returns nothing.
    // An authorization check that silently returns "no access" under test, and
    // under any sandbox-backed run, would make this layer untestable at exactly
    // the point it matters most.
    //
    // Resolving the link first and then reading the claim is equivalent for this
    // purpose and is what the rest of the repository does for claim visibility.
    // It is ALSO strictly no weaker: the link is fetched BY OWNER, so the only
    // claim ids it can return are ones this customer is already linked to.
    const links = await drizzleDb
      .select({ claimId: customerClaimLinksTable.claim_id })
      .from(customerClaimLinksTable)
      .where(
        and(
          eq(customerClaimLinksTable.customer_id, customerId),
          eq(customerClaimLinksTable.claim_id, reference),
        ),
      )
      .limit(1);

    // No link row => this customer is not the claimant => no status, hence no
    // action. Fail-closed, and never an existence oracle: a stranger's claim
    // reference produces exactly the same empty result as a bogus one.
    const claimId = links[0]?.claimId;
    if (!claimId) return null;

    const claims = await drizzleDb
      .select({ status: claimsTable.status })
      .from(claimsTable)
      .where(eq(claimsTable.id, claimId))
      .limit(1);
    return claims[0]?.status ?? null;
  } catch {
    // A lookup failure must never invent an action. Falling through to
    // 'informational' is the safe direction: the customer sees less, not more.
    return null;
  }
}

function toView(
  row: typeof customerNotificationsTable.$inferSelect,
  state: CustomerNotificationState,
  now: Date,
): CustomerNotificationView {
  const expired = !isActiveNotification(row.expires_at, now);
  const actionAvailable = hasCustomerAction(state);
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body,
    reference: row.business_reference,
    state,
    actionAvailable,
    // An expired notification has no action even if its category would
    // otherwise provide one: it is history, and history does not demand things.
    actionPath: actionAvailable ? actionPathFor(row.category, row.business_reference) : null,
    read: row.read_at != null,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    expired,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    viaFallback: row.created_via_fallback,
  };
}

export interface ListOptions {
  now?: Date;
  limit?: number;
}

/**
 * The ACTIVE list (requirement 1).
 *
 * Expiry is applied HERE, as a filter, rather than by a sweep that deletes or
 * mutates rows. Nothing is ever removed from the database, so History keeps the
 * record and `read_at` survives the transition untouched.
 */
export async function listActiveCustomerNotifications(
  customerId: string,
  options: ListOptions = {},
): Promise<CustomerNotificationView[]> {
  const now = options.now ?? new Date();
  const rows = await drizzleDb
    .select()
    .from(customerNotificationsTable)
    .where(
      and(
        eq(customerNotificationsTable.customer_id, customerId),
        gt(customerNotificationsTable.expires_at, now),
      ),
    )
    .orderBy(desc(customerNotificationsTable.created_at))
    .limit(options.limit ?? 100);

  return Promise.all(rows.map((row) => projectRow(row, now)));
}

/**
 * NOTIFICATION HISTORY (requirement 2).
 *
 * Everything the customer has been notified about, newest first, INCLUDING
 * expired and completed entries. Expiry is expressed as a derived `expired` flag
 * and a derived `state`, never by absence — that is the difference between
 * history and a deletion.
 */
export async function listCustomerNotificationHistory(
  customerId: string,
  options: ListOptions = {},
): Promise<CustomerNotificationView[]> {
  const now = options.now ?? new Date();
  const rows = await drizzleDb
    .select()
    .from(customerNotificationsTable)
    .where(eq(customerNotificationsTable.customer_id, customerId))
    .orderBy(desc(customerNotificationsTable.created_at))
    .limit(options.limit ?? 200);
  return Promise.all(rows.map((row) => projectRow(row, now)));
}

/** Derive the state for one row against the authoritative domain record. */
async function projectRow(
  row: typeof customerNotificationsTable.$inferSelect,
  now: Date,
): Promise<CustomerNotificationView> {
  const claimStatus = await authoritativeClaimStatus(row.customer_id, row.business_reference);
  const state = deriveClaimNotificationState(claimStatus, now, row.expires_at);
  return toView(row, state, now);
}

/** Unread count for the indicator badge. Counts ACTIVE unread only. */
export async function countUnreadActive(customerId: string, now: Date = new Date()): Promise<number> {
  const rows = await drizzleDb
    .select({ id: customerNotificationsTable.id })
    .from(customerNotificationsTable)
    .where(
      and(
        eq(customerNotificationsTable.customer_id, customerId),
        isNull(customerNotificationsTable.read_at),
        gt(customerNotificationsTable.expires_at, now),
      ),
    );
  return rows.length;
}

// -----------------------------------------------------------------------------
// READ STATE (requirement 3)
// -----------------------------------------------------------------------------

/**
 * Mark a notification read.
 *
 * PERSISTED SERVER-SIDE, in the `read_at` column rather than in component state or
 * browser storage, so it survives a new session, a new device and a restart.
 * The WHERE clause names BOTH the id and the customer_id. That is deliberate:
 * authorization belongs in the query, so a request that guesses another
 * customer's notification id matches nothing and reports "not found" rather than
 * silently marking someone else's notification. A hidden button is not a
 * control; this is.
 *
 * Idempotent: an already-read notification keeps its ORIGINAL timestamp rather
 * than being restamped, so "when did you first see this" stays stable.
 *
 * Returns false when the notification does not exist for this customer, which
 * covers "no such id" and "not yours" identically on purpose — telling those
 * apart would be an existence oracle for another customer's data.
 */
export async function markNotificationRead(
  customerId: string,
  notificationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await drizzleDb
    .update(customerNotificationsTable)
    .set({ read_at: now })
    .where(
      and(
        eq(customerNotificationsTable.id, notificationId),
        eq(customerNotificationsTable.customer_id, customerId),
        isNull(customerNotificationsTable.read_at),
      ),
    )
    .returning({ id: customerNotificationsTable.id });
  return rows.length > 0;
}

/**
 * Read one notification, scoped to its owner. Opening IS marking read, so the
 * route does both and the customer is never asked to click a separate
 * "mark as read" control for the ordinary case.
 */
export async function openCustomerNotification(
  customerId: string,
  notificationId: string,
  now: Date = new Date(),
): Promise<CustomerNotificationView | null> {
  await markNotificationRead(customerId, notificationId, now);
  const rows = await drizzleDb
    .select()
    .from(customerNotificationsTable)
    .where(
      and(
        eq(customerNotificationsTable.id, notificationId),
        eq(customerNotificationsTable.customer_id, customerId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return projectRow(row, now);
}

// -----------------------------------------------------------------------------
// PREFERENCES (requirements 7 and 8)
// -----------------------------------------------------------------------------

export interface CustomerPreferenceView {
  category: string;
  essential: boolean;
  channels: Array<{ channel: string; enabled: boolean; configurable: boolean }>;
}

export interface SetPreferenceResult {
  applied: boolean;
  category: string;
  channel: string;
  enabled: boolean;
  /** A short, safe reason when `applied` is false. Never internal vocabulary. */
  reason?: string;
}

/** Current preferences, with the effective value for every category/channel. */
export async function getCustomerPreferences(
  customerId: string,
): Promise<CustomerPreferenceView[]> {
  const rows = await drizzleDb
    .select()
    .from(customerNotificationPrefsTable)
    .where(eq(customerNotificationPrefsTable.customer_id, customerId));
  const disabled = new Map<string, boolean>();
  for (const r of rows) disabled.set(`${r.category}:${r.channel}`, r.disabled);

  return CUSTOMER_NOTIFICATION_CATEGORIES.map((category) => ({
    category,
    essential: isEssentialCategory(category),
    channels: CUSTOMER_NOTIFICATION_CHANNELS.map((channel) => ({
      channel,
      // ABSENT ROW = ENABLED. Never defaulting a customer to "nothing" is what
      // guarantees an essential notification is never lost.
      enabled: !(disabled.get(`${category}:${channel}`) ?? false),
      configurable: isChannelConfigurable(category, channel),
    })),
  }));
}

/**
 * Whether an OUTBOUND channel is currently permitted for a category.
 *
 * Called by the delivery path immediately before dispatch, which is what makes
 * preference changes PROSPECTIVE (requirement 8): a change affects notifications
 * sent after it, and cannot retroactively un-send anything already delivered nor
 * alter history.
 *
 * An essential category always returns true, regardless of any stored row — a
 * second, independent guard behind isChannelConfigurable, so even a corrupted or
 * hand-inserted preference row cannot suppress an essential notification. An
 * unknown category or channel also returns true: fail safe, deliver.
 */
export async function applyPreference(
  customerId: string,
  category: string,
  channel: CustomerNotificationChannel,
): Promise<boolean> {
  if (isEssentialCategory(category)) return true;
  if (channel === 'in_app') return true; // the durable in-app record is never suppressed
  if (!isKnownCategory(category) || !isKnownChannel(channel)) return true;
  const rows = await drizzleDb
    .select({ disabled: customerNotificationPrefsTable.disabled })
    .from(customerNotificationPrefsTable)
    .where(
      and(
        eq(customerNotificationPrefsTable.customer_id, customerId),
        eq(customerNotificationPrefsTable.category, category),
        eq(customerNotificationPrefsTable.channel, channel),
      ),
    )
    .limit(1);
  return !(rows[0]?.disabled ?? false);
}

/**
 * Apply a preference change (requirements 7 and 8).
 *
 * PROSPECTIVE BY CONSTRUCTION: this writes only preference state and an audit
 * row. It touches no notification row, so an already-sent notification stays in
 * History untouched and no required action is cancelled.
 *
 * ESSENTIAL IS ENFORCED HERE, server-side, from the CATEGORY rather than from
 * the payload. A request to disable an essential channel is REFUSED, the stored
 * preference is left alone, and the refusal is recorded with applied = false, so
 * a crafted request body cannot suppress a required notification.
 */
export async function setCustomerPreference(
  customerId: string,
  category: string,
  channel: string,
  enabled: boolean,
): Promise<SetPreferenceResult> {
  if (!isKnownCategory(category)) throw new Error('Unknown notification category.');
  if (!isKnownChannel(channel)) throw new Error('Unknown notification channel.');

  const existing = await drizzleDb
    .select({ disabled: customerNotificationPrefsTable.disabled })
    .from(customerNotificationPrefsTable)
    .where(
      and(
        eq(customerNotificationPrefsTable.customer_id, customerId),
        eq(customerNotificationPrefsTable.category, category),
        eq(customerNotificationPrefsTable.channel, channel),
      ),
    )
    .limit(1);
  const previousDisabled = existing[0]?.disabled ?? null;

  // The essential-notification guard. Refuse rather than silently ignore, and
  // record the refusal so the audit distinguishes it from a no-op.
  if (!enabled && !isChannelConfigurable(category, channel)) {
    await writePrefAudit(customerId, category, channel, previousDisabled, false, false);
    return {
      applied: false,
      category,
      channel,
      enabled: true,
      reason: 'This notification is required and cannot be switched off.',
    };
  }

  const disabled = !enabled;
  if (existing.length === 0) {
    await drizzleDb.insert(customerNotificationPrefsTable).values({
      id: generateSecureId('CNP'),
      customer_id: customerId,
      category,
      channel,
      disabled,
      created_at: new Date(),
      updated_at: new Date(),
    });
  } else {
    await drizzleDb
      .update(customerNotificationPrefsTable)
      .set({ disabled, updated_at: new Date() })
      .where(
        and(
          eq(customerNotificationPrefsTable.customer_id, customerId),
          eq(customerNotificationPrefsTable.category, category),
          eq(customerNotificationPrefsTable.channel, channel),
        ),
      );
  }

  await writePrefAudit(customerId, category, channel, previousDisabled, disabled, true);
  return { applied: true, category, channel, enabled };
}

/** Append-only. Never updated, never deleted. */
async function writePrefAudit(
  customerId: string,
  category: string,
  channel: string,
  previousDisabled: boolean | null,
  newDisabled: boolean,
  applied: boolean,
): Promise<void> {
  await drizzleDb.insert(customerNotificationPrefAuditTable).values({
    id: generateSecureId('CNA'),
    customer_id: customerId,
    category,
    channel,
    previous_disabled: previousDisabled,
    new_disabled: newDisabled,
    applied,
    created_at: new Date(),
  });
}

/** The customer's own preference-change audit trail, newest first. */
export async function listCustomerPreferenceAudit(customerId: string) {
  return drizzleDb
    .select()
    .from(customerNotificationPrefAuditTable)
    .where(eq(customerNotificationPrefAuditTable.customer_id, customerId))
    .orderBy(desc(customerNotificationPrefAuditTable.created_at));
}
