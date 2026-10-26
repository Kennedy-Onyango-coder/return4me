// =============================================================================
// ADMIN NOTIFICATION OUTBOX — API CLIENT (N9 operator surface)
// =============================================================================
// The ONE place the Admin Console talks to the two endpoints that already exist
// in src/server.ts for this purpose:
//
//   GET  /api/admin/notifications            (bounded operator read)
//   POST /api/admin/notifications/:id/retry  (authorized retry workflow)
//
// WHY THIS MODULE EXISTS (the same reasoning as services/adminAuditLogApi.ts)
//   1. The payload is a typed, privacy-bounded contract. mapAdminNotificationItem()
//      reads ONLY the fields named below, so a column added to the API later
//      cannot appear on screen by accident.
//   2. Both paths — and the query string — are built HERE. No component
//      hand-concatenates a URL. The server validates every filter and answers
//      400 for an unknown status/channel; this client therefore only sends
//      values from the documented sets.
//   3. It is REACT-FREE, so the request contract can be executed by tests in
//      this repository's node-only vitest environment.
//
// WHAT THIS CLIENT DELIBERATELY DOES NOT DO
//   * It never contacts a provider. Retry goes through the server's own
//     authorized workflow, which re-derives recipient and content from the
//     authoritative record and re-checks eligibility before dispatching.
//   * It never logs a request, a response or a row.
//   * It never renders a raw server body. Failure sentences are fixed,
//     codebase-written text; the only values read OUT of an error body are the
//     boolean `reviewRequired` flag on a 409 and the stable `outcome`/`detail`
//     codes on a 2xx retry response.
//   * It has no way to ask for more than the server's fixed 200-row window:
//     there is no offset, cursor or limit parameter in this contract, so none
//     is sent.
//
// THE RECIPIENT IS ALREADY MASKED
//   `recipientReference` is the server's masked reference (server.ts builds the
//   list from columns it has already deemed safe). This client passes it through
//   unchanged and contains no type for a full phone number, email address, OTP,
//   pickup code or message body — so no such value can reach a component by any
//   path from here.
// =============================================================================

import {
  NOTIFICATION_OUTBOX_SERVER_LIMIT,
  isNotificationOperatorStatus,
  isNotificationOutboxChannel,
  type NotificationOperatorStatus,
  type NotificationOutboxChannel,
} from '../config/notificationOutbox';
import { formatRecordedAt, payoutAgeLabel as recordedAgeLabel } from './adminPayoutReconciliationApi';
// Re-exported so a consumer of THIS client has one import site for everything it
// needs. The formatting rule stays owned by adminPayoutReconciliationApi.ts (the
// same function, not a copy), so the notification, audit and payout surfaces
// cannot disagree about how a recorded time is written.
export { formatRecordedAt };
// TYPE-ONLY on purpose: the retry outcome vocabulary is owned by the server's
// retry service (services/notificationRetry.ts). `import type` is erased at
// build time, so none of that module's db/email/provider imports are pulled
// into the browser bundle.
import type { NotificationRetryOutcome } from './notificationRetry';

/** Built here, once. No component builds this path. */
export const ADMIN_NOTIFICATIONS_PATH = '/api/admin/notifications';

/** The retry sub-path for one notification row. */
export function adminNotificationRetryPath(notificationId: string): string {
  return `${ADMIN_NOTIFICATIONS_PATH}/${encodeURIComponent(notificationId)}/retry`;
}

export type AdminNotificationsApiErrorKind =
  | 'unauthorized' // 401 — no/invalid session
  | 'forbidden' // 403 — authenticated but not an administrator
  | 'not_found' // 404 — the notification no longer exists
  | 'conflict' // 409 — the server refused this retry (may need a human decision)
  | 'invalid' // any other 4xx (includes a refused filter)
  | 'server' // 5xx — genuine server failure
  | 'malformed' // 2xx whose body was not the documented envelope
  | 'network' // the request never completed
  | 'aborted'; // deliberately cancelled (superseded by a newer read)

export class AdminNotificationsApiError extends Error {
  readonly kind: AdminNotificationsApiErrorKind;
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;
  /**
   * Set ONLY from a 409 body's `reviewRequired` flag, and only when it is
   * literally `true`. It tells the console that the server considers this row a
   * human decision ('unknown' / 'permanent_failure') rather than a transient
   * failure — the difference between "try again" and "do not".
   */
  readonly reviewRequired: boolean;

  constructor(
    kind: AdminNotificationsApiErrorKind,
    status: number,
    message: string,
    reviewRequired: boolean = false,
  ) {
    super(message);
    this.name = 'AdminNotificationsApiError';
    this.kind = kind;
    this.status = status;
    this.reviewRequired = reviewRequired;
  }

