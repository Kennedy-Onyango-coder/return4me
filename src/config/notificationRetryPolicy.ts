// N9 — NOTIFICATION RETRY POLICY.
//
// The timing rules live here, in config, rather than in either the dispatch path
// or the retry path, because BOTH need them: notificationService schedules the
// first retry after a definite transient failure, and notificationRetry schedules
// each subsequent one. Putting them in the retry module would make the dispatch
// path import the retry module, and the retry module already imports the
// dispatch path — a cycle. A pure policy module is the natural third home, and
// it matches the existing src/config/* convention (sentryDsn, serverPort,
// adminNotificationEmail all follow it).
//
// These values are notification-SPECIFIC and are deliberately NOT inherited from
// the social-publication retry sweep. An email arriving hours late to an owner
// waiting on a handover confirmation is close to worthless, so the cap is tight
// and the budget is finite.

/** First retry waits 5 minutes: long enough for a blip to clear, short enough to matter. */
export const NOTIFICATION_RETRY_BASE_DELAY_MS = 5 * 60 * 1000;

/** Growth factor between attempts: 5m, 20m, 80m, 5h20m, 21h20m. */
export const NOTIFICATION_RETRY_MULTIPLIER = 4;

/** Hard ceiling on any single wait. */
export const NOTIFICATION_RETRY_MAX_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * A finite, conservative budget. A notification that has failed this many times
 * is not going to start succeeding, and repeatedly hammering a provider that has
 * already refused a valid address is worse than giving up. Once exhausted the row
 * becomes `permanent_failure` with next_attempt_at = NULL.
 */
export const NOTIFICATION_RETRY_MAX_ATTEMPTS = 5;

/** How many due retries one sweep pass may claim. Bounds the work per pass. */
export const NOTIFICATION_RETRY_SWEEP_BATCH = 25;

/**
 * The delay before retry number `attempt` (1-based).
 *
 * The exponent is CLAMPED before use, so this can never overflow into an
 * Infinity or NaN date however large the stored counter becomes — a corrupted row
 * must not be able to produce an unparseable timestamp that would then be
 * persisted and break the sweep's date comparison.
 */
export function notificationRetryDelayMs(attempt: number): number {
  const n = Math.max(0, Math.min(20, Math.floor(attempt)));
  const raw = NOTIFICATION_RETRY_BASE_DELAY_MS * Math.pow(NOTIFICATION_RETRY_MULTIPLIER, n);
  return Math.min(NOTIFICATION_RETRY_MAX_DELAY_MS, raw);
}

export function nextNotificationRetryAt(attempt: number): Date {
  return new Date(Date.now() + notificationRetryDelayMs(attempt));
}