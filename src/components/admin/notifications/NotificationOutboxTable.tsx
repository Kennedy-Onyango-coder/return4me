import React from 'react';
import Badge, { type BadgeVariant } from '../../ui/Badge';
import Button from '../../ui/Button';
import type { AdminNotificationRow } from '../../../services/adminNotificationsApi';
import {
  NOT_RECORDED_TEXT,
  describeAttempts,
  describeNotificationChannel,
  describeNotificationEventType,
  describeNotificationProvider,
  describeNotificationStatus,
  describeRetryClass,
  retryEligibility,
  type NotificationStatusTone,
} from './notificationOutboxPresentation';

// =============================================================================
// ADMIN NOTIFICATION OUTBOX — THE ROW TABLE
// =============================================================================
// A presentational table. It reads no data, fetches nothing and decides nothing
// about WHO may retry: the panel owns the request, the confirmation dialog and
// the duplicate-submission guard, and passes `onRequestRetry` in.
//
// WHAT IS RENDERED, AND WHAT IS NOT
//   * `recipientReference` is the server's MASKED reference and is printed
//     verbatim. This component has no access to a phone number, an email address,
//     an OTP, a pickup code or a message body — the row type it receives has no
//     field for any of them (see services/adminNotificationsApi.ts).
//   * A missing value is printed as "Not recorded", never as an empty cell and
//     never as zero.
//   * Status is a Badge whose TEXT carries the meaning; colour only reinforces
//     it, so the row is readable in greyscale and by a screen reader.
//   * Retry is offered ONLY where the server's own flags say the route would
//     accept it. Every other row states why it cannot be retried, in place of a
//     disabled-looking control that would explain nothing.
// =============================================================================

const toneToVariant: Record<NotificationStatusTone, BadgeVariant> = {
  warning: 'warning',
  danger: 'danger',
  pending: 'pending',
  neutral: 'neutral',
};

export interface NotificationOutboxTableProps {
  rows: AdminNotificationRow[];
  /** The row currently being retried, or null when nothing is in flight. */
  inFlightId: string | null;
  onRequestRetry: (row: AdminNotificationRow) => void;
}

/** The visible text for a missing timestamp, so a blank cell never appears. */
function recordedLabel(value: string): string {
  return value && value.trim() ? value : NOT_RECORDED_TEXT;
}

const HEAD_CELL =
  'px-3 py-2 text-caption font-extrabold uppercase tracking-widest text-[var(--appearance-text-muted)]';

export default function NotificationOutboxTable({
  rows,
  inFlightId,
  onRequestRetry,
}: NotificationOutboxTableProps) {
  if (rows.length === 0) return null;

  return (
    <div
      className="r4m-scroll-x rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface)]"
      role="region"
      aria-label="Notification delivery failures"
      tabIndex={0}
    >
      <table className="w-full min-w-[56rem] border-collapse text-left">
        <caption className="sr-only">
          {'Notification delivery failures. Each row shows the event type, channel, delivery status, the masked recipient reference, the recorded error, the attempt history and whether the server can re-send it.'}
        </caption>
        <thead>
          <tr className="border-b border-[var(--appearance-border)]">
            <th scope="col" className={HEAD_CELL}>Recorded</th>
            <th scope="col" className={HEAD_CELL}>Notification</th>
            <th scope="col" className={HEAD_CELL}>Status</th>
            <th scope="col" className={HEAD_CELL}>Recipient (masked)</th>
            <th scope="col" className={HEAD_CELL}>Recorded error</th>
            <th scope="col" className={HEAD_CELL}>Attempts</th>
            <th scope="col" className={HEAD_CELL}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const status = describeNotificationStatus(row.status);
            const eligibility = retryEligibility(row);
            const busy = inFlightId === row.id;
            const rowKey = row.id ?? `row-${index}`;
            return (
              <tr
                key={rowKey}
                className="border-b border-[var(--appearance-border)] last:border-b-0 align-top"
              >
                <td className="px-3 py-3 text-caption text-[var(--appearance-text-primary)] whitespace-nowrap">
                  <span className="block font-bold">{recordedLabel(row.createdAtLabel)}</span>
                  <span className="block text-[var(--appearance-text-muted)]">{`${row.ageLabel} ago`}</span>
                </td>
                <td className="px-3 py-3 text-caption text-[var(--appearance-text-primary)]">
                  <span className="block font-mono font-bold break-all">
                    {describeNotificationEventType(row.eventType)}
                  </span>
                  <span className="block text-[var(--appearance-text-muted)]">
                    {`${describeNotificationChannel(row.channel)} · ${describeNotificationProvider(row.provider)}`}
                  </span>
                  <span className="block text-[var(--appearance-text-muted)]">
                    {describeRetryClass(row.retryClass)}
                  </span>
                  {row.businessReference && (
                    <span className="mt-1 inline-block">
                      <Badge variant="code">{row.businessReference}</Badge>
                    </span>
                  )}
                </td>
                <td className="px-3 py-3 text-caption text-[var(--appearance-text-primary)]">
                  <Badge variant={toneToVariant[status.tone]}>{status.label}</Badge>
                  <span className="mt-1 block max-w-[16rem] leading-relaxed text-[var(--appearance-text-muted)]">
                    {status.meaning}
                  </span>
                </td>
                <td className="px-3 py-3 text-caption text-[var(--appearance-text-primary)]">
                  {row.recipientReference ? (
                    <Badge variant="code">{row.recipientReference}</Badge>
                  ) : (
                    <span className="text-[var(--appearance-text-muted)]">{NOT_RECORDED_TEXT}</span>
                  )}
                </td>
                <td className="px-3 py-3 text-caption text-[var(--appearance-text-primary)]">
                  <span className="block max-w-[20rem] break-words">
                    {row.lastError ?? (
                      <span className="text-[var(--appearance-text-muted)]">
                        {'No error text was recorded.'}
                      </span>
                    )}
                  </span>
                  {row.nextAttemptAtLabel && (
                    <span className="mt-1 block text-[var(--appearance-text-muted)]">
                      {`Next automatic attempt ${row.nextAttemptAtLabel}`}
                    </span>
                  )}
                </td>
                <td className="px-3 py-3 text-caption text-[var(--appearance-text-primary)] whitespace-nowrap">
                  {describeAttempts(row)}
                </td>
                <td className="px-3 py-3 text-caption text-[var(--appearance-text-primary)]">
                  {eligibility.allowed ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onRequestRetry(row)}
                      disabled={inFlightId !== null}
                      loading={busy}
                      loadingLabel={'Retrying this notification'}
                      aria-label={`Retry ${describeNotificationEventType(row.eventType)} notification`}
                    >
                      {'Retry'}
                    </Button>
                  ) : (
                    <span className="block max-w-[16rem] leading-relaxed text-[var(--appearance-text-muted)]">
                      {eligibility.reason}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