  get isAbort(): boolean {
    return this.kind === 'aborted';
  }
}

// ---------------------------------------------------------------------------
// THE READ MODEL
// ---------------------------------------------------------------------------

/**
 * One notification_events row as the console may render it.
 *
 * Every field is either a value the server sent or an explicit null. Nothing
 * here is derived, guessed or borrowed from a neighbouring row.
 */
export interface AdminNotificationRow {
  /** The row id the retry endpoint addresses. null means "not recorded". */
  id: string | null;
  eventType: string | null;
  channel: string | null;
  provider: string | null;
  /** The stored status, raw. Presentation decisions live in the panel. */
  status: string | null;
  /** The server's MASKED reference. Never a full phone number or address. */
  recipientReference: string | null;
  /** The server's sanitized error text, capped again here for display. */
  lastError: string | null;
  businessReference: string | null;
  retryClass: string | null;
  /**
   * The SERVER's verdict (isRetryableEventType(event_type)), not a client guess.
   * The console never re-derives this from the event type itself: if the
   * server's allow-list changes, the console follows it.
   */
  retryable: boolean;
  attemptCount: number | null;
  retryAttemptCount: number | null;
  createdAt: string | null;
  createdAtLabel: string;
  /** How long ago it was recorded: '3d', '4h', 'just now', or 'unknown'. */
  ageLabel: string;
  updatedAt: string | null;
  updatedAtLabel: string;
  sentAt: string | null;
  sentAtLabel: string;
  nextAttemptAt: string | null;
  nextAttemptAtLabel: string;
}

/** The window the server served, plus the rows in it. */
export interface AdminNotificationsWindow {
  rows: AdminNotificationRow[];
  /**
   * Rows actually readable in this response. Never a server-declared total: the
   * contract has none, so the console states exactly what it received.
   */
  returned: number;
  /** Event types the server currently declares retryable (its own list). */
  retryableEventTypes: string[];
  /**
   * True when the response filled the server's fixed 200-row window. The console
   * cannot know how many older failures exist beyond it, and says so rather than
   * implying the list is complete.
   */
  reachedServerCap: boolean;
}

/** Longest stored error line rendered. A stored blob cannot restructure the list. */
const LAST_ERROR_MAX_LENGTH = 400;

/**
 * A stored provider error, made safe for display.
 *
 * Control characters (including the newlines a stored message may contain) are
 * collapsed to single spaces and the text is capped. A missing or empty value
 * becomes '' and the UI says no error was recorded — it never borrows the
 * neighbouring row's text and never invents a summary. React escapes the text as
 * a second layer; this function exists so the value is also structurally
 * incapable of breaking the row.
 */
export function safeNotificationErrorText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length > LAST_ERROR_MAX_LENGTH
    ? `${normalized.slice(0, LAST_ERROR_MAX_LENGTH)}\u2026`
    : normalized;
}

/** A trimmed, non-empty string, or null. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A non-negative integer, or null when the payload did not carry one. */
function optionalCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/**
 * One response item -> one renderable row.
 *
 * Returns null only for an item that is not an object: such a value cannot be
 * rendered as a notification at all. An object missing fields is still a row —
 * its missing values render as "Not recorded", because dropping it would hide a
 * real failure record from the operator.
 */
export function mapAdminNotificationItem(item: unknown): AdminNotificationRow | null {
  if (!item || typeof item !== 'object') return null;
  const dto = item as Record<string, unknown>;

  const createdAt = optionalText(dto.createdAt);
  const updatedAt = optionalText(dto.updatedAt);
  const sentAt = optionalText(dto.sentAt);
  const nextAttemptAt = optionalText(dto.nextAttemptAt);

  return {
    id: optionalText(dto.id),
    eventType: optionalText(dto.eventType),
    channel: optionalText(dto.channel),
    provider: optionalText(dto.provider),
    status: optionalText(dto.status),
    recipientReference: optionalText(dto.recipientReference),
    lastError: safeNotificationErrorText(dto.lastError) || null,
    businessReference: optionalText(dto.businessReference),
    retryClass: optionalText(dto.retryClass),
    // Strict: only a literal `true` grants retryability. A missing, null or
    // truthy-but-not-boolean value leaves the row unretryable, which fails safe.
    retryable: dto.retryable === true,
    attemptCount: optionalCount(dto.attemptCount),
    retryAttemptCount: optionalCount(dto.retryAttemptCount),
    createdAt,
    createdAtLabel: formatRecordedAt(createdAt),
    ageLabel: recordedAgeLabel(createdAt),
    updatedAt,
    updatedAtLabel: formatRecordedAt(updatedAt),
    sentAt,
    sentAtLabel: formatRecordedAt(sentAt),
    nextAttemptAt,
    nextAttemptAtLabel: formatRecordedAt(nextAttemptAt),
  };
}

