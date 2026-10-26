// =============================================================================
// N9 — ADMIN NOTIFICATION OUTBOX: THE CONSOLE'S CONTRACT CONSTANTS
// =============================================================================
// Every value here is READ FROM the existing server contract
// (src/server.ts, the N9 "notification failure operator surface": the
// GET /api/admin/notifications and POST /api/admin/notifications/:id/retry
// handlers). None of it is a console invention:
//
//   * NOTIFICATION_OPERATOR_STATUSES is the exact list the list route validates
//     a ?status= filter against (NOTIFICATION_OPERATOR_STATUSES in server.ts).
//     Any other value is answered with a 400 "Unknown notification status
//     filter.", so the console offers only these values.
//   * NOTIFICATION_CHANNELS mirrors that route's channel validation: `sms` and
//     `email` only, matching the N2 schema constraint in
//     config/notificationEvents.ts.
//   * NOTIFICATION_OUTBOX_SERVER_LIMIT is the fixed `limit: 200` the route
//     passes to db.listNotificationEventsByStatus. The contract carries NO
//     offset, NO cursor and NO total count, so ONE read can never return more
//     than this many rows. The console therefore pages those rows CLIENT-SIDE
//     and says so out loud (see NotificationOutboxPanel), rather than offering
//     a "next page" control that would silently re-read the same window and
//     imply records it never received.
//   * The page sizes below are the console's own presentation choice. Every one
//     of them is smaller than the server limit, so a page can never claim more
//     rows than the API could have sent.
//
// This module is PURE (no db, no fetch, no React), so both the client and its
// tests can use it, exactly like config/auditLogWindow.ts.
// =============================================================================

/** The failure statuses an operator may filter on — the route's own list. */
export const NOTIFICATION_OPERATOR_STATUSES = [
  'retryable_failure',
  'permanent_failure',
  'unknown',
  'failed',
] as const;

export type NotificationOperatorStatus = (typeof NOTIFICATION_OPERATOR_STATUSES)[number];

/** The two channels the N2 schema constrains. Not extensible without N2. */
export const NOTIFICATION_CHANNELS = ['sms', 'email'] as const;

export type NotificationOutboxChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * The server's fixed cap for one read (`limit: 200` in server.ts).
 *
 * Stated in the UI rather than hidden: when a read returns exactly this many
 * rows the console cannot know whether older failures exist, and it must say so
 * instead of presenting the window as the complete record.
 */
export const NOTIFICATION_OUTBOX_SERVER_LIMIT = 200;

/** Page sizes the console offers. All are below NOTIFICATION_OUTBOX_SERVER_LIMIT. */
export const NOTIFICATION_OUTBOX_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;

export const NOTIFICATION_OUTBOX_DEFAULT_PAGE_SIZE = 25;

/**
 * Is this one of the failure statuses the API accepts as a ?status= filter?
 *
 * Used to keep an invalid value from ever being sent (the server would answer
 * 400) and to keep a persisted/hand-edited state from being treated as a
 * filter the API supports.
 */
export function isNotificationOperatorStatus(value: unknown): value is NotificationOperatorStatus {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_OPERATOR_STATUSES as readonly string[]).includes(value)
  );
}

/** Is this one of the two channels the API accepts as a ?channel= filter? */
export function isNotificationOutboxChannel(value: unknown): value is NotificationOutboxChannel {
  return typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}
