import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PackageSearch, RefreshCw } from 'lucide-react';
import Banner from '../../ui/Banner';
import Button from '../../ui/Button';
import EmptyState from '../../ui/EmptyState';
import Modal from '../../ui/Modal';
import SectionHeading from '../../ui/SectionHeading';
import Skeleton from '../../ui/Skeleton';
import Textarea from '../../ui/Textarea';
import { ICON_SIZE } from '../../ui/iconSize';
import StrandedItemsQueueTable from './StrandedItemsQueueTable';
import {
  AdminStrandedItemsApiError,
  fetchStrandedItemsQueue,
  formatStrandedTimestamp,
  releaseStrandedItem,
  type StrandedQueueRead,
  type StrandedQueueViewRow,
} from '../../../services/adminStrandedItemsApi';
import {
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_REASON_MIN_LENGTH,
  validateAdminAssignmentReason,
} from '../../../config/adminAssignmentReasonPolicy';

// =============================================================================
// STAGE 3B-6B - THE STRANDED-ITEM QUEUE PANEL
// =============================================================================
// Suspending a hub, or leaving it email-unverified, stops the platform handing
// it work - but the items ALREADY assigned to it stay assigned, awaiting a
// drop-off that will never be accepted. Until now the only way to find them was
// to open each hub in the Agents Hub and look. This panel asks the server for the
// whole queue at once and offers the one action that changes it.
//
// WHAT THIS PANEL DECIDES, AND WHAT IT ONLY RELAYS
//   * It decides NOTHING about eligibility or custody. GET
//     /api/admin/stranded-items runs the Stage 3B-3 policy and returns
//     `releasable` per row; the table renders `canRelease` from it. There is no
//     status comparison anywhere in this folder.
//   * Its ONE action is POST /api/admin/items/:id/unassign - the primitive that
//     already requires a reason, compare-and-swaps the holder, writes assignment
//     history and appends the audit line. One item per request; there is no bulk
//     control, and none is invented here.
//
// MISSING IS NEVER EMPTY
//   A failed FIRST read shows the error and no "nothing is stranded" claim. A
//   failed LATER read keeps the last rows on screen, labelled as possibly out of
//   date. Rows the client could not parse are counted and stated. A response
//   whose totals disagree with its rows is reported as a disagreement, not
//   smoothed over.
// =============================================================================

const HEADING_ID = 'admin-stranded-items-heading';
const REASON_FIELD_ID = 'admin-stranded-items-reason';

/** Blank-reason copy for THIS flow. The length and personal-data rules are the
 *  shared validator's, so this is wording only - not a second policy. */
const REASON_REQUIRED_COPY = 'A reason is required to return an item to the queue.';

const REASON_HINT =
  `Say why this item is being returned to the queue, at least ${ADMIN_REASON_MIN_LENGTH} characters. Do not include a claimant's or finder's phone number, email address or ID number - the reason is stored permanently.`;

interface StrandedNotice {
  kind: 'success' | 'warning' | 'error';
  message: string;
}

/** One labelled figure. Never renders a bare number without its label. */
function Total({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-panel border border-[var(--appearance-border)] bg-[var(--appearance-surface-muted)] px-3 py-2">
      <dt className="text-caption text-[var(--appearance-text-muted)]">{label}</dt>
      <dd className="text-heading font-extrabold text-[var(--appearance-text-primary)]">{value}</dd>
    </div>
  );
}

