// =============================================================================
// ADMIN NOTIFICATION OUTBOX — PRESENTATION / READ MODEL
// =============================================================================
// Every decision this screen makes about WORDS lives here, as pure functions, so
// it can be executed by this repository's node-only vitest environment (the same
// approach as admin/payouts/payoutIntegrityPresentation.ts and
// admin/audit/AuditLogWindowTable.tsx's emptyWindowCopy).
//
// THE RULES THIS FILE ENFORCES
//   1. Vocabulary comes from the server, never from a prettifier that could
//      disagree with it. A status this console does not recognise is SAID to be
//      unrecognised and is treated as "a person must look at this" — never as
//      retryable, never as delivered.
//   2. Retry eligibility is decided from the server's own `retryable` flag AND
//      the row's stored status, because the route enforces both (an event type
//      the allow-list rebuilds, in a `retryable_failure` state).
//   3. A missing value is never rendered as an empty cell and never as a zero:
//      it is either NOT_RECORDED_TEXT or, where a number is involved, an
//      explicit "not recorded" phrase.
//   4. Nothing here invents a recipient, a message body or a success. The
//      recipient shown is the server's masked reference, passed through as-is.
// =============================================================================

import type { AdminNotificationRow } from '../../../services/adminNotificationsApi';
import type {
  NotificationOperatorStatus,
  NotificationOutboxChannel,
} from '../../../config/notificationOutbox';

/** What the console writes when the payload did not carry a value. */
export const NOT_RECORDED_TEXT = 'Not recorded';

export type NotificationStatusTone = 'warning' | 'danger' | 'neutral' | 'pending';

export interface NotificationStatusDescription {
  /** The visible label. Text carries the meaning; colour only reinforces it. */
  label: string;
  tone: NotificationStatusTone;
  /** One sentence an operator can act on. */
  meaning: string;
}

/**
 * What a stored notification status MEANS for an operator.
 *
 * The four statuses the operator list can return are described from the server's
 * own definitions (server.ts NOTIFICATION_OPERATOR_STATUSES and the N9 retry
 * policy in services/notificationRetry.ts). 'sent' is included defensively so a
 * future widening of the list cannot render a delivered row as unknown; every
 * other value is reported as unrecognised, which is treated as unsafe.
 */
export function describeNotificationStatus(status: string | null): NotificationStatusDescription {
  switch (status) {
    case 'retryable_failure':
      return {
        label: 'Retryable failure',
        tone: 'warning',
        meaning: 'The provider refused or failed this delivery, and the message can be rebuilt and re-sent.',
      };
    case 'permanent_failure':
      return {
        label: 'Permanent failure',
        tone: 'danger',
        meaning: 'The provider failed this delivery in a way a resend will not fix. A person must decide what happens next.',
      };
    case 'unknown':
      return {
        label: 'Unknown outcome',
        tone: 'danger',
        meaning: 'The provider answer could not be read. The message may already have arrived, so a resend risks a duplicate.',
      };
    case 'failed':
      return {
        label: 'Failed (recorded before retry support)',
        tone: 'danger',
        meaning: 'Recorded before retryable failures were distinguished. This build never retries it.',
      };
    case 'sent':
      return { label: 'Sent', tone: 'pending', meaning: 'Recorded as delivered.' };
    case null:
    case '':
      return {
        label: NOT_RECORDED_TEXT,
        tone: 'neutral',
        meaning: 'This row does not carry a status this console can read.',
      };
    default:
      return {
        label: `Unrecognised status — ${status}`,
        tone: 'neutral',
        meaning: 'This console does not recognise this status, so the row is treated as needing a person to review it.',
      };
  }
}

/** The channel, in the schema's own vocabulary. */
export function describeNotificationChannel(channel: string | null): string {
  if (channel === 'sms') return 'SMS';
  if (channel === 'email') return 'Email';
  if (!channel) return NOT_RECORDED_TEXT;
  return `Unrecognised channel — ${channel}`;
}

/** The provider that attempted delivery, or an explicit missing marker. */
export function describeNotificationProvider(provider: string | null): string {
  return provider && provider.trim() ? provider.trim() : NOT_RECORDED_TEXT;
}

/** The event type, rendered as the code it is — never prettified into prose. */
export function describeNotificationEventType(eventType: string | null): string {
  return eventType && eventType.trim() ? eventType.trim() : NOT_RECORDED_TEXT;
}

/**
 * Whether the stored retry class says the message can be rebuilt.
 *
 * This is DESCRIPTIVE. Retryability itself is decided by the server's per-row
 * `retryable` flag (see retryEligibility) — this function only explains why.
 */
