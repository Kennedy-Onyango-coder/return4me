import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, BellOff, Send } from 'lucide-react';
import Banner from '../../ui/Banner';
import Button from '../../ui/Button';
import EmptyState from '../../ui/EmptyState';
import Modal from '../../ui/Modal';
import SectionHeading from '../../ui/SectionHeading';
import Select from '../../ui/Select';
import Skeleton from '../../ui/Skeleton';
import { ICON_SIZE } from '../../ui/iconSize';
import NotificationOutboxTable from './NotificationOutboxTable';
import {
  describeRetryOutcome,
  describeServerCapNotice,
  outboxEmptyCopy,
  paginateOutbox,
  planRetryClick,
} from './notificationOutboxPresentation';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_OPERATOR_STATUSES,
  NOTIFICATION_OUTBOX_DEFAULT_PAGE_SIZE,
  NOTIFICATION_OUTBOX_PAGE_SIZE_OPTIONS,
  NOTIFICATION_OUTBOX_SERVER_LIMIT,
  type NotificationOperatorStatus,
  type NotificationOutboxChannel,
} from '../../../config/notificationOutbox';
import { NOTIFICATION_EVENT_TYPES } from '../../../config/notificationEvents';
import {
  AdminNotificationsApiError,
  fetchAdminNotifications,
  formatRecordedAt,
  retryAdminNotification,
  type AdminNotificationRow,
  type AdminNotificationsWindow,
} from '../../../services/adminNotificationsApi';

// =============================================================================
// N9 — SECTION: NOTIFICATION OUTBOX (ADMIN CONSOLE)
// =============================================================================
// The one place the console reads GET /api/admin/notifications and drives
// POST /api/admin/notifications/:id/retry.
//
// WHAT THE SERVER OFFERS, AND NOTHING MORE
//   * one bounded read of at most 200 failure rows (retryable_failure,
//     permanent_failure, unknown, legacy 'failed'), newest first;
//   * filters: status, eventType, channel — all validated server-side;
//   * a retry for ONE row, which the server re-checks and performs through its
//     own authorized workflow.
//   There is no offset, no cursor and no total count in that contract, so this
//   panel does NOT pretend to page the database: it pages the rows it actually
//   received, says how many that is, and states when the response filled the
//   server's window (older failures beyond it are unreachable from the console).
//
// WHOSE DECISION EACH THING IS
//   * Retryability: the SERVER's (`retryable` flag + stored status). The console
//     mirrors the route's preconditions only so it never offers a control the
//     server would refuse; the server enforces all of them again.
//   * Eligibility is never inferred from the event-type vocabulary alone, and a
//     row this console cannot read is treated as needing review, not as retryable.
//
// THE RETRY IS A REAL OPERATION, SO IT IS GUARDED
//   * a confirmation dialog states exactly what will happen and to which masked
//     reference — the operator never retries a row they cannot identify;
//   * while a retry is in flight every retry control is disabled and the click
//     planner ignores further clicks: the endpoint has no idempotency key, so two
//     clicks must never become two sends;
//   * a 409 is shown as a REFUSAL with the server's own reason category, never as
//     success, and a 404 removes the row on the re-read that always follows;
//   * after every attempt the window is re-read, so the status, attempt counts and
//     eligibility on screen are the server's, not a local guess.
//
// REQUEST DISCIPLINE (the same rules as AuditLogPanel / PayoutReconciliationPanel)
//   * one request per (mount, filter change, Refresh, page size) — no polling;
//   * an AbortController AND a sequence guard, so a slow superseded read cannot
//     overwrite a newer one and leaving the tab cancels the read;
//   * an aborted read is silent — it is not an error and is never shown as one;
//   * nothing is logged.
//
// MISSING NEVER MEANS EMPTY
//   A failed read keeps the last successfully-read window on screen and says it
//   may be out of date. A FIRST read that failed shows the error and no empty
//   statement, because "no notification failures" would be a claim this console
//   did not earn.
// =============================================================================