/**
 * The documented envelope -> the window the console renders.
 *
 * Throws 'malformed' when there is no notifications array: a body this client
 * cannot read is a failure, not an empty outbox. "No failed notifications" is a
 * claim the console must earn from a response it actually understood.
 */
export function mapAdminNotificationsWindow(body: unknown): AdminNotificationsWindow {
  const envelope = (body ?? {}) as { notifications?: unknown; retryableEventTypes?: unknown };
  if (!Array.isArray(envelope.notifications)) {
    throw new AdminNotificationsApiError('malformed', 200, 'The notification list could not be read.');
  }
  const rows = envelope.notifications
    .map(mapAdminNotificationItem)
    .filter((row): row is AdminNotificationRow => row !== null);
  const retryableEventTypes = Array.isArray(envelope.retryableEventTypes)
    ? envelope.retryableEventTypes
        .map((value) => optionalText(value))
        .filter((value): value is string => value !== null)
    : [];
  return {
    rows,
    returned: rows.length,
    retryableEventTypes,
    reachedServerCap: rows.length >= NOTIFICATION_OUTBOX_SERVER_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// THE REQUEST PATHS
// ---------------------------------------------------------------------------

export interface AdminNotificationFilters {
  /** One of the route's four failure statuses; '' / null means "all of them". */
  status?: NotificationOperatorStatus | '' | null;
  /** An exact event type; '' / null means "every event type". */
  eventType?: string | null;
  /** 'sms' | 'email'; '' / null means "both channels". */
  channel?: NotificationOutboxChannel | '' | null;
}

/**
 * The request path for one read. Pure, so the query string is unit-testable
 * without a network.
 *
 * Only documented values are ever sent: an unrecognised status or channel is
 * DROPPED rather than forwarded (the server would answer 400 and the operator
 * would see a failure for what is really a console bug).
 */
export function buildAdminNotificationsPath(filters: AdminNotificationFilters = {}): string {
  const params = new URLSearchParams();
  if (isNotificationOperatorStatus(filters.status)) params.set('status', filters.status);
  const eventType = typeof filters.eventType === 'string' ? filters.eventType.trim() : '';
  if (eventType) params.set('eventType', eventType);
  if (isNotificationOutboxChannel(filters.channel)) params.set('channel', filters.channel);
  const query = params.toString();
  return query ? `${ADMIN_NOTIFICATIONS_PATH}?${query}` : ADMIN_NOTIFICATIONS_PATH;
}

// ---------------------------------------------------------------------------
// FAILURE SENTENCES — fixed text, never echoed data
// ---------------------------------------------------------------------------

/** The operator-facing sentence for a failed READ. */
export function failureMessageForStatus(status: number): string {
  if (status === 401) return 'Your session has expired. Sign in again to read the notification outbox.';
  if (status === 403) return 'This account is not an administrator, so the notification outbox is not available.';
  if (status === 400) return 'Those filters are not ones the API accepts, so nothing was read.';
  if (status === 404) return 'The notification endpoints are not available on this build.';
  if (status >= 500) return 'The server could not produce the notification outbox. Nothing was changed by this read.';
  return 'The notification outbox could not be read.';
}

/** The operator-facing sentence for a failed RETRY. */
export function retryFailureMessageForStatus(status: number, reviewRequired: boolean = false): string {
  if (status === 401) return 'Your session has expired. Sign in again to retry a notification.';
  if (status === 403) return 'This account is not an administrator, so this notification cannot be retried.';
  if (status === 404) return 'That notification no longer exists, so nothing was re-sent.';
  if (status === 409) {
    return reviewRequired
      ? 'The server refused this retry: this notification needs a human decision, not a resend. Nothing was re-sent.'
      : 'The server refused this retry: the notification is no longer in a retryable state. Nothing was re-sent.';
  }
  if (status >= 500) return 'The server could not process the retry. Nothing was confirmed as re-sent.';
  return 'The retry could not be sent. Nothing was confirmed as re-sent.';
}

/** Map an HTTP status onto a kind. Kept separate so it is unit-testable. */
export function errorKindForStatus(status: number): AdminNotificationsApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server';
  return 'invalid';
}

// ---------------------------------------------------------------------------
// THE RETRY RESPONSE
// ---------------------------------------------------------------------------

/**
 * The server's retry verdict. `outcome` is a stable code from
 * services/notificationRetry.ts's NotificationRetryOutcome union, or null when
 * the body carried a value this console does not recognise — which is NEVER
 * treated as success.
 */
export interface AdminNotificationRetryOutcome {
  retried: boolean;
  outcome: NotificationRetryOutcome | null;
  /** A safe, bounded, server-written detail code. Never a provider payload. */
  detail: string | null;
}

/** The runtime mirror of the server's NotificationRetryOutcome union. */
const KNOWN_RETRY_OUTCOMES: readonly string[] = [
  'sent',
  'not_retryable_event',
  'not_a_retryable_state',
  'not_due_yet',
  'claim_lost',
  'missing_business_reference',
  'reconstruction_unavailable',
  'retry_budget_exhausted',
  'dispatch_failed',
  'dispatch_unknown',
];

/**
 * The documented retry envelope -> the verdict the console renders.
 *
 * `retried` is strict: only a literal `true` counts as a resend, so a body that
 * merely contains an outcome string cannot be read as a success.
 */
export function mapAdminNotificationRetryResponse(body: unknown): AdminNotificationRetryOutcome {
  const envelope = (body ?? {}) as { retried?: unknown; outcome?: unknown; detail?: unknown };
  const rawOutcome = optionalText(envelope.outcome);
  const outcome =
    rawOutcome && KNOWN_RETRY_OUTCOMES.includes(rawOutcome)
      ? (rawOutcome as NotificationRetryOutcome)
      : null;
  return {
    retried: envelope.retried === true,
    outcome,
    detail: optionalText(envelope.detail),
  };
}

/** A boolean field from an error body, strict: only a literal `true` is true. */
function readReviewRequired(body: unknown): boolean {
  const envelope = (body ?? {}) as { reviewRequired?: unknown };
  return envelope.reviewRequired === true;
}

/** Read an error body without ever letting a parse failure escape. */
async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// THE CALLS
// ---------------------------------------------------------------------------

/**
 * Read the bounded operator window: the notifications the API exposes for
 * operator attention (retryable failures, permanent failures, unknown outcomes
 * and pre-N9 'failed' rows), newest first, capped by the server at 200.
 *
 * GET only; nothing is written. The token is passed in by the caller, exactly as
 * the audit-log and payout-reconciliation clients do, so this module has no
 * opinion about where credentials come from. A read that never resolves (or is
 * superseded) throws 'aborted' and callers stay silent; every other failure
 * carries the fixed sentence the operator is shown.
 */
export async function fetchAdminNotifications(
  token: string | null,
  filters: AdminNotificationFilters = {},
  signal?: AbortSignal,
): Promise<AdminNotificationsWindow> {
  const path = buildAdminNotificationsPath(filters);

  let response: Response;
  try {
    response = await fetch(path, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal,
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new AdminNotificationsApiError('aborted', 0, 'Read cancelled.');
    }
    throw new AdminNotificationsApiError('network', 0, 'The notification outbox could not be reached.');
  }

  if (!response.ok) {
    throw new AdminNotificationsApiError(
      errorKindForStatus(response.status),
      response.status,
      failureMessageForStatus(response.status),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AdminNotificationsApiError('malformed', response.status, 'The notification list could not be read.');
  }

  return mapAdminNotificationsWindow(body);
}

/**
 * Ask the server to retry ONE already-recorded notification.
 *
 * This calls the server's own authorized workflow
 * (POST /api/admin/notifications/:id/retry). The server re-checks the event type
 * against its allow-list, re-checks the row's state, re-derives recipient and
 * content from the authoritative record, and dispatches through the existing
 * provider boundary. The browser never names a recipient and never renders a
 * message, so this call cannot be used to send arbitrary content.
 *
 * A refusal (409) is NOT a transport error — it is the server declining, and the
 * console must show it as a refusal rather than as success. It is modelled as a
 * typed error so a caller cannot accidentally treat a refusal as a resend.
 */
export async function retryAdminNotification(
  token: string | null,
  notificationId: string,
): Promise<AdminNotificationRetryOutcome> {
  if (!notificationId || !notificationId.trim()) {
    throw new AdminNotificationsApiError('invalid', 0, 'A notification id is required to retry.');
  }

  let response: Response;
  try {
    response = await fetch(adminNotificationRetryPath(notificationId.trim()), {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new AdminNotificationsApiError('aborted', 0, 'Retry cancelled.');
    }
    throw new AdminNotificationsApiError(
      'network',
      0,
      'The retry request could not be completed. Nothing was confirmed as re-sent.',
    );
  }

  if (!response.ok) {
    const body = response.status === 409 ? await readJsonSafely(response) : null;
    const reviewRequired = readReviewRequired(body);
    throw new AdminNotificationsApiError(
      errorKindForStatus(response.status),
      response.status,
      retryFailureMessageForStatus(response.status, reviewRequired),
      reviewRequired,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AdminNotificationsApiError(
      'malformed',
      response.status,
      'The server accepted the retry request but its answer could not be read. Re-read the row before acting again.',
    );
  }

  return mapAdminNotificationRetryResponse(body);
}