export function describeRetryClass(retryClass: string | null): string {
  if (retryClass === 'reconstructable') return 'Rebuildable from the record';
  if (retryClass === 'not_retryable') return 'Not rebuildable';
  if (!retryClass) return NOT_RECORDED_TEXT;
  return `Unrecognised retry class — ${retryClass}`;
}

/**
 * The attempt history in words.
 *
 * A payload that carries no counts says so. It never prints "0 attempts", which
 * would read as "nothing was tried" instead of "not recorded".
 */
export function describeAttempts(
  row: Pick<AdminNotificationRow, 'attemptCount' | 'retryAttemptCount'>,
): string {
  const attempts = row.attemptCount;
  const retries = row.retryAttemptCount;
  if (attempts === null && retries === null) return 'Attempts not recorded';
  const attemptText = attempts === null
    ? 'attempts not recorded'
    : `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`;
  const retryText = retries === null
    ? 'retries not recorded'
    : `${retries} ${retries === 1 ? 'retry' : 'retries'}`;
  return `${attemptText}, ${retryText}`;
}

export interface NotificationRetryEligibility {
  /** True only when the server would accept a retry for this row as it stands. */
  allowed: boolean;
  /** The short line the table renders. Explains a refusal; states availability. */
  reason: string;
}

/**
 * May this row be retried?
 *
 * The route's own preconditions (server.ts POST /api/admin/notifications/:id/retry):
 *   * the row id must exist (404 otherwise);
 *   * the event type must be in the retry allow-list (`retryable` on the row);
 *   * the stored status must be exactly 'retryable_failure' (409 otherwise).
 *
 * All three are mirrored here so the console does not offer a control the server
 * would refuse — and so a refusal is explained BEFORE the click rather than
 * discovered afterwards. The server still enforces every one of them; this is a
 * courtesy, never the control.
 */
export function retryEligibility(row: AdminNotificationRow): NotificationRetryEligibility {
  if (!row.id) {
    return {
      allowed: false,
      reason: 'No notification id was recorded, so the retry endpoint cannot address this row.',
    };
  }
  if (!row.retryable) {
    return {
      allowed: false,
      reason: 'The server does not rebuild this notification type, so it cannot be re-sent.',
    };
  }
  if (row.status !== 'retryable_failure') {
    const shown = row.status ? `'${row.status}'` : 'not recorded';
    return {
      allowed: false,
      reason: `Only a retryable failure can be re-sent; this one is ${shown}.`,
    };
  }
  return {
    allowed: true,
    reason: 'The server can rebuild and re-send this message. The retry is recorded against your administrator session.',
  };
}

export type RetryClickPlan =
  | { action: 'open-confirmation' }
  | { action: 'ignored'; why: 'in-flight' | 'already-confirming' }
  | { action: 'refused'; reason: string };

export interface RetryClickState {
  row: AdminNotificationRow;
  /** The row id currently being retried, or null when nothing is in flight. */
  inFlightId: string | null;
  /** The row awaiting confirmation, or null when no dialog is open. */
  confirmingId: string | null;
}

/**
 * Decide what a click on "Retry" may do.
 *
 * This is the duplicate-submission guard, expressed as a pure function so it is
 * testable without a DOM:
 *   * while ANY retry is in flight nothing else may start (the server has no
 *     idempotency key for this call, so two clicks must never become two sends);
 *   * a second click on the row already awaiting confirmation does nothing;
 *   * an ineligible row is refused with the same sentence the table shows.
 */
export function planRetryClick({ row, inFlightId, confirmingId }: RetryClickState): RetryClickPlan {
  if (inFlightId !== null) return { action: 'ignored', why: 'in-flight' };
  if (confirmingId !== null && confirmingId === row.id) {
    return { action: 'ignored', why: 'already-confirming' };
  }
  const eligibility = retryEligibility(row);
  if (!eligibility.allowed) return { action: 'refused', reason: eligibility.reason };
  return { action: 'open-confirmation' };
}

// ---------------------------------------------------------------------------
// CLIENT-SIDE PAGINATION OVER THE SERVER'S ONE BOUNDED READ
// ---------------------------------------------------------------------------

export interface OutboxPage<T> {
  rows: T[];
  /** The page actually shown: always within 1..pageCount. */
  page: number;
  pageCount: number;
  total: number;
  /** 1-based index of the first shown row, or null when the page is empty. */
  firstIndex: number | null;
  /** 1-based index of the last shown row, or null when the page is empty. */
  lastIndex: number | null;
}