/** The panel's DOM id, so the console's nav can point at it. */
export const NOTIFICATION_OUTBOX_PANEL_ID = 'notification-outbox-panel';

const HEADING_ID = 'notification-outbox-heading';
const STATUS_SELECT_ID = 'notification-outbox-status';
const EVENT_SELECT_ID = 'notification-outbox-event-type';
const CHANNEL_SELECT_ID = 'notification-outbox-channel';
const PAGE_SIZE_SELECT_ID = 'notification-outbox-page-size';

interface RetryNotice {
  kind: 'success' | 'warning' | 'error';
  message: string;
}

export default function NotificationOutboxPanel({ token }: { token: string | null }) {
  // Filters apply on change: every control is a closed <select>, so there is no
  // half-typed value that could be mistaken for "no results".
  const [status, setStatusFilter] = useState<NotificationOperatorStatus | ''>('');
  const [eventType, setEventTypeFilter] = useState('');
  const [channel, setChannelFilter] = useState<NotificationOutboxChannel | ''>('');

  const [pageSize, setPageSize] = useState<number>(NOTIFICATION_OUTBOX_DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);

  const [windowData, setWindowData] = useState<AdminNotificationsWindow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [lastReadAt, setLastReadAt] = useState('');
  // Only the newest read may write state.
  const requestIdRef = useRef(0);

  // The retry workflow's own state.
  const [inFlightId, setInFlightId] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<AdminNotificationRow | null>(null);
  const [retryNotice, setRetryNotice] = useState<RetryNotice | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    setLoading(true);

    fetchAdminNotifications(token, { status, eventType, channel }, controller.signal)
      .then((next) => {
        if (requestId !== requestIdRef.current) return;
        setWindowData(next);
        setError(null);
        setLastReadAt(formatRecordedAt(new Date().toISOString()));
      })
      .catch((err: unknown) => {
        if (requestId !== requestIdRef.current) return;
        // A deliberately-cancelled read is not a failure.
        if (err instanceof AdminNotificationsApiError && err.isAbort) return;
        setError(err instanceof AdminNotificationsApiError
          ? err.message
          : 'The notification outbox could not be read.');
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
      });

    return () => controller.abort();
  }, [token, status, eventType, channel, reloadToken]);

  /** The ONE re-read control. It reads; it never sends anything. */
  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  // Every filter change is a new question, so the page resets to the first one.
  const changeStatus = useCallback((next: string) => {
    setStatusFilter(next as NotificationOperatorStatus | '');
    setPage(1);
  }, []);
  const changeEventType = useCallback((next: string) => {
    setEventTypeFilter(next);
    setPage(1);
  }, []);
  const changeChannel = useCallback((next: string) => {
    setChannelFilter(next as NotificationOutboxChannel | '');
    setPage(1);
  }, []);
  const clearFilters = useCallback(() => {
    setStatusFilter('');
    setEventTypeFilter('');
    setChannelFilter('');
    setPage(1);
    // Clearing is still an explicit "read it again": never silently a no-op.
    setReloadToken((n) => n + 1);
  }, []);

  /** A click on Retry is planned, never acted on directly. */
  const handleRequestRetry = useCallback((row: AdminNotificationRow) => {
    const plan = planRetryClick({
      row,
      inFlightId,
      confirmingId: confirmRow ? confirmRow.id : null,
    });
    if (plan.action === 'ignored') return;
    if (plan.action === 'refused') {
      setRetryNotice({ kind: 'error', message: plan.reason });
      return;
    }
    setRetryNotice(null);
    setConfirmRow(row);
  }, [inFlightId, confirmRow]);

  const cancelRetry = useCallback(() => setConfirmRow(null), []);

  /**
   * Perform the confirmed retry.
   *
   * The dialog closes FIRST and the row is marked in flight, so a second click
   * cannot start a second send while the first is outstanding. The read that
   * follows is unconditional: an attempted retry may have changed the attempt
   * counts, the next-attempt time or the status, and the screen must show the
   * server's answer rather than this component's memory of the old row.
   */
  const confirmRetry = useCallback(async () => {
    const row = confirmRow;
    setConfirmRow(null);
    if (!row || !row.id) return;
    if (inFlightId !== null) return;

    setInFlightId(row.id);
    setRetryNotice(null);
    try {
      const result = await retryAdminNotification(token, row.id);
      const sentence = describeRetryOutcome(result.outcome);
      const succeeded = result.retried && result.outcome === 'sent';
      setRetryNotice({ kind: succeeded ? 'success' : 'warning', message: sentence });
    } catch (err: unknown) {
      if (err instanceof AdminNotificationsApiError && err.isAbort) return;
      setRetryNotice({
        kind: 'error',
        message: err instanceof AdminNotificationsApiError
          ? err.message
          : 'The retry could not be sent. Nothing was confirmed as re-sent.',
      });
    } finally {
      setInFlightId(null);
      setReloadToken((n) => n + 1);
    }
  }, [confirmRow, inFlightId, token]);

  const rows = useMemo(() => windowData?.rows ?? [], [windowData]);
  const pageData = useMemo(() => paginateOutbox(rows, page, pageSize), [rows, page, pageSize]);
  const hasRows = rows.length > 0;
  const emptyCopy = !loading && !error && windowData !== null && !hasRows
    ? outboxEmptyCopy({ status, eventType, channel })
    : null;
  const capNotice = windowData
    ? describeServerCapNotice(windowData.returned, NOTIFICATION_OUTBOX_SERVER_LIMIT)
    : '';
  const filtersNarrowed = Boolean(status || eventType || channel);

  return (
    <section
      id={NOTIFICATION_OUTBOX_PANEL_ID}
      aria-labelledby={HEADING_ID}
      className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel shadow-raised p-4 sm:p-6 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading
          titleId={HEADING_ID}
          eyebrow={'Operations'}
          title={'Notification outbox'}
          description={'Failed, undelivered and unknown-outcome notifications, with their recorded error and attempt history. Retry re-sends ONE message through the server’s own authorized workflow; it never replays the payment, handover or claim action that produced it.'}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={refresh}
          loading={loading}
          loadingLabel={'Reading the notification outbox'}
        >
          {!loading && <RefreshCw size={ICON_SIZE.metadata} aria-hidden="true" />}
          {'Refresh'}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          id={STATUS_SELECT_ID}
          label={'Status'}
          value={status}
          onChange={(event) => changeStatus(event.target.value)}
        >
          <option value="">{'All failure statuses'}</option>
          {NOTIFICATION_OPERATOR_STATUSES.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </Select>

        <Select
          id={EVENT_SELECT_ID}
          label={'Event type'}
          value={eventType}
          onChange={(event) => changeEventType(event.target.value)}
        >
          <option value="">{'Any event type'}</option>
          {NOTIFICATION_EVENT_TYPES.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </Select>

        <Select
          id={CHANNEL_SELECT_ID}
          label={'Channel'}
          value={channel}
          onChange={(event) => changeChannel(event.target.value)}
        >
          <option value="">{'Both channels'}</option>
          {NOTIFICATION_CHANNELS.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </Select>

        <Select
          id={PAGE_SIZE_SELECT_ID}
          label={'Rows per page'}
          hint={'This pages the rows this read returned, not the database.'}
          value={String(pageSize)}
          onChange={(event) => {
            setPageSize(Number(event.target.value));
            setPage(1);
          }}
        >
          {NOTIFICATION_OUTBOX_PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={String(size)}>{`${size} rows`}</option>
          ))}
        </Select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={clearFilters}
          disabled={!filtersNarrowed || loading}
        >
          {'Clear filters'}
        </Button>
        <p className="text-caption text-[var(--appearance-text-muted)]" aria-live="polite">
          {loading
            ? 'Reading the notification outbox…'
            : lastReadAt
              ? `Last read ${lastReadAt}.`
              : 'This window has not been read yet.'}
        </p>
      </div>

      {error && (
        <Banner kind={hasRows ? 'warning' : 'error'}>
          {hasRows
            ? `${error} The rows below are from the last successful read and may be out of date.`
            : error}
        </Banner>
      )}

      {retryNotice && (
        <Banner
          kind={retryNotice.kind}
          onDismiss={() => setRetryNotice(null)}
          dismissLabel={'Dismiss the retry result'}
        >
          {retryNotice.message}
        </Banner>
      )}

      {capNotice && <Banner kind="warning">{capNotice}</Banner>}

      {loading && windowData === null ? (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only">{'Loading the notification outbox…'}</span>
          <Skeleton shape="card" className="w-full" />
          <Skeleton shape="card" className="w-full" />
        </div>
      ) : windowData ? (
        <>
          <NotificationOutboxTable
            rows={pageData.rows}
            inFlightId={inFlightId}
            onRequestRetry={handleRequestRetry}
          />

          {emptyCopy && (
            <EmptyState icon={BellOff} title={emptyCopy.title} description={emptyCopy.description} />
          )}

          {hasRows && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--appearance-border)] pt-3">
              <p className="text-caption text-[var(--appearance-text-muted)]">
                {`Rows ${pageData.firstIndex ?? 0}–${pageData.lastIndex ?? 0} of the ${windowData.returned} the server returned (page ${pageData.page} of ${pageData.pageCount}).`}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={pageData.page <= 1 || loading}
                  aria-label={'Previous page of notification failures'}
                >
                  {'Previous'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage((current) => Math.min(pageData.pageCount, current + 1))}
                  disabled={pageData.page >= pageData.pageCount || loading}
                  aria-label={'Next page of notification failures'}
                >
                  {'Next'}
                </Button>
              </div>
            </div>
          )}
        </>
      ) : null}

      {/* The confirmation step. The shared Modal owns the dialog semantics, the
          focus trap, Escape and focus restoration; this panel owns only what the
          operator is agreeing to. */}
      <Modal
        open={confirmRow !== null}
        onClose={cancelRetry}
        title={'Re-send this notification?'}
        closeLabel={'Close the retry confirmation'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={cancelRetry}>
              {'Cancel'}
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={() => { void confirmRetry(); }}
              loading={confirmRow !== null && inFlightId === confirmRow.id}
              loadingLabel={'Sending the retry'}
            >
              {'Confirm retry'}
            </Button>
          </div>
        }
      >
        {confirmRow && (
          <div className="space-y-3">
            <p>
              {'The server will rebuild this message from the stored record and send it again through the delivery provider. The payment, handover or claim action that originally produced it is NOT replayed — only the message is re-sent.'}
            </p>
            <dl className="grid gap-1 text-caption">
              <div className="flex flex-wrap gap-x-2">
                <dt className="font-bold">{'Event:'}</dt>
                <dd className="font-mono break-all">{confirmRow.eventType ?? 'Not recorded'}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="font-bold">{'Channel:'}</dt>
                <dd>{confirmRow.channel ?? 'Not recorded'}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="font-bold">{'Recipient (masked):'}</dt>
                <dd className="font-mono">{confirmRow.recipientReference ?? 'Not recorded'}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="font-bold">{'Recorded at:'}</dt>
                <dd>{confirmRow.createdAtLabel || 'Not recorded'}</dd>
              </div>
            </dl>
            <p className="flex items-start gap-2 text-caption text-[var(--appearance-text-muted)]">
              <Send size={ICON_SIZE.metadata} aria-hidden="true" className="mt-0.5 shrink-0" />
              {'The attempt is recorded against your administrator session, and the row is re-read afterwards so its status and attempt counts are the server’s.'}
            </p>
          </div>
        )}
      </Modal>
    </section>
  );
}