export default function StrandedItemsQueueSection({ token }: { token: string | null }) {
  const [data, setData] = useState<StrandedQueueRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [lastReadAt, setLastReadAt] = useState('');
  // Only the newest read may write state.
  const requestIdRef = useRef(0);

  // The release workflow's own state.
  const [inFlightItemId, setInFlightItemId] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<StrandedQueueViewRow | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [notice, setNotice] = useState<StrandedNotice | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    setLoading(true);

    fetchStrandedItemsQueue(token, controller.signal)
      .then((next) => {
        if (requestId !== requestIdRef.current) return;
        setData(next);
        setError(null);
        setLastReadAt(formatStrandedTimestamp(new Date().toISOString()));
      })
      .catch((err: unknown) => {
        if (requestId !== requestIdRef.current) return;
        // A deliberately-cancelled read is not a failure.
        if (err instanceof AdminStrandedItemsApiError && err.isAbort) return;
        setError(err instanceof AdminStrandedItemsApiError
          ? err.message
          : 'The stranded-item queue could not be read.');
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
      });

    return () => controller.abort();
  }, [token, reloadToken]);

  /** The ONE re-read control. It reads; it never sends anything. */
  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  /** A click on "Return to queue" is planned, never acted on directly. */
  const handleRequestRelease = useCallback((row: StrandedQueueViewRow) => {
    if (inFlightItemId !== null) return;
    // The table only offers the control when the server said `releasable`, but
    // the panel repeats the check: it never trusts a callback's caller.
    if (!row.canRelease) {
      setNotice({
        kind: 'error',
        message: 'That item cannot be returned to the queue from here. Nothing was sent.',
      });
      return;
    }
    setNotice(null);
    setReason('');
    setReasonError('');
    setConfirmRow(row);
  }, [inFlightItemId]);

  const cancelRelease = useCallback(() => {
    setConfirmRow(null);
    setReason('');
    setReasonError('');
  }, []);


  /**
   * Perform the confirmed release.
   *
   * The row is marked in flight BEFORE the request, so a second click cannot
   * start a second release while the first is outstanding. The re-read in
   * `finally` is unconditional: an attempted release may have changed the row, or
   * the hub's standing, and the screen must show the server's answer rather than
   * this component's memory of the old row.
   */
  const confirmRelease = useCallback(async () => {
    const row = confirmRow;
    if (!row || !row.itemId) return;
    if (inFlightItemId !== null) return;

    // The shared Stage 3B-3 reason policy, checked here so the operator gets the
    // refusal beside the field instead of after a round-trip. The API client
    // applies the same policy again; nothing is sent until both agree.
    const validated = validateAdminAssignmentReason(reason);
    if (!validated.ok) {
      setReasonError(validated.kind === 'missing' ? REASON_REQUIRED_COPY : validated.error);
      return;
    }

    setInFlightItemId(row.itemId);
    setReasonError('');
    setNotice(null);
    try {
      const result = await releaseStrandedItem(token, row.itemId, validated.reason);
      setConfirmRow(null);
      setReason('');
      setNotice({
        kind: 'success',
        // The server's own sentence when it wrote one, otherwise a statement of
        // exactly what was done - never a claim about custody.
        message: result.message
          || `Item ${row.itemId} was removed from that hub and is back in the assignment queue.`,
      });
    } catch (err: unknown) {
      if (err instanceof AdminStrandedItemsApiError && err.isAbort) return;
      const message = err instanceof AdminStrandedItemsApiError
        ? err.message
        : 'The release could not be sent. Nothing was confirmed as released.';
      // A client-side refusal belongs on the field; a server refusal stays in the
      // dialog so the operator can read it and decide. Neither is ever rendered
      // as success, and the dialog stays open until something succeeded.
      if (err instanceof AdminStrandedItemsApiError && err.kind === 'invalid' && err.status === 0) {
        setReasonError(message);
      } else {
        setNotice({ kind: 'error', message });
      }
    } finally {
      setInFlightItemId(null);
      setReloadToken((n) => n + 1);
    }
  }, [confirmRow, inFlightItemId, reason, token]);


  const rows = data ? data.rows : [];
  const totals = data ? data.totals : null;
  const hasRows = rows.length > 0;
  const unreadableRows = data ? data.unreadableRows : 0;
  const generatedLabel = data ? formatStrandedTimestamp(data.generatedAt) : '';
  // The server said there ARE stranded items but sent nothing this console could
  // read. That is a disagreement, not an empty queue, and it is said so.
  const totalsContradictRows = Boolean(totals && totals.stranded > 0 && !hasRows && unreadableRows === 0);
  const showEmptyCopy = !loading && !error && data !== null && !hasRows && !totalsContradictRows;

  return (
    <section
      id="admin-stranded-items"
      aria-labelledby={HEADING_ID}
      className="bg-[var(--appearance-surface)] border border-[var(--appearance-border)] rounded-panel shadow-raised p-4 sm:p-6 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading
          titleId={HEADING_ID}
          eyebrow={'Operations'}
          title={'Stranded Items'}
          description={'Items still assigned to a hub the platform will not hand work to — suspended, or never able to act. The classification, the custody statement and the releasability verdict are the server’s; this screen performs ONE audited action per item and cannot reassign, transfer custody or act on a batch.'}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={refresh}
          loading={loading}
          loadingLabel={'Reading the stranded-item queue'}
        >
          {!loading && <RefreshCw size={ICON_SIZE.metadata} aria-hidden="true" />}
          {'Refresh'}
        </Button>
      </div>

      <p className="text-caption text-[var(--appearance-text-muted)]" aria-live="polite">
        {loading && !data
          ? 'Reading the stranded-item queue…'
          : lastReadAt
            ? `Last read ${lastReadAt}${generatedLabel ? `; the server classified these items at ${generatedLabel}` : ''}.`
            : 'This queue has not been read yet.'}
      </p>

      {error && (
        <Banner kind={hasRows ? 'warning' : 'error'}>
          {hasRows
            ? `${error} The rows below are from the last successful read and may be out of date, so re-read before releasing anything.`
            : error}
        </Banner>
      )}

      {/* The release result is shown HERE while no dialog is open, and INSIDE the
          dialog while it is - the same sentence is never announced twice. */}
      {notice && confirmRow === null && (
        <Banner
          kind={notice.kind}
          onDismiss={() => setNotice(null)}
          dismissLabel={'Dismiss the release result'}
        >
          {notice.message}
        </Banner>
      )}

      {unreadableRows > 0 && (
        <Banner kind="warning">
          {`${unreadableRows} row${unreadableRows === 1 ? '' : 's'} of this response could not be read and ${unreadableRows === 1 ? 'is' : 'are'} NOT shown below. ${unreadableRows === 1 ? 'It' : 'They'} may include items that need attention, so treat this list as incomplete.`}
        </Banner>
      )}

      {totalsContradictRows && (
        <Banner kind="warning">
          {`The server reported ${totals.stranded} stranded item${totals.stranded === 1 ? '' : 's'} but returned no row this console could read. Nothing below is being called "none" — re-read before concluding anything.`}
        </Banner>
      )}

      {data && data.headline && (
        <p className="text-body text-[var(--appearance-text-primary)]">{data.headline}</p>
      )}

      {totals ? (
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Total label={'Stranded items'} value={totals.stranded} />
          <Total label={'Safe to return now'} value={totals.releasable} />
          <Total label={'Need a custody decision'} value={totals.custodyReviewRequired} />
          <Total label={'Hubs affected'} value={totals.hubs} />
        </dl>
      ) : data ? (
        <Banner kind="info">
          {'The server did not report usable totals with this read, so the figures above are unavailable. The rows below are unaffected and were read in full.'}
        </Banner>
      ) : null}

      {/* LOADING. Skeletons only on the FIRST read - a re-read keeps the last rows
          on screen so the operator never loses their place. */}
      {loading && !data && (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton shape="rect" />
          <Skeleton shape="rect" />
          <Skeleton shape="rect" />
        </div>
      )}

      {/* NOTHING IS CLAIMED WHILE THE FIRST READ IS OUTSTANDING OR FAILED. */}

      {showEmptyCopy && (
        <EmptyState
          icon={PackageSearch}
          title={'No item is stranded at a hub that cannot act'}
          description={'Every item awaiting a hub is assigned to one the platform can still hand work to. This is the server’s classification at the time shown above, not a claim about items it could not read.'}
        />
      )}

      <StrandedItemsQueueTable
        rows={rows}
        inFlightItemId={inFlightItemId}
        onRequestRelease={handleRequestRelease}
      />

      <p className="text-caption text-[var(--appearance-text-muted)] leading-relaxed">
        {'Returning an item removes it from that hub and puts it back in the assignment queue for a hub the platform can hand work to. It does not choose a replacement hub, does not change where the item physically is, and cannot be undone from this screen. Each return is recorded against your account with the reason you give.'}
      </p>

      {/* =====================================================================
          THE ONE CONFIRMATION STEP.
          It names the item and the hub, repeats the custody warning, and asks for
          the reason the audited endpoint requires. It cannot choose a replacement
          hub, cannot move the item physically and cannot release a second item.
          ===================================================================== */}
      <Modal
        open={confirmRow !== null}
        onClose={cancelRelease}
        title={'Return this item to the assignment queue?'}
        closeLabel={'Close the release confirmation'}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={cancelRelease} disabled={inFlightItemId !== null}>
              {'Cancel'}
            </Button>
            <Button
              variant="danger"
              onClick={() => { void confirmRelease(); }}
              loading={inFlightItemId !== null}
              loadingLabel={'Returning the item to the assignment queue'}
            >
              {'Return to queue'}
            </Button>
          </div>
        }
      >
        {confirmRow && (
          <div className="space-y-4">
            <p className="text-body text-[var(--appearance-text-primary)] leading-relaxed">
              {`You are about to take item ${confirmRow.itemId} away from ${confirmRow.agentName} and put it back in the assignment queue, where a hub the platform can act on may be offered it.`}
            </p>

            <dl className="grid gap-2 sm:grid-cols-2 text-caption">
              <div>
                <dt className="text-[var(--appearance-text-muted)]">{'Hub'}</dt>
                <dd className="break-words">{`${confirmRow.agentName} (${confirmRow.agentStanding.label})`}</dd>
              </div>
              <div>
                <dt className="text-[var(--appearance-text-muted)]">{'Item status'}</dt>
                <dd>{confirmRow.statusLabel}</dd>
              </div>
              <div>
                <dt className="text-[var(--appearance-text-muted)]">{'Custody'}</dt>
                <dd>{confirmRow.custody.label}</dd>
              </div>
              <div>
                <dt className="text-[var(--appearance-text-muted)]">{'Assigned'}</dt>
                <dd>{`${confirmRow.assignedAtLabel || 'Time not recorded'} · ${confirmRow.ageLabel}`}</dd>
              </div>
            </dl>

            {confirmRow.custody.state === 'received_at_hub' ? (
              <Banner kind="warning">
                {`The server records this item as physically at the hub. ${confirmRow.custody.note} Returning it to the queue does not move it, does not release it to a claimant and does not record a handover — arrange the physical handover separately.`}
              </Banner>
            ) : confirmRow.custody.state === 'not_yet_received' ? (
              <Banner kind="info">
                {`${confirmRow.custody.note} Nothing physical has to move, so this only corrects the assignment.`}
              </Banner>
            ) : (
              <Banner kind="warning">
                {'The server did not state where this item physically is. Confirm the custody position before returning it — this action changes the assignment, not the item.'}
              </Banner>
            )}

            {notice && (
              <Banner kind={notice.kind} onDismiss={() => setNotice(null)} dismissLabel={'Dismiss the release result'}>
                {notice.message}
              </Banner>
            )}

            <Textarea
              id={REASON_FIELD_ID}
              label={'Why is this item being returned to the queue?'}
              hint={REASON_HINT}
              error={reasonError || undefined}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                if (reasonError) setReasonError('');
              }}
              rows={4}
              maxLength={ADMIN_REASON_MAX_LENGTH}
              disabled={inFlightItemId !== null}
            />

            <p className="text-caption text-[var(--appearance-text-muted)] leading-relaxed">
              {'This dialog describes the row as it was when you opened it. The queue is re-read after every attempt, so if anything changed you will see it behind this dialog — close it and check before trying again.'}
            </p>
          </div>
        )}
      </Modal>
    </section>
  );
}