/**
 * Page the rows the console actually received.
 *
 * The API has no offset and no cursor, so this is NOT server paging and must
 * never be described as such: it slices the response already in hand. A page
 * number outside the range is CLAMPED to the nearest real page rather than
 * rendering an empty table for a range that does not exist (which would read as
 * "no failures" after a filter change).
 */
export function paginateOutbox<T>(rows: readonly T[], page: number, pageSize: number): OutboxPage<T> {
  const total = rows.length;
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.trunc(pageSize) : 25;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const requested = Number.isFinite(page) ? Math.trunc(page) : 1;
  const current = Math.min(Math.max(requested, 1), pageCount);
  const start = (current - 1) * size;
  const slice = rows.slice(start, start + size);
  return {
    rows: slice,
    page: current,
    pageCount,
    total,
    firstIndex: slice.length > 0 ? start + 1 : null,
    lastIndex: slice.length > 0 ? start + slice.length : null,
  };
}

// ---------------------------------------------------------------------------
// WHAT A RETRY ACTUALLY DID
// ---------------------------------------------------------------------------

/**
 * The sentence an operator reads after a retry attempt.
 *
 * Each of the server's ten outcomes gets its own wording, because most of them
 * are REFUSALS and each refusal has a different next step for a person. None of
 * them is softened into "done", and an unrecognised outcome is explicitly
 * reported as unreadable rather than assumed.
 */
export function describeRetryOutcome(outcome: string | null): string {
  switch (outcome) {
    case 'sent':
      return 'The server re-sent this notification and recorded the delivery as sent.';
    case 'not_retryable_event':
      return 'The server refused: this event type cannot be rebuilt, so nothing was re-sent.';
    case 'not_a_retryable_state':
      return 'The server refused: the row is no longer in a retryable state, so nothing was re-sent.';
    case 'not_due_yet':
      return 'The server refused: this retry is not due yet under the retry policy, so nothing was re-sent.';
    case 'claim_lost':
      return 'The server refused: another worker claimed this row first, so nothing was re-sent by you.';
    case 'missing_business_reference':
      return 'The server refused: the row carries no business reference to rebuild the message from, so nothing was re-sent.';
    case 'reconstruction_unavailable':
      return 'The server refused: the message could not be rebuilt from the current records (the recipient or source record is missing), so nothing was re-sent.';
    case 'retry_budget_exhausted':
      return 'The server refused: this row has used its whole retry budget, so nothing was re-sent.';
    case 'dispatch_failed':
      return 'The provider rejected the re-send. The row remains a failure; only the attempt was recorded.';
    case 'dispatch_unknown':
      return 'The provider gave no readable answer. The notification may or may not have arrived — verify with the provider before acting again.';
    default:
      return 'The server did not report an outcome this console recognises. Treat the row as unchanged and re-read it before acting again.';
  }
}

// ---------------------------------------------------------------------------
// EMPTY STATES AND THE SERVER'S CAP
// ---------------------------------------------------------------------------

export interface OutboxFilterSummary {
  status: NotificationOperatorStatus | '';
  eventType: string;
  channel: NotificationOutboxChannel | '';
}

export interface OutboxEmptyCopy {
  title: string;
  description: string;
}

/**
 * What an empty result MEANS.
 *
 * Two different claims, deliberately kept apart:
 *   * with filters: "nothing matches THESE filters" — a fact about the question
 *     that was asked, and the operator is told how to widen it;
 *   * without filters: "this read found no failure rows" — a fact about one
 *     bounded read, explicitly NOT a claim that nothing has ever failed.
 */
export function outboxEmptyCopy(filters: OutboxFilterSummary): OutboxEmptyCopy {
  const narrowed = Boolean(filters.status || filters.eventType || filters.channel);
  if (narrowed) {
    return {
      title: 'No notifications match these filters',
      description:
        'The server returned no failure rows for the selected status, event type and channel. Clear a filter to widen the read.',
    };
  }
  return {
    title: 'No notification failures in this read',
    description:
      'The server returned no notification with a retryable, permanent, unknown or pre-retry failure status. This is a snapshot of the newest records it returns — not proof that nothing has ever failed to send.',
  };
}

/**
 * The notice shown when the response filled the server's fixed window.
 *
 * Silence here would let a 200-row answer read as "this is everything". It
 * cannot be: the contract has no offset, so older failures beyond the cap are
 * simply not reachable from the console.
 */
export function describeServerCapNotice(returned: number, serverLimit: number): string {
  if (returned < serverLimit) return '';
  return `This read returned the server's maximum of ${serverLimit} rows. Older failures beyond that limit are NOT reachable from this console, which offers no further pages: the API has no offset or cursor.`;
}
